"use client";

import { useEffect, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { useDeployedContractInfo, useScaffoldWatchContractEvent } from "~~/hooks/scaffold-eth";

// P-B 全场合唱（02 方案）：大屏发起 3-2-1 倒计时 → 全场同刻落子 3s → 链上对账出战报
// 纯前端零合约改动；窗口内实时计数仅为视觉反馈，战报以 eth_getLogs 块区间对账为准
// 配色遵循 dataviz 规范：金=活动量 / 紫=结构 / 绿=性能（与 stage HUD 分类色语义一致），无渐变
const CHORUS_WINDOW_MS = 3000; // 合唱窗口时长（3 秒）
const SETTLE_DELAY_MS = 1500; // 窗口结束到对账的缓冲（等最后的块可查）
const SETTLE_MAX_RETRY = 3; // 对账 RPC 失败重试上限（用尽后回退实时计数）

type Phase = "idle" | "countdown" | "collecting" | "settling" | "report";

type ChorusReport = {
  total: number; // 窗口内总落子数
  blocks: number; // 覆盖的 distinct 区块数
  peakPerBlock: number; // 单块最高并发笔数
  players: number; // distinct 玩家数
};

// 战报三联指标块（stat tile：大数字 + 小标签，tabular-nums 防数字跳动）
const StatTile = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div className="py-6 rounded-xl bg-[#0b0e1d] border border-[#1e2440]">
    <div className="text-7xl font-black tabular-nums" style={{ color }}>
      {value}
    </div>
    <div className="mt-2 text-lg text-[#94a3b8]">{label}</div>
  </div>
);

const MassChorus = () => {
  const { data: contractInfo } = useDeployedContractInfo({ contractName: "PlaceCanvas" });
  const publicClient = usePublicClient();

  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(3);
  const [liveCount, setLiveCount] = useState(0);
  const [report, setReport] = useState<ChorusReport | null>(null);

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const collectingRef = useRef(false); // 供事件回调读取（绕过闭包过期）
  const liveCountRef = useRef(0); // 对账失败时的实时计数兜底
  const cancelledRef = useRef(false);

  // 卸载清理：停掉所有挂起的倒计时/窗口/重试定时器（拷贝引用，避免 cleanup 时 ref 已被清空）
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      cancelledRef.current = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  const wait = (ms: number) =>
    new Promise<void>(resolve => {
      timersRef.current.push(setTimeout(resolve, ms));
    });

  // 实时通道：仅窗口开启时累计（polling watch）；最终数字以链上对账为准
  useScaffoldWatchContractEvent({
    contractName: "PlaceCanvas",
    eventName: "PixelPlaced",
    onLogs: logs => {
      if (!collectingRef.current) return;
      liveCountRef.current += logs.length;
      setLiveCount(liveCountRef.current);
    },
  });

  // 链上对账：从窗口起点块拉 PixelPlaced，按 placedAt（块时间戳）过滤窗口内事件后统计三项指标
  const settle = async (startBlock: bigint, windowStartSec: number, attempt = 0) => {
    if (!publicClient || !contractInfo || cancelledRef.current) return;
    const windowEndSec = windowStartSec + CHORUS_WINDOW_MS / 1000;
    try {
      const endBlock = await publicClient.getBlockNumber();
      const logs = (await publicClient.getContractEvents({
        address: contractInfo.address,
        abi: contractInfo.abi,
        eventName: "PixelPlaced",
        fromBlock: startBlock + 1n,
        toBlock: endBlock,
      })) as { blockNumber: bigint | null; args: { user?: unknown; placedAt?: unknown } }[];
      const perBlock = new Map<string, number>();
      const players = new Set<string>();
      let total = 0;
      for (const log of logs) {
        const placedAt = Number(log.args.placedAt ?? 0);
        // 容差 ±2s：吸收链上块时间与本地时钟的偏差
        if (placedAt < windowStartSec - 2 || placedAt > windowEndSec + 2) continue;
        total += 1;
        if (log.blockNumber !== null) {
          const key = log.blockNumber.toString();
          perBlock.set(key, (perBlock.get(key) ?? 0) + 1);
        }
        players.add(String(log.args.user ?? "0x0"));
      }
      const peak = Array.from(perBlock.values()).reduce((m, n) => Math.max(m, n), 0);
      setReport({ total, blocks: perBlock.size, peakPerBlock: peak, players: players.size });
      setPhase("report");
    } catch {
      // RPC 抖动：间隔重试；用尽后以实时计数兜底出报（总笔数仍真实近似）
      if (attempt < SETTLE_MAX_RETRY) {
        await wait(2000);
        await settle(startBlock, windowStartSec, attempt + 1);
      } else {
        setReport({ total: liveCountRef.current, blocks: 0, peakPerBlock: 0, players: 0 });
        setPhase("report");
      }
    }
  };

  // 主流程：3-2-1 倒计时 → 记录窗口起点（块高基线 + 本地时钟）→ 3s 收集 → 缓冲 → 对账
  const startChorus = async () => {
    const busy = phase === "countdown" || phase === "collecting" || phase === "settling";
    if (busy || !publicClient || !contractInfo) return;
    setReport(null);
    liveCountRef.current = 0;
    setLiveCount(0);
    setPhase("countdown");
    for (let n = 3; n >= 1; n--) {
      setCountdown(n);
      await wait(1000);
      if (cancelledRef.current) return;
    }
    const startBlock = await publicClient.getBlockNumber();
    const windowStartSec = Math.floor(Date.now() / 1000);
    collectingRef.current = true;
    setPhase("collecting");
    await wait(CHORUS_WINDOW_MS);
    collectingRef.current = false;
    if (cancelledRef.current) return;
    setPhase("settling");
    await wait(SETTLE_DELAY_MS);
    await settle(startBlock, windowStartSec);
  };

  return (
    <>
      {/* 入口按钮：底部居中悬浮（不占 HUD 布局，不与二维码/排行榜重叠），仅空闲时显示 */}
      {phase === "idle" && (
        <button
          onClick={() => void startChorus()}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-6 py-3 rounded-full bg-[#0b0e1d] border border-[#a78bfa] text-[#a78bfa] text-xl font-bold shadow-[0_0_20px_#a78bfa44] hover:bg-[#141830] transition-colors cursor-pointer"
        >
          🎵 发起合唱
        </button>
      )}

      {/* 全屏覆盖层：收集期半透明（画布涟漪仍可见），倒计时/战报期加深聚焦 */}
      {phase !== "idle" && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center text-center px-6"
          style={{ background: phase === "collecting" ? "#05060f80" : "#05060fd9" }}
        >
          {phase === "countdown" && (
            <div>
              <div
                key={countdown}
                className="animate-pulse text-[10rem] leading-none font-black text-[#a78bfa] tabular-nums"
                style={{ textShadow: "0 0 60px #a78bfa66" }}
              >
                {countdown}
              </div>
              <p className="mt-4 text-2xl text-[#e2e8f0]">准备同时落子！</p>
            </div>
          )}

          {phase === "collecting" && (
            <div className="animate-pulse">
              <div className="text-6xl">🔥</div>
              <div className="mt-2 text-3xl text-[#e2e8f0] font-bold">全场合唱中</div>
              <div className="mt-2 text-8xl font-black text-[#fbbf24] tabular-nums">{liveCount}</div>
              <p className="mt-1 text-xl text-[#94a3b8]">笔交易正在并行执行…</p>
            </div>
          )}

          {phase === "settling" && <p className="text-3xl text-[#94a3b8] animate-pulse">正在链上对账…</p>}

          {phase === "report" && report && (
            <div className="max-w-4xl w-full">
              <h2 className="text-4xl font-bold text-[#e2e8f0]">🎺 合唱战报</h2>
              <p className="mt-2 text-xl text-[#94a3b8]">刚才 {CHORUS_WINDOW_MS / 1000} 秒 ——</p>

              {/* 三联指标：金=交易量 / 紫=区块结构 / 绿=并发性能 */}
              <div className="mt-6 grid grid-cols-3 gap-6">
                <StatTile label="笔交易" value={report.total} color="#fbbf24" />
                <StatTile label="覆盖区块" value={report.blocks} color="#a78bfa" />
                <StatTile label="单块最高并发" value={report.peakPerBlock} color="#34d399" />
              </div>
              <p className="mt-4 text-lg text-[#94a3b8]">{report.players} 名玩家同刻参战</p>

              {/* 以太坊对比为预写保守话术（02 方案：写死「数十分钟级」，不现场计算） */}
              <p className="mt-8 text-2xl text-[#e2e8f0]">
                在以太坊，这些交易串行需排队<span className="text-[#fbbf24] font-bold">数十分钟级</span>； 在
                Monad，它们<span className="text-[#34d399] font-bold">并行完成了</span>
              </p>

              <div className="mt-10 flex gap-4 justify-center">
                <button
                  onClick={() => void startChorus()}
                  className="px-6 py-3 rounded-full bg-[#0b0e1d] border border-[#a78bfa] text-[#a78bfa] text-lg font-bold hover:bg-[#141830] transition-colors cursor-pointer"
                >
                  🔁 再来一场
                </button>
                <button
                  onClick={() => setPhase("idle")}
                  className="px-6 py-3 rounded-full bg-[#0b0e1d] border border-[#1e2440] text-[#94a3b8] text-lg hover:bg-[#141830] transition-colors cursor-pointer"
                >
                  ✕ 关闭
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default MassChorus;
