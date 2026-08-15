# Monad Place — 千人链上像素战争 🟣🟡

> 链上的 r/place：一块 64×36 的共享画布，全场观众扫码参战，**每个像素 = 1 笔真实的 Monad 交易**。
> Monad Blitz@北京V2 参赛项目（Scaffold-ETH 2 · Hardhat）

## 这是什么

一块部署在 Monad 测试网上的共享像素画布。现场观众手机扫码 → 连接钱包 → 选择阵营（紫晶军团 ❄ / 黄金部落 🔥）→ 点击画布落子。每次落子都是一笔真实的链上交易；3 秒冷却由**智能合约强制**（链上规则，不是服务器）。投影大屏实时渲染画布翻涌、五声音阶音雨、TPS 仪表与阵营比分。终局主持人调用 `seal()` 冻结画布，整幅作品的 keccak256 指纹永久上链。

## 为什么只有 Monad 行

千人并发落子 = 每秒数百笔真实交易。大屏 TPS 仪表把并行 EVM 的吞吐变成**比分牌**——人越多，链上体验越好。规模本身就是产品。

## 商业模式

面向线下活动与品牌方的**付费定制画布战役**（按场次收费）+ 终局画布 NFT 铸造分成。主办方买的是"全场参与"的引爆点，玩家带走链上纪念品。

## 差异化声明

与现有生态项目零重叠：协作画布/共享像素类命中数为 0。本项目为"百人并发交易→共享画布实时对抗"的竞技型现场体验，合约核心仅网格状态与事件，独立完整。落子音符采用五声音阶（宫商角徵羽），并发交易天然合成"链上音雨"。

## 页面

| 路由 | 用途 |
| --- | --- |
| `/` | 落地页（价值主张 + 规则 + 商业模式） |
| `/play` | 观众端：连钱包 → 选阵营 → 点画布落子（手机友好） |
| `/stage` | 大屏端：画布 + 涟漪 + 音效 + TPS + 比分 + 排行榜 + 二维码 + 封盘横幅（投影用，无需钱包） |
| `/debug` | Scaffold-ETH 合约调试 UI |

## 开发

```bash
yarn install
yarn chain          # 终端1：本地区块链
yarn deploy         # 终端2：部署合约（本地）
yarn start          # 终端3：前端 http://localhost:3000
yarn test           # 合约测试（含 seal 权限/冷却/同色拒绝/阵营计数转移）
```

## 部署到 Monad 测试网（ChainID 10143）

```bash
yarn generate                          # 生成部署账户（记住密码）
# 到 https://testnet.monad.xyz 领取测试币
yarn deploy --network monadTestnet     # 部署（构造参数 liveSeconds=28800）
yarn verify --network monadTestnet     # Sourcify 验证（BlockVision）
yarn vercel:yolo --prod                # 前端公网部署
```

> 注：verify 命令报错常为误导（官方文档说明），请到浏览器确认验证状态。

## 合约速览（PlaceCanvas.sol）

- `place(x, y, color)` — 落子；校验存活/颜色/坐标/冷却/同色，覆盖敌格自动转移阵营计数
- `seal()` — 仅主持人（部署者）可调用，冻结画布并生成 keccak256 指纹
- `canvasHash()` / `getRow(y)` — 终局指纹与大屏冷启动
- 事件：`PixelPlaced` / `CanvasSealed`
