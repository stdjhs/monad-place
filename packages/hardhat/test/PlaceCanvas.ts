import { expect } from "chai";
import { network } from "hardhat";
import type { Abi_PlaceCanvas } from "../generated/abis/PlaceCanvas.js";
import { loadAndExecuteDeploymentsFromFiles } from "../rocketh/environment.js";

const { provider, networkHelpers, ethers } = await network.create();

// 复用同一套部署的 fixture
async function deployFixture() {
  const env = await loadAndExecuteDeploymentsFromFiles({ provider });
  const { address, abi } = env.get<Abi_PlaceCanvas>("PlaceCanvas");
  const placeCanvas = await ethers.getContractAt(abi, address);
  return { env, placeCanvas };
}

describe("PlaceCanvas", function () {
  it("首个落子成功并正确计入统计", async function () {
    const { placeCanvas } = await networkHelpers.loadFixture(deployFixture);
    await placeCanvas.place(1, 1, 5);
    expect(await placeCanvas.totalPlaced()).to.equal(1n);
    expect(await placeCanvas.uniquePlayers()).to.equal(1n);
    expect(await placeCanvas.teamPixels(1)).to.equal(1n); // 冷色 5 → 紫晶军团
  });

  it("同色重复落子被拒绝（SameColor）", async function () {
    const { placeCanvas } = await networkHelpers.loadFixture(deployFixture);
    const [, other] = await ethers.getSigners();
    // 注意：合约中 Cooldown 检查在 SameColor 之前，因此必须由另一名玩家（无冷却）重复同色落子
    await placeCanvas.place(2, 2, 5);
    await expect(placeCanvas.connect(other).place(2, 2, 5))
      .to.be.revertedWithCustomError(placeCanvas, "SameColor")
      .withArgs();
  });

  it("冷却期内再次落子被拒绝（Cooldown）", async function () {
    const { placeCanvas } = await networkHelpers.loadFixture(deployFixture);
    await placeCanvas.place(3, 3, 5);
    // 未等待 cooldownSeconds（3s）直接再落另一格
    await expect(placeCanvas.place(4, 4, 6))
      .to.be.revertedWithCustomError(placeCanvas, "Cooldown")
      .withArgs();
  });

  it("非法颜色/越界坐标被拒绝（BadColor）", async function () {
    const { placeCanvas } = await networkHelpers.loadFixture(deployFixture);
    await expect(placeCanvas.place(1, 1, 0)).to.be.revertedWithCustomError(placeCanvas, "BadColor");
    await expect(placeCanvas.place(1, 1, 17)).to.be.revertedWithCustomError(placeCanvas, "BadColor");
    await expect(placeCanvas.place(64, 36, 1)).to.be.revertedWithCustomError(placeCanvas, "BadColor");
  });

  it("非主持人 seal 被拒绝；主持人 seal 成功并冻结画布", async function () {
    const { placeCanvas } = await networkHelpers.loadFixture(deployFixture);
    const [, other] = await ethers.getSigners();
    await placeCanvas.place(5, 5, 5); // 先落一子

    // 任何观众都无法封盘
    await expect(placeCanvas.connect(other).seal()).to.be.revertedWith("not host");

    await placeCanvas.seal();
    expect(await placeCanvas.isSealed()).to.equal(true);

    // 封盘后落子被拒绝（NotLive）
    await expect(placeCanvas.place(6, 6, 6)).to.be.revertedWithCustomError(placeCanvas, "NotLive");
  });

  it("覆盖敌格会转移阵营计数", async function () {
    const { placeCanvas } = await networkHelpers.loadFixture(deployFixture);
    const [, other] = await ethers.getSigners();
    await placeCanvas.place(7, 7, 5); // 紫晶占格
    expect(await placeCanvas.teamPixels(1)).to.equal(1n);

    // 另一玩家（不受冷却限制）用暖色覆盖同一格 → 黄金+1、紫晶-1
    await networkHelpers.time.increase(5);
    await placeCanvas.connect(other).place(7, 7, 9);
    expect(await placeCanvas.teamPixels(1)).to.equal(0n);
    expect(await placeCanvas.teamPixels(2)).to.equal(1n);
  });
});
