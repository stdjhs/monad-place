import { expect } from "chai";
import { network } from "hardhat";
import type { Abi_PlaceCanvas } from "../generated/abis/PlaceCanvas.js";
import type { Abi_PlaceCanvasNFT } from "../generated/abis/PlaceCanvasNFT.js";
import { loadAndExecuteDeploymentsFromFiles } from "../rocketh/environment.js";

const { provider, networkHelpers, ethers } = await network.create();

// 复用同一套部署的 fixture：取画布与纪念章合约
async function deployFixture() {
  const env = await loadAndExecuteDeploymentsFromFiles({ provider });
  const { address: canvasAddr, abi: canvasAbi } = env.get<Abi_PlaceCanvas>("PlaceCanvas");
  const placeCanvas = await ethers.getContractAt(canvasAbi, canvasAddr);
  const { address: nftAddr, abi: nftAbi } = env.get<Abi_PlaceCanvasNFT>("PlaceCanvasNFT");
  const nft = await ethers.getContractAt(nftAbi, nftAddr);
  return { placeCanvas, nft };
}

// 已封盘场景：主持人(host)与玩家一(player1)分属两阵营各落一子，随后主持人 seal()
// 注意：place 有 3 秒冷却，但两名落子者地址不同，互不触发冷却
async function sealedFixture() {
  const { placeCanvas, nft } = await networkHelpers.loadFixture(deployFixture);
  const [host, player1, player2, outsider] = await ethers.getSigners();
  await placeCanvas.place(1, 1, 5); // 主持人落子：冷色 5 → 紫晶军团
  await placeCanvas.connect(player1).place(2, 2, 12); // 玩家一落子：暖色 12 → 黄金部落
  await placeCanvas.seal(); // 仅画布 owner（部署者 = 签名者 #0）可封盘
  return { placeCanvas, nft, host, player1, player2, outsider };
}

describe("PlaceCanvasNFT", function () {
  it("未 seal 时 mint 被拒绝（NotSealed）", async function () {
    const { nft } = await networkHelpers.loadFixture(deployFixture);
    const [host] = await ethers.getSigners();
    // 画布尚未封盘，即使是落过子的主持人也不能 mint
    await expect(nft.connect(host).mint()).to.be.revertedWithCustomError(nft, "NotSealed");
  });

  it("seal 后非参与者 mint 被拒绝（NotPlayer）", async function () {
    const { nft, outsider } = await networkHelpers.loadFixture(sealedFixture);
    // outsider 从未落子，placedCount == 0，无铸造资格
    await expect(nft.connect(outsider).mint()).to.be.revertedWithCustomError(nft, "NotPlayer");
  });

  it("seal 后参与者 mint 成功，余额与事件正确", async function () {
    const { nft, host } = await networkHelpers.loadFixture(sealedFixture);

    const tx = await nft.connect(host).mint();
    const tokenId = await nft.sealBlock();

    // 首次铸造锁定 sealBlock（≈ seal 块高），作为全场 tokenId
    expect(tokenId).to.not.equal(0n);
    expect(await nft.balanceOf(host.address, tokenId)).to.equal(1n);
    expect(await nft.mintedCount()).to.equal(1n);
    expect(await nft.hasMinted(host.address)).to.equal(true);
    await expect(tx).to.emit(nft, "Minted").withArgs(host.address, tokenId);
  });

  it("第二名参与者 mint 后 tokenId 不变，全场同一枚（mintedCount == 2）", async function () {
    const { nft, host, player1 } = await networkHelpers.loadFixture(sealedFixture);

    await nft.connect(host).mint();
    const firstTokenId = await nft.sealBlock();

    await nft.connect(player1).mint();
    // sealBlock 不再更新：两枚纪念章共用同一 tokenId
    expect(await nft.sealBlock()).to.equal(firstTokenId);
    expect(await nft.balanceOf(player1.address, firstTokenId)).to.equal(1n);
    expect(await nft.mintedCount()).to.equal(2n);
  });

  it("同一人重复 mint 被拒绝（AlreadyMinted）", async function () {
    const { nft, host } = await networkHelpers.loadFixture(sealedFixture);
    await nft.connect(host).mint();
    await expect(nft.connect(host).mint()).to.be.revertedWithCustomError(nft, "AlreadyMinted");
  });

  it("uri 按基址正确拼接；setBaseURI 仅 owner 可用", async function () {
    const { nft, host, outsider } = await networkHelpers.loadFixture(sealedFixture);
    await nft.connect(host).mint();
    const tokenId = await nft.sealBlock();

    // 与部署脚本一致的基址取值（环境变量优先），验证 baseURI/<tokenId>.json 拼接
    const base = process.env.NFT_BASE_URI ?? "https://monad.ccwu.cc";
    expect(await nft.uri(tokenId)).to.equal(`${base}/${tokenId.toString()}.json`);

    // owner 更新基址后 uri 立即生效
    await nft.setBaseURI("https://example.com");
    expect(await nft.uri(tokenId)).to.equal(`https://example.com/${tokenId.toString()}.json`);

    // 非 owner 调用被 OZ Ownable 拦截
    await expect(nft.connect(outsider).setBaseURI("https://evil.com"))
      .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
      .withArgs(outsider.address);
  });

  it("版税 5% 指向部署者；同时支持 ERC-1155 与 ERC-2981 接口", async function () {
    const { nft } = await networkHelpers.loadFixture(deployFixture);
    const [deployer] = await ethers.getSigners();

    // 售价 10000 wei 的 5% 版税 = 500 wei，收款人为部署者
    const [receiver, amount] = await nft.royaltyInfo(1n, 10000n);
    expect(receiver).to.equal(deployer.address);
    expect(amount).to.equal(500n);

    // 接口标识：ERC-1155 与 ERC-2981 均命中
    expect(await nft.supportsInterface("0xd9b67a26")).to.equal(true);
    expect(await nft.supportsInterface("0x2a55205a")).to.equal(true);
  });

  it("MAX_SUPPLY 常量为 300", async function () {
    const { nft } = await networkHelpers.loadFixture(deployFixture);
    // 注：全量售罄需 300 个不同签名者账户，超出默认 20 个账户，不在此模拟 SoldOut
    expect(await nft.MAX_SUPPLY()).to.equal(300n);
  });
});
