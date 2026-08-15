// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Monad Place — 千人链上像素战争
/// @notice 一块 64x36 的共享画布：每次落子 = 1 笔 Monad 交易；
///         冷却与阵营规则由合约强制，终局 seal() 生成整幅画的链上指纹。
/// @dev 状态用最朴素的 mapping，评审可直接读懂。
contract PlaceCanvas {
    uint256 public constant WIDTH = 64;
    uint256 public constant HEIGHT = 36;
    uint256 public constant PALETTE = 16;   // 颜色编号 1..16，0 = 空白
    uint256 public constant TEAM_SPLIT = 8; // 1..8 = 紫晶军团(冷色)，9..16 = 黄金部落(暖色)

    uint256 public immutable startAt;
    uint256 public endAt; // seal 后冻结
    bool public isSealed;
    address public immutable owner; // 主持人（部署者）：唯一有权调用 seal()
    uint256 public cooldownSeconds = 3;
    uint256 public totalPlaced;
    uint256 public uniquePlayers;

    // idx = y * WIDTH + x
    mapping(uint256 => uint8) public pixels;
    mapping(address => uint256) public lastPlacedAt;
    mapping(address => uint256) public placedCount; // 个人排行榜数据源
    mapping(uint8 => uint256) public teamPixels;    // 1=紫晶 2=黄金
    mapping(address => bool) private known;

    event PixelPlaced(address indexed user, uint256 indexed idx, uint8 color, uint8 team, uint256 placedAt);
    event CanvasSealed(bytes32 canvasHash, uint256 totalPlaced, uint256 uniquePlayers, uint256 sealedAt);

    error NotLive();
    error BadColor();
    error Cooldown();
    error SameColor();

    constructor(uint256 liveSeconds_) {
        owner = msg.sender; // 部署者即主持人，防止观众提前 seal 冻结全场
        startAt = block.timestamp;
        endAt = startAt + liveSeconds_;
    }

    /// @notice 落子：每笔交易涂一格
    function place(uint16 x, uint16 y, uint8 color) external {
        if (isSealed || block.timestamp > endAt) revert NotLive();
        if (color == 0 || color > PALETTE) revert BadColor();
        if (block.timestamp - lastPlacedAt[msg.sender] < cooldownSeconds) revert Cooldown();
        if (x >= WIDTH || y >= HEIGHT) revert BadColor();

        uint256 idx = uint256(y) * WIDTH + uint256(x);
        if (pixels[idx] == color) revert SameColor();

        if (!known[msg.sender]) {
            known[msg.sender] = true;
            uniquePlayers++;
        }

        uint8 prev = pixels[idx];
        if (prev != 0) teamPixels[teamOf(prev)]--; // 覆盖敌格子：敌方计数-1
        pixels[idx] = color;
        teamPixels[teamOf(color)]++;

        lastPlacedAt[msg.sender] = block.timestamp;
        placedCount[msg.sender]++;
        totalPlaced++;

        emit PixelPlaced(msg.sender, idx, color, teamOf(color), block.timestamp);
    }

    /// @notice 主持人终局：冻结画布并生成链上指纹（仅部署者可调用）
    function seal() external {
        require(msg.sender == owner, "not host");
        if (isSealed) revert NotLive();
        isSealed = true;
        endAt = block.timestamp;
        emit CanvasSealed(canvasHash(), totalPlaced, uniquePlayers, block.timestamp);
    }

    function teamOf(uint8 color) public pure returns (uint8) {
        return color <= TEAM_SPLIT ? uint8(1) : uint8(2);
    }

    /// @notice 整幅画的 keccak256 指纹（demo 终局展示用）
    function canvasHash() public view returns (bytes32) {
        bytes memory buf = new bytes(WIDTH * HEIGHT);
        for (uint256 i = 0; i < WIDTH * HEIGHT; i++) {
            buf[i] = bytes1(pixels[i]);
        }
        return keccak256(buf);
    }

    /// @notice 大屏冷启动拉全量：按行取 64 格
    function getRow(uint8 y) external view returns (uint8[64] memory row) {
        for (uint256 x = 0; x < WIDTH; x++) {
            row[x] = pixels[uint256(y) * WIDTH + x];
        }
    }
}
