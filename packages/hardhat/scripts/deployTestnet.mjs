// 非交互测试网部署：用环境变量 MP_KEYPASS 解密 keystore，校验地址后注入
// __RUNTIME_DEPLOYER_PRIVATE_KEY 执行 yarn deploy --network monadTestnet（私钥不落日志）
// 用法：在 qyyc 根目录 MP_KEYPASS='<密码>' node packages/hardhat/scripts/deployTestnet.mjs
import { Wallet } from "ethers";
import { readFileSync } from "fs";
import { execSync } from "child_process";

const pass = process.env.MP_KEYPASS;
if (!pass) {
  console.error("缺少 MP_KEYPASS 环境变量");
  process.exit(1);
}
const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const m = envText.match(/DEPLOYER_PRIVATE_KEY_ENCRYPTED=(.+)/);
if (!m) {
  console.error("packages/hardhat/.env 中未找到 DEPLOYER_PRIVATE_KEY_ENCRYPTED");
  process.exit(1);
}
const json = m[1].trim().replace(/^["']|["']$/g, "");
const wallet = await Wallet.fromEncryptedJson(json, pass); // 密码错误会在这里抛异常

// 门禁：解密地址必须等于 A2 生成的部署账户（防走错账户/L2 兜底私钥）
const EXPECT = "0x178fff273c5abcdfb79b3847bad41228ffa7544d";
if (wallet.address.toLowerCase() !== EXPECT) {
  console.error(`地址不匹配：解密出 ${wallet.address}，预期 ${EXPECT}，中止`);
  process.exit(1);
}
console.log("keystore 解密 OK，部署账户 =", wallet.address);

// 先编译（外层 yarn deploy 的另一半职责）——注意 hardhat 二进制在 packages/hardhat 工作区内
import { fileURLToPath } from "url";
const PKG_DIR = fileURLToPath(new URL("../", import.meta.url));
execSync("npx hardhat compile", { stdio: "inherit", cwd: PKG_DIR });

// 直接调内层 hardhat deploy（绕过 runHardhatDeployWithPK 的交互式密码弹窗）
// ABI 生成由 hardhat.config 的 deploy task override 自动执行
const { spawn } = await import("child_process");
const hardhat = spawn("npx", ["hardhat", "deploy", "--no-compile", "--skip-prompts", "--network", "monadTestnet"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, __RUNTIME_DEPLOYER_PRIVATE_KEY: wallet.privateKey },
});
hardhat.on("exit", code => process.exit(code || 0));
