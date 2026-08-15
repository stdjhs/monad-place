import { deployScript, artifacts } from "../rocketh/deploy.js";

/**
 * 部署 A1 商业化合约：CampaignFactory（场次费工厂 L1） + PlaceCanvasNFT（终局纪念章 L2）
 *
 * CampaignFactory 无构造参数；PlaceCanvasNFT 需要已部署的 PlaceCanvas 地址作为
 * 铸造资格来源，并接收 metadata 基址（NFT_BASE_URI 环境变量，缺省为演示地址）。
 */
export default deployScript(
  async env => {
    const { deployer } = env.namedAccounts;

    // 安全门禁（与 00_deploy_place_canvas 保持一致）：hardhat.config 在未设置部署密钥时
    // 会兜底用众所周知的 Hardhat #0 私钥。用它部署到测试网/主网 = owner 私钥公开
    // = 任何人可调用 withdraw() 提走全部场次费。本地网络放行；其余网络一律拦截。
    const HARDHAT_ACCOUNT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const networkName = (env.network as { name?: string } | undefined)?.name ?? "";
    const isLocal = ["hardhat", "localhost", "default"].includes(networkName);
    if (!isLocal && deployer === HARDHAT_ACCOUNT0) {
      throw new Error(
        `[安全门禁] 正在用 Hardhat #0 公开私钥部署到 "${networkName}"！` +
          ` 请先运行 yarn generate 生成 keystore 部署账户并领取测试币，再重新部署。`,
      );
    }

    // 1. 场次工厂：赞助商付费开新场
    const factory = await env.deploy("CampaignFactory", {
      account: deployer,
      artifact: artifacts.CampaignFactory,
      args: [],
    });

    // 2. 终局纪念章：依赖 00 脚本部署的 PlaceCanvas 作为铸造资格来源
    const placeCanvas = env.getOrNull("PlaceCanvas");
    if (!placeCanvas) {
      throw new Error(
        "[部署顺序] 未找到 PlaceCanvas 部署记录！PlaceCanvasNFT 需要以画布地址为构造参数。" +
          " 若使用了 --tags Business 单独部署，请改为全量部署（yarn deploy）后重试。",
      );
    }

    // metadata 基址（测试网演示参数），后续可由 owner 调 setBaseURI 更新
    const baseURI = process.env.NFT_BASE_URI ?? "https://monad.ccwu.cc";

    const nft = await env.deploy("PlaceCanvasNFT", {
      account: deployer,
      artifact: artifacts.PlaceCanvasNFT,
      args: [placeCanvas.address, baseURI],
    });

    // 部署后回读关键参数做冒烟确认
    const fee = await env.read(factory, { functionName: "FEE" });
    const maxSupply = await env.read(nft, { functionName: "MAX_SUPPLY" });
    console.log(
      "💰 CampaignFactory deployed, FEE =",
      fee?.toString(),
      "wei；🏟️ PlaceCanvasNFT deployed, MAX_SUPPLY =",
      maxSupply?.toString(),
      "（测试网演示参数）",
    );
  },
  {
    tags: ["Business"],
  },
);
