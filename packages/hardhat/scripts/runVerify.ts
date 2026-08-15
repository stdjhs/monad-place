import "dotenv/config";
import { etherscanApiKey } from "../hardhat.config.js";
import { CONFIGURED_NETWORKS, spawnPackageBin } from "./spawnPackageBin.js";

/**
 * Forwards `yarn verify --network <name> [args]` to the rocketh-verify CLI.
 */
async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage: yarn verify --network <name> [subcommand]",
        "",
        "Subcommands: etherscan (default) | sourcify | blockscout | metadata",
        "",
        "Examples:",
        "  yarn verify --network optimismSepolia",
        "  yarn verify --network sepolia sourcify",
      ].join("\n"),
    );
    return;
  }

  const networkIdx = argv.indexOf("--network");
  const rawNetwork = networkIdx !== -1 ? argv[networkIdx + 1] : "default";
  // The network passed to the child process is picked from the CONFIGURED_NETWORKS
  // literals, never forwarded from raw argv. Unknown names are rejected up front.
  const network = CONFIGURED_NETWORKS.find(n => n === rawNetwork);
  if (!network) {
    console.error(`Unknown network: ${rawNetwork}. Valid networks: ${CONFIGURED_NETWORKS.join(", ")}`);
    process.exit(1);
  }

  // Only a single allowlisted subcommand is accepted on top of --network; arbitrary
  // arguments are never forwarded to the child process.
  const subcommands = ["etherscan", "sourcify", "blockscout", "metadata"] as const;
  const rest = argv.filter((_, i) => i !== networkIdx && i !== networkIdx + 1);
  if (rest.length > 1) {
    console.error("Only one optional subcommand is supported: " + subcommands.join(" | "));
    process.exit(1);
  }
  const subcommand = rest.length === 1 ? subcommands.find(s => s === rest[0]) : undefined;
  if (rest.length === 1 && !subcommand) {
    console.error(`Unsupported argument: ${rest[0]}. Subcommands: ${subcommands.join(" | ")}`);
    process.exit(1);
  }

  // All arguments are allowlisted literals; rocketh-verify inherits ETHERSCAN_API_KEY
  // from process.env on its own (no env rewriting needed here).
  const verifyArgs = ["-e", network];
  verifyArgs.push(subcommand ?? "etherscan");

  if (!etherscanApiKey) {
    console.log("⚠️  ETHERSCAN_API_KEY not set. Add it to packages/hardhat/.env for contract verification.\n");
  }

  const child = spawnPackageBin("@rocketh/verifier", "rocketh-verify", verifyArgs);

  child.on("exit", code => {
    process.exit(code || 0);
  });
}

main().catch(console.error);
