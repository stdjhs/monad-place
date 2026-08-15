// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PlaceCanvas} from "./PlaceCanvas.sol";

/// @title CampaignFactory — 场次工厂（商业化 L1：场次费）
/// @notice 赞助商支付固定场次费即可发起一场新的像素战争；
///         收入累积在合约内，由 owner（平台方）统一提取。
/// @dev 设计取舍：new PlaceCanvas() 会使新画布的 owner（主持人/seal 权限）
///      落在工厂合约地址上。本期不做 seal 转发（工厂不暴露 seal 代理函数），
///      以保持最小审计面；后续如需人工封盘可再增加受控代理函数。
contract CampaignFactory is Ownable {
    // 每场次固定费用 0.1 MON（演示定价）
    uint256 public constant FEE = 0.1 ether;

    // 单场画布最长存活时间
    uint256 public constant MAX_LIVE_SECONDS = 24 hours;

    struct Campaign {
        address sponsor; // 发起方（付费地址）
        string title; // 场次标题
        string team1Name; // 阵营一名称（紫晶）
        string team2Name; // 阵营二名称（黄金）
        uint256 endsAt; // 画布自然结束时间（= canvas.endAt()）
    }

    Campaign[] public campaigns;
    mapping(uint256 => address) public canvasOf; // 场次 id → 画布地址

    event CampaignCreated(uint256 indexed id, address indexed sponsor, address canvas, string title);

    error InsufficientFee();
    error BadLiveSeconds();
    error WithdrawFailed();

    constructor() Ownable(msg.sender) {}

    /// @notice 支付场次费创建一场像素战争，返回场次 id
    /// @dev 多付的款项不退款，留在合约内随提款一并归集（演示期简化处理）。
    function createCampaign(
        string calldata title,
        string calldata team1Name,
        string calldata team2Name,
        uint256 liveSeconds
    ) external payable returns (uint256 id) {
        if (msg.value < FEE) revert InsufficientFee();
        if (liveSeconds == 0 || liveSeconds > MAX_LIVE_SECONDS) revert BadLiveSeconds();

        PlaceCanvas canvas = new PlaceCanvas(liveSeconds);

        id = campaigns.length;
        campaigns.push(Campaign(msg.sender, title, team1Name, team2Name, canvas.endAt()));
        canvasOf[id] = address(canvas);

        emit CampaignCreated(id, msg.sender, address(canvas), title);
    }

    /// @notice 平台方提取全部累积场次费（仅 owner）
    function withdraw() external onlyOwner {
        (bool ok, ) = owner().call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }
}
