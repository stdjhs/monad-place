import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve, sep } from "path";
import { fileURLToPath } from "url";

// 参数白名单：只放行旗标/十六进制地址/路径/常见选项字符。空格、引号与 shell 元字符一律拒绝——
// 即便下方不走 shell，外部 argv 也只允许安全子集，从源头切断注入向量
export const SAFE_ARG_RE = /^[a-zA-Z0-9_\-./:=@,]+$/;

// hardhat.config.ts 里配置的全部网络名（手动同步）：调用方据此把外部输入的网络名
// 映射成白名单字面量，再传给子进程
export const CONFIGURED_NETWORKS = [
  "default",
  "hardhat",
  "monadTestnet",
  "mainnet",
  "sepolia",
  "optimism",
  "optimismSepolia",
  "base",
  "baseSepolia",
  "arbitrum",
  "arbitrumSepolia",
  "scroll",
  "scrollSepolia",
  "celo",
  "celoSepolia",
  "polygon",
  "polygonAmoy",
  "gnosis",
  "chiado",
  "polygonZkEvm",
  "polygonZkEvmCardona",
] as const;

/**
 * Runs a dependency's bin entry with node directly, without a shell.
 * Spawning through a shell would let argument values containing shell metacharacters
 * execute arbitrary commands, and on win32 the node_modules/.bin shim is a .cmd file
 * that node cannot exec without a shell — so we resolve the bin's JS entry point and
 * run it with process.execPath instead. Every argument is validated against a strict
 * character allowlist before spawning.
 */
export function spawnPackageBin(
  pkgName: string,
  binName: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  for (const arg of args) {
    if (!SAFE_ARG_RE.test(arg)) {
      throw new Error(`Refused to spawn ${binName}: argument contains disallowed characters: ${arg.slice(0, 80)}`);
    }
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));

  // Walk upwards from this script to find the package (works with yarn workspace hoisting)
  let pkgRoot: string | undefined;
  for (let dir = scriptDir; ;) {
    const candidate = resolve(dir, "node_modules", pkgName);
    if (existsSync(resolve(candidate, "package.json"))) {
      pkgRoot = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!pkgRoot) throw new Error(`Package ${pkgName} not found (searched upwards from ${scriptDir})`);

  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!binRel) throw new Error(`No "${binName}" bin entry in ${pkgName}`);

  // bin 字段来自依赖清单：仍校验解析结果不逃出包目录，防异常清单把入口指向任意脚本
  const binAbs = resolve(pkgRoot, binRel);
  if (!binAbs.startsWith(pkgRoot + sep)) {
    throw new Error(`Refused "${binName}": bin entry resolves outside the package directory`);
  }

  return spawn(process.execPath, [binAbs, ...args], { stdio: "inherit", env });
}
