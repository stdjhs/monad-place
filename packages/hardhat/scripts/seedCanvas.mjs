// 本地链画布播种（演示截图用）：单账户 + evm_increaseTime 跳过 3s 冷却
// 用法：node scripts/seedCanvas.mjs（需 yarn chain && yarn deploy 已跑）
import { ethers } from "ethers";
import { readFileSync } from "fs";

const RPC = "http://127.0.0.1:8545";
// Hardhat 节点默认账户 #0（公开测试密钥，仅本地链）
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const dep = JSON.parse(readFileSync(new URL("../deployments/default/PlaceCanvas.json", import.meta.url)));
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(KEY, provider);
const canvas = new ethers.Contract(dep.address, dep.abi, wallet);

// 紫金对峙阵型：左翼紫晶(1-8)，右翼黄金(9-16)，中央交错争夺带
const plan = [];
for (let i = 0; i < 12; i++) plan.push([14 + (i % 7), 10 + ((i * 3) % 14), 1 + (i % 8)]); // 紫晶左翼
for (let i = 0; i < 12; i++) plan.push([43 + (i % 7), 10 + ((i * 5) % 14), 9 + (i % 8)]); // 黄金右翼
for (let i = 0; i < 6; i++) plan.push([29 + (i % 6), 12 + ((i * 4) % 12), i % 2 ? 5 : 12]); // 中央争夺带

let placed = 0;
for (const [x, y, color] of plan) {
  try {
    await (await canvas.place(x, y, color, { gasPrice: ethers.parseUnits("52", "gwei") })).wait();
    placed++;
  } catch {
    // 幂等：同色已占/冷却未到等业务性 revert 直接跳过（重复运行安全）
  }
  await provider.send("evm_increaseTime", [4]); // 快进冷却
  await provider.send("evm_mine", []);
}
console.log(`seeded(+) ${placed} pixels at ${dep.address}, totalPlaced=${await canvas.totalPlaced()}`);
