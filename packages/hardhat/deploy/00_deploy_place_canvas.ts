import { deployScript, artifacts } from "../rocketh/deploy.js";

/**
 * 部署 PlaceCanvas（链上像素战争画布合约）
 *
 * 构造参数 liveSeconds = 28800（8 小时），覆盖比赛全天 + Demo 演示时段；
 * 部署者（deployer）即"主持人"，是唯一可调用 seal() 封盘的账户。
 */
export default deployScript(
  async env => {
    const { deployer } = env.namedAccounts;

    // 安全门禁（审计 L2）：hardhat.config 在未设置部署密钥时会兜底用众所周知的
    // Hardhat #0 私钥。用它部署到测试网/主网 = host 私钥公开 = 任何人可提前 seal() 冻结全场。
    // 本地网络（hardhat/localhost/default）允许；其余网络一律拦截。
    const HARDHAT_ACCOUNT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const networkName = (env.network as { name?: string } | undefined)?.name ?? "";
    const isLocal = ["hardhat", "localhost", "default"].includes(networkName);
    if (!isLocal && deployer === HARDHAT_ACCOUNT0) {
      throw new Error(
        `[安全门禁] 正在用 Hardhat #0 公开私钥部署到 "${networkName}"！` +
          ` 请先运行 yarn generate 生成 keystore 部署账户并领取测试币，再重新部署。`,
      );
    }

    const placeCanvas = await env.deploy("PlaceCanvas", {
      account: deployer,
      artifact: artifacts.PlaceCanvas,
      args: [28800],
    });

    // 部署后回读冷却时间做冒烟确认
    const cooldown = await env.read(placeCanvas, { functionName: "cooldownSeconds" });
    console.log("🎨 PlaceCanvas deployed, cooldown =", cooldown?.toString(), "seconds");
  },
  {
    tags: ["PlaceCanvas"],
  },
);
