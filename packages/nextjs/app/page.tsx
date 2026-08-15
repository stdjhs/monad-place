"use client";

import Link from "next/link";
import type { NextPage } from "next";

// Monad Place 落地页：价值主张 + 规则速记 + 商业模式 + 双入口（观众端 / 大屏）
const Home: NextPage = () => {
  return (
    <div className="flex items-center flex-col grow pt-10 px-5">
      <h1 className="text-center text-4xl font-bold">
        Monad Place <span className="text-violet-500">🟣</span>
        <span className="text-amber-500">🟡</span> 千人链上像素战争
      </h1>
      <p className="text-center text-lg mt-4 max-w-2xl">
        链上的 r/place：一块 64×36 的共享画布，全场观众扫码参战，<b>每个像素 = 1 笔真实的 Monad 交易</b>。
        冷却规则由智能合约强制，终局 seal() 生成整幅画的链上指纹。
      </p>

      <div className="flex justify-center gap-6 mt-8 flex-wrap">
        <Link href="/play" className="btn btn-primary btn-lg">
          📱 参战（观众端）
        </Link>
        <Link href="/stage" className="btn btn-secondary btn-lg">
          🖥️ 大屏（投影）
        </Link>
        <Link href="/debug" className="btn btn-ghost">
          Debug Contracts
        </Link>
      </div>

      <div className="grow w-full mt-12 px-2 md:px-16 py-10 bg-base-300">
        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <h2 className="card-title">⚡ 规则 30 秒</h2>
              <ul className="list-disc list-inside text-sm">
                <li>
                  每人每 <b>3 秒</b>落 1 子，冷却由<b>智能合约强制</b>（链上规则，不是服务器）
                </li>
                <li>16 色分两阵营：紫晶军团(冷) vs 黄金部落(暖)，覆盖对方格子即夺分</li>
                <li>终局 seal() 冻结画布，keccak256 指纹永久上链</li>
              </ul>
            </div>
          </div>
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <h2 className="card-title">🚀 为什么只有 Monad 行</h2>
              <p className="text-sm">
                千人并发落子 = 每秒数百笔真实交易。大屏 TPS 仪表把并行 EVM 的吞吐变成<b>比分牌</b>——
                人越多，链上体验越好，这在低吞吐链上不可能实现。规模本身就是产品。
              </p>
            </div>
          </div>
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <h2 className="card-title">💼 商业模式</h2>
              <p className="text-sm">
                面向线下活动与品牌方的<b>付费定制画布战役</b>（按场次收费）；终局画布 NFT 铸造分成。
                主办方买的是“全场参与”的引爆点，玩家带走链上纪念品。
              </p>
            </div>
          </div>
        </div>

        <p className="text-center text-xs opacity-60 mt-8 max-w-3xl mx-auto">
          差异化声明：与现有生态项目零重叠——协作画布/共享像素类在生态全量项目库中命中数为 0；
          本项目为“百人并发交易→共享画布实时对抗”的竞技型现场体验，合约核心仅网格状态与事件，独立完整。
        </p>
      </div>
    </div>
  );
};

export default Home;
