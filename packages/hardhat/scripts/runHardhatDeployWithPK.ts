import "dotenv/config";
import { Wallet } from "ethers";
import password from "@inquirer/password";
import { CONFIGURED_NETWORKS, spawnPackageBin } from "./spawnPackageBin.js";

/**
 * Unencrypts the private key and runs the hardhat deploy command,
 * then generates TypeScript ABIs for the frontend.
 */
async function main() {
  const networkIndex = process.argv.indexOf("--network");
  const rawNetwork = networkIndex !== -1 ? process.argv[networkIndex + 1] : "default";

  // The network passed to the child process is picked from the CONFIGURED_NETWORKS
  // literals, never forwarded from raw argv. Unknown names are rejected up front.
  const networkName = CONFIGURED_NETWORKS.find(n => n === rawNetwork);
  if (!networkName) {
    console.error(`Unknown network: ${rawNetwork}. Valid networks: ${CONFIGURED_NETWORKS.join(", ")}`);
    process.exit(1);
  }

  const isLocalNetwork = networkName === "default" || networkName === "hardhat";

  if (!isLocalNetwork) {
    const encryptedKey = process.env.DEPLOYER_PRIVATE_KEY_ENCRYPTED;

    if (!encryptedKey) {
      console.log("🚫️ You don't have a deployer account. Run `yarn generate` or `yarn account:import` first");
      return;
    }

    const pass = await password({ message: "Enter password to decrypt private key:" });

    try {
      const wallet = await Wallet.fromEncryptedJson(encryptedKey, pass);
      process.env.__RUNTIME_DEPLOYER_PRIVATE_KEY = wallet.privateKey;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      console.error("Failed to decrypt private key. Wrong password?");
      process.exit(1);
    }
  }

  // Run hardhat deploy (compilation already handled by the npm script).
  // All arguments are fixed literals plus the allowlisted network from above.
  const deployArgs = ["deploy", "--no-compile", "--skip-prompts"];
  if (networkIndex !== -1) deployArgs.push("--network", networkName);

  const hardhat = spawnPackageBin("hardhat", "hardhat", deployArgs);

  hardhat.on("exit", code => {
    process.exit(code || 0);
  });
}

main().catch(console.error);
