"use client";

import { useEffect, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";

// P-C 像素雨回放（02 方案）：?replay=1 模式下全量分页拉取 PixelPlaced，
// 按 placedAt 时间轴倍速重放——涟漪/音符/TPS 由父页面回调重现（同帧爆发的并发涟漪可见）
// 事件全量拉取：二分定位合约部署块（避免 0 起点全链扫描）+ 100 块窗口分页（官方 RPC 限制）
// 进度条可拖动（seek 快进只画像素不加特效），支持 播放/暂停/倍速/重播
// 架构：调度器（timer/playing/cursor/speed）全部封闭在 effect 作用域内，
// 控制方法经 controlsRef 暴露给事件回调——满足 react-hooks（React Compiler）约束

export type ReplayEvent = { idx: number; color: number; placedAt: number };
type ReplayStatus = "loading" | "playing" | "paused" | "done";
type PublicClient = NonNullable<ReturnType<typeof usePublicClient>>;

const PAGE_BLOCKS = 100n; // 官方公共 RPC eth_getLogs 限 100 块/次
const SPEEDS = [8, 32, 64]; // 倍速档位（02 方案基准 20-50 倍速，放宽两端适配疏密场景）

type Props = {
  replayEvent: (idx: number, color: number) => void; // 正常播放：涟漪+音符+TPS 重现
  fastPaint: (idx: number, color: number) => void; // seek 快进：只画像素（无特效，避免爆音墙）
  clearCanvas: () => void; // 重置画布为空白
};

// 二分查找合约部署块（getCode 在部署块之前为空），log2(块高) ≈ 20 次请求
const findDeployBlock = async (client: PublicClient, address: string, latest: bigint) => {
  let lo = 1n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await client.getCode({ address: address as `0x${string}`, blockNumber: mid });
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1n;
  }
  return lo;
};

const ReplayEngine = ({ replayEvent, fastPaint, clearCanvas }: Props) => {
  const { data: contractInfo } = useDeployedContractInfo({ contractName: "PlaceCanvas" });
  const publicClient = usePublicClient();

  // 渲染层 state（真值在 effect 闭包内，state 仅是镜像）
  const [status, setStatus] = useState<ReplayStatus>("loading");
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [speed, setSpeed] = useState(32);
  const [loadText, setLoadText] = useState("正在定位合约部署块…");

  // 控制方法句柄：effect 内写入（合法），事件回调中读取调用
  const controlsRef = useRef<{
    play: () => void;
    pause: () => void;
    seek: (i: number) => void;
    restart: () => void;
    setSpeed: (n: number) => void;
  } | null>(null);

  useEffect(() => {
    if (!publicClient || !contractInfo) return;
    // 调度器全部可变状态封闭在 effect 作用域（React Compiler 友好）
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let playing = false;
    let speedFactor = 32;
    let cursor = 0;
    const events: ReplayEvent[] = [];

    const setStatusSafe = (s: ReplayStatus) => {
      if (!cancelled) setStatus(s);
    };

    // 调度链：按相邻事件 placedAt 时间差 / 倍速 计算下一帧延迟（下限 8ms 防 UI 卡死）
    const step = () => {
      if (!playing) return;
      const ev = events[cursor];
      if (!ev) {
        playing = false;
        setStatusSafe("done");
        return;
      }
      replayEvent(ev.idx, ev.color);
      cursor += 1;
      if (!cancelled) setCursor(cursor);
      if (cursor >= events.length) {
        playing = false;
        setStatusSafe("done");
        return;
      }
      const next = events[cursor];
      const dt = Math.max(8, ((next.placedAt - ev.placedAt) * 1000) / speedFactor);
      timer = setTimeout(step, dt);
    };

    const play = () => {
      if (cursor >= events.length) return;
      playing = true;
      setStatusSafe("playing");
      step();
    };

    const pause = () => {
      playing = false;
      if (timer) clearTimeout(timer);
      setStatusSafe("paused");
    };

    // 拖动 seek：快进重画 0..i-1（只画像素），再从 i 继续（播放态）或停在该帧（暂停态）
    const seek = (i: number) => {
      if (timer) clearTimeout(timer);
      const target = Math.max(0, Math.min(i, events.length));
      for (let k = 0; k < target; k++) fastPaint(events[k].idx, events[k].color);
      cursor = target;
      if (!cancelled) setCursor(target);
      if (playing) {
        if (target >= events.length) {
          playing = false;
          setStatusSafe("done");
        } else step();
      }
    };

    const restart = () => {
      if (timer) clearTimeout(timer);
      clearCanvas();
      cursor = 0;
      if (!cancelled) setCursor(0);
      play();
    };

    controlsRef.current = { play, pause, seek, restart, setSpeed: n => (speedFactor = n) };

    // 挂载流程：清画布 → 定位部署块 → 分页拉全量事件 → 自动开播
    (async () => {
      clearCanvas();
      try {
        const latest = await publicClient.getBlockNumber();
        const from = await findDeployBlock(publicClient, contractInfo.address, latest);
        for (let s = from; s <= latest && !cancelled; s += PAGE_BLOCKS) {
          const e = s + PAGE_BLOCKS - 1n > latest ? latest : s + PAGE_BLOCKS - 1n;
          const logs = (await publicClient.getContractEvents({
            address: contractInfo.address,
            abi: contractInfo.abi,
            eventName: "PixelPlaced",
            fromBlock: s,
            toBlock: e,
          })) as { args: { idx?: unknown; color?: unknown; placedAt?: unknown } }[];
          for (const log of logs) {
            // 块序天然时间序（同块内 placedAt 相同），无需再排序
            events.push({
              idx: Number(log.args.idx ?? 0),
              color: Number(log.args.color ?? 0),
              placedAt: Number(log.args.placedAt ?? 0),
            });
          }
          if (!cancelled) {
            setTotal(events.length);
            setLoadText(`已拉取 ${events.length} 笔 · 扫描到块 ${e}`);
          }
        }
        if (cancelled) return;
        if (events.length === 0) {
          setStatusSafe("done");
          return;
        }
        play();
      } catch {
        if (!cancelled) setLoadText("拉取失败（RPC 限流），请刷新重试");
      }
    })();

    return () => {
      cancelled = true;
      playing = false;
      if (timer) clearTimeout(timer);
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, contractInfo?.address]);

  const changeSpeed = (n: number) => {
    setSpeed(n); // UI 镜像
    controlsRef.current?.setSpeed(n); // 调度真值，下一帧延迟即按新倍速计算
  };

  return (
    <div className="absolute left-1/2 -translate-x-1/2 bottom-4 z-30 flex items-center gap-3 px-4 py-2 rounded-full bg-mp-surface/80 text-sm whitespace-nowrap">
      {status === "loading" ? (
        <span className="animate-pulse text-mp-muted">⏪ {loadText}</span>
      ) : (
        <>
          {status === "playing" ? (
            <button onClick={() => controlsRef.current?.pause()} className="text-lg cursor-pointer" aria-label="暂停">
              ⏸
            </button>
          ) : (
            <button onClick={() => controlsRef.current?.play()} className="text-lg cursor-pointer" aria-label="播放">
              ▶
            </button>
          )}
          <input
            type="range"
            min={0}
            max={Math.max(total - 1, 0)}
            value={cursor}
            onChange={e => controlsRef.current?.seek(Number(e.target.value))}
            className="w-56 accent-mp-accent cursor-pointer"
            aria-label="回放进度"
          />
          <span className="tabular-nums text-mp-muted">
            {cursor}/{total}
          </span>
          <span className="flex gap-2">
            {SPEEDS.map(s => (
              <button
                key={s}
                onClick={() => changeSpeed(s)}
                className={`cursor-pointer ${speed === s ? "text-mp-gold font-bold" : "text-mp-muted"}`}
              >
                {s}x
              </button>
            ))}
          </span>
          {status === "done" && (
            <button onClick={() => controlsRef.current?.restart()} className="cursor-pointer text-mp-accent">
              ⏪ 重播
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default ReplayEngine;
