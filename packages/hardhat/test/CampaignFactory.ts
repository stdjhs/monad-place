import { expect } from "chai";
import { network } from "hardhat";
import type { Abi_CampaignFactory } from "../generated/abis/CampaignFactory.js";
import type { Abi_PlaceCanvas } from "../generated/abis/PlaceCanvas.js";
import { loadAndExecuteDeploymentsFromFiles } from "../rocketh/environment.js";

const { provider, networkHelpers, ethers } = await network.create();

// 每场次固定费用 0.1 ether（与合约 FEE 常量一致）
const FEE = 100000000000000000n;

// 复用同一套部署的 fixture：取工厂合约与画布 ABI（用于回连验证）
async function deployFixture() {
  const env = await loadAndExecuteDeploymentsFromFiles({ provider });
  const { address: factoryAddr, abi: factoryAbi } = env.get<Abi_CampaignFactory>("CampaignFactory");
  const factory = await ethers.getContractAt(factoryAbi, factoryAddr);
  const { abi: canvasAbi } = env.get<Abi_PlaceCanvas>("PlaceCanvas");
  return { factory, canvasAbi };
}

describe("CampaignFactory", function () {
  it("付费不足拒建（InsufficientFee），不产生任何场次", async function () {
    const { factory } = await networkHelpers.loadFixture(deployFixture);
    const [, sponsor] = await ethers.getSigners();

    await expect(
      factory.connect(sponsor).createCampaign("盗版场次", "紫晶", "黄金", 3600, { value: 50000000000000000n }),
    ).to.be.revertedWithCustomError(factory, "InsufficientFee");

    // 工厂内没有留下任何场次记录（campaigns 数组为空 → canvasOf(0) 尚无画布）
    expect(await factory.canvasOf(0n)).to.equal("0x0000000000000000000000000000000000000000");
  });

  it("支付 0.1 ether 创建成功：事件/字段/画布回连均正确", async function () {
    const { factory, canvasAbi } = await networkHelpers.loadFixture(deployFixture);
    const [, sponsor] = await ethers.getSigners();

    const tx = await factory
      .connect(sponsor)
      .createCampaign("Monad Blitz 发布会", "紫晶", "黄金", 3600, { value: FEE });

    const canvasAddr = await factory.canvasOf(0n);
    expect(canvasAddr).to.not.equal("0x0000000000000000000000000000000000000000");

    // 方案硬性项：CampaignCreated(0, sponsor, canvas, title) 事件
    await expect(tx)
      .to.emit(factory, "CampaignCreated")
      .withArgs(0n, sponsor.address, canvasAddr, "Monad Blitz 发布会");

    // 回连画布验证：主持人 = 工厂（设计取舍：seal 权限随画布 owner 转移到工厂）
    // 注意两边地址大小写形态可能不同（checksummed vs 小写），统一小写后比较
    const canvas = await ethers.getContractAt(canvasAbi, canvasAddr);
    expect((await canvas.owner()).toLowerCase()).to.equal((await factory.getAddress()).toLowerCase());
    expect(await canvas.isSealed()).to.equal(false);

    // endsAt = 创建块时间 + 3600，与当前链上时间对比（容差 30 秒内）
    const endsAt = await canvas.endAt();
    const now = await networkHelpers.time.latest();
    const drift = BigInt(now) + 3600n - endsAt; // 创建在查询之前，drift >= 0
    expect(drift).to.be.at.least(0n);
    expect(drift).to.be.at.most(30n);

    // campaigns(0) 各字段正确
    const campaign = await factory.campaigns(0n);
    expect(campaign.sponsor).to.equal(sponsor.address);
    expect(campaign.title).to.equal("Monad Blitz 发布会");
    expect(campaign.team1Name).to.equal("紫晶");
    expect(campaign.team2Name).to.equal("黄金");
    expect(campaign.endsAt).to.equal(endsAt);
  });

  it("liveSeconds 越界拒建（0 与 24 小时以上均为 BadLiveSeconds）", async function () {
    const { factory } = await networkHelpers.loadFixture(deployFixture);
    const [, sponsor] = await ethers.getSigners();

    await expect(
      factory.connect(sponsor).createCampaign("零时长", "紫晶", "黄金", 0, { value: FEE }),
    ).to.be.revertedWithCustomError(factory, "BadLiveSeconds");

    await expect(
      factory.connect(sponsor).createCampaign("超长时长", "紫晶", "黄金", 24n * 3600n + 1n, { value: FEE }),
    ).to.be.revertedWithCustomError(factory, "BadLiveSeconds");
  });

  it("非 owner 提款被拒；owner 提款到账（方案硬性项）", async function () {
    const { factory } = await networkHelpers.loadFixture(deployFixture);
    const [owner, sponsor, other] = await ethers.getSigners();

    // 先造一笔收入：sponsor 支付 0.1 ether 建场
    await factory.connect(sponsor).createCampaign("提款测试", "紫晶", "黄金", 3600, { value: FEE });

    // 非 owner 提款被 OZ Ownable 拦截
    await expect(factory.connect(other).withdraw())
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
      .withArgs(other.address);

    // owner 提款：工厂 -0.1 ether，owner +0.1 ether（方案硬性项）
    // 注意：hardhat 3 版 chai matchers 的该断言第一个参数需传 ethers 实例
    await expect(factory.withdraw()).to.changeEtherBalances(ethers, [factory, owner], [-FEE, FEE]);
  });

  it("多收款留存合约，owner 可一并提走", async function () {
    const { factory } = await networkHelpers.loadFixture(deployFixture);
    const [owner, sponsor] = await ethers.getSigners();

    // 多付 0.1 ether（共 0.2 ether）不退款，全额留在合约内
    await factory.connect(sponsor).createCampaign("多付测试", "紫晶", "黄金", 3600, { value: 2n * FEE });
    const factoryAddr = await factory.getAddress();
    expect(await ethers.provider.getBalance(factoryAddr)).to.equal(2n * FEE);

    await factory.connect(owner).withdraw();
    expect(await ethers.provider.getBalance(factoryAddr)).to.equal(0n);
  });
});
