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
