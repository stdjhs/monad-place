// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {PlaceCanvas} from "./PlaceCanvas.sol";

/// @title PlaceCanvasNFT — 终局纪念章（ERC-1155 + ERC-2981）
/// @notice 画布 seal() 封盘后，落过子的玩家（placedCount > 0）可免费铸造一枚纪念章；
///         全场共用同一个 tokenId = 首次铸造时的块高（≈ seal 块高，天然唯一且免预言机）。
/// @dev 铸造资格完全依赖 PlaceCanvas 的链上状态，本合约不维护玩家名单。
contract PlaceCanvasNFT is ERC1155, ERC2981, Ownable {
    // 单场铸造上限（测试网演示参数）
    uint256 public constant MAX_SUPPLY = 300;

    // 铸造资格来源：落过子的地址 placedCount > 0
    PlaceCanvas public immutable canvas;

    // metadata 基址，owner 可通过 setBaseURI 更新
    string private baseURI;

    // 首次铸造时锁定，作为全场唯一 tokenId（≈ seal 块高）
    uint256 public sealBlock;

    uint256 public mintedCount;
    mapping(address => bool) public hasMinted;

    event Minted(address indexed user, uint256 indexed tokenId);

    error NotSealed();
    error NotPlayer();
    error AlreadyMinted();
    error SoldOut();

    constructor(address canvas_, string memory baseURI_)
        ERC1155("") // 单 tokenId 场景直接 override uri()，此处基址仅占位
        Ownable(msg.sender) // OZ5 必须显式传入 initialOwner；部署者即 NFT 管理员
    {
        canvas = PlaceCanvas(canvas_);
        baseURI = baseURI_;
        _setDefaultRoyalty(msg.sender, 500); // 版税 5%（500/10000），收款人 = 部署者
    }

    /// @notice 封盘后由参与者免费铸造纪念章（一人一枚）
    function mint() external {
        if (!canvas.isSealed()) revert NotSealed();
        if (canvas.placedCount(msg.sender) == 0) revert NotPlayer();
        if (hasMinted[msg.sender]) revert AlreadyMinted();
        if (mintedCount >= MAX_SUPPLY) revert SoldOut();

        // 首次铸造锁定 tokenId：取当前块高（≈ seal 块高），全场共用
        if (sealBlock == 0) sealBlock = block.number;

        hasMinted[msg.sender] = true;
        mintedCount++;
        _mint(msg.sender, sealBlock, 1, "");
        emit Minted(msg.sender, sealBlock);
    }

    /// @notice metadata 地址拼接：baseURI + "/" + tokenId + ".json"
    function uri(uint256 tokenId) public view override returns (string memory) {
        return string.concat(baseURI, "/", Strings.toString(tokenId), ".json");
    }

    /// @notice 更新 metadata 基址（仅 owner）
    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        baseURI = newBaseURI;
    }

    /// @inheritdoc ERC1155
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
