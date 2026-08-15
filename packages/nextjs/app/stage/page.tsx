"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NextPage } from "next";
import { decodeEventLog, parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import MassChorus from "~~/components/monad-place/MassChorus";
import ParallelMeter from "~~/components/monad-place/ParallelMeter";
import type { ParallelStats } from "~~/components/monad-place/ParallelMeter";
import ReplayEngine from "~~/components/monad-place/ReplayEngine";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWatchContractEvent } from "~~/hooks/scaffold-eth";
import { BOARD_HEIGHT, BOARD_WIDTH, EMPTY_COLOR, PALETTE, playNote } from "~~/utils/monad-place";

type Ripple = { x: number; y: number; t: number; color: number };

// 大屏端（投影用）：像素层 + 特效层双层画布（涟漪不留残影）+ 五声音阶 + TPS 仪表 + 阵营比分 + 排行榜 + 封盘横幅 + 入场二维码
// 只读无需钱包；比分/统计以链上数据为准（每秒轮询，杜绝本地计数漂移）
const Stage: NextPage = () => {
  const { data: contractInfo } = useDeployedContractInfo({ contractName: "PlaceCanvas" });
  const publicClient = usePublicClient();

  // 链上真值：阵营比分 / 总交易 / 玩家数（SE2 read hooks 按 pollingInterval 自动轮询）
  const { data: t1 } = useScaffoldReadContract({ contractName: "PlaceCanvas", functionName: "teamPixels", args: [1] });
  const { data: t2 } = useScaffoldReadContract({ contractName: "PlaceCanvas", functionName: "teamPixels", args: [2] });
  const { data: totalPlaced } = useScaffoldReadContract({ contractName: "PlaceCanvas", functionName: "totalPlaced" });
  const { data: uniquePlayers } = useScaffoldReadContract({
    contractName: "PlaceCanvas",
    functionName: "uniquePlayers",
  });

  // 本地实时数据：TPS（5s 滑动窗口）与排行榜（placedCount 只增不减，无漂移问题）
  const recentRef = useRef<number[]>([]);
  const topRef = useRef<Record<string, number>>({});
  const [tps, setTps] = useState(0);
  const [top5, setTop5] = useState<[string, number][]>([]);
  const [sealed, setSealed] = useState<{ hash: string; total: string; players: string } | null>(null);

  // P-C 回放模式：?replay=1 进入（ref+state 双轨：ref 供下方各实时 effect 守卫，state 供渲染）
  const [replayMode, setReplayMode] = useState(false);
  const replayRef = useRef(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("replay") === "1") {
      replayRef.current = true;
      setReplayMode(true);
    }
  }, []);

  const baseRef = useRef<HTMLCanvasElement>(null); // 像素层
  const fxRef = useRef<HTMLCanvasElement>(null); // 特效层（涟漪，每帧清空重画）
  const gridRef = useRef(new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT));
  const ripplesRef = useRef<Ripple[]>([]);
  const CELL = 12;

  const paintCell = (idx: number, c: number, ripple = true) => {
    gridRef.current[idx] = c;
    const ctx = baseRef.current?.getContext("2d");
    if (!ctx) return;
    const x = (idx % BOARD_WIDTH) * CELL;
    const y = Math.floor(idx / BOARD_WIDTH) * CELL;
    ctx.fillStyle = PALETTE[c] ?? EMPTY_COLOR;
    ctx.fillRect(x, y, CELL, CELL);
    if (ripple) ripplesRef.current.push({ x: x + CELL / 2, y: y + CELL / 2, t: performance.now(), color: c });
  };

  // P-C 回放回调：正常帧 = 涟漪 + 音符（40ms 节流防倍速下爆音墙）+ TPS 重现
  const lastNoteRef = useRef(0);
  const replayEvent = (idx: number, c: number) => {
    paintCell(idx, c, true);
    const now = Date.now();
    if (now - lastNoteRef.current > 40) {
      playNote(c);
      lastNoteRef.current = now;
    }
    recentRef.current.push(now);
    recentRef.current = recentRef.current.filter(t => now - t < 5000);
    setTps(recentRef.current.length / 5);
  };
  // 回放 seek 快进：只画像素（无特效无音，几万帧也不卡）
  const fastPaint = (idx: number, c: number) => paintCell(idx, c, false);
  // 回放重置：清空画布回到空白
  const clearCanvas = () => {
    const ctx = baseRef.current?.getContext("2d");
    if (ctx) {
      ctx.fillStyle = EMPTY_COLOR;
      ctx.fillRect(0, 0, BOARD_WIDTH * CELL, BOARD_HEIGHT * CELL);
    }
  };

  // 冷启动：36 行并行拉取链上全量画布（Promise.all，全量出图 ~3s）；回放模式自带冷启动（从空白重演）
  useEffect(() => {
    if (replayRef.current) return;
    if (!publicClient || !contractInfo) return;
    (async () => {
      const ctx = baseRef.current?.getContext("2d");
      if (ctx) {
        ctx.fillStyle = EMPTY_COLOR;
        ctx.fillRect(0, 0, BOARD_WIDTH * CELL, BOARD_HEIGHT * CELL);
      }
      const rows = (await Promise.all(
        Array.from({ length: BOARD_HEIGHT }, (_, y) =>
          publicClient.readContract({
            address: contractInfo.address,
            abi: contractInfo.abi,
            functionName: "getRow",
            args: [y],
          }),
        ),
      )) as (readonly number[])[];
      rows.forEach((row, y) => {
        for (let x = 0; x < BOARD_WIDTH; x++) if (row[x]) paintCell(y * BOARD_WIDTH + x, Number(row[x]), false);
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, contractInfo?.address]);

  // 对账补拉：每 2s 核对块高，遗漏区间按 100 块窗口补像素
  // （官方公共 RPC eth_getLogs 限 100 块/次；断线重连后大跨度必须分页，否则 -32602 假死）
  // 同一循环顺带采集 P-A 并行仪表数据：本合约每块聚类 + 整链块吞吐，无额外请求负担
  const lastBlockRef = useRef(0n);
  const perBlockMapRef = useRef(new Map<bigint, number>()); // 块高 → 本合约该块落子数
  const chainTxRef = useRef<number | null>(null); // 最新采样块的全网交易数
  const [parallelStats, setParallelStats] = useState<ParallelStats>({ concurrent: 0, perBlock: [], chainTx: null });
  useEffect(() => {
    if (replayRef.current) return; // 回放模式不跑实时对账
    if (!publicClient || !contractInfo) return;
    let stop = false;

    // 整链块吞吐：官方推荐 eth_getBlockReceipts 批量法；RPC 不支持时回退全交易块计数（本地链冒烟兼容）
    const sampleChainThroughput = async (bn: bigint) => {
      try {
        chainTxRef.current = (await publicClient.getBlockReceipts({ blockNumber: bn })).length;
      } catch {
        try {
          const blk = await publicClient.getBlock({ blockNumber: bn, includeTransactions: true });
          chainTxRef.current = blk.transactions.length;
        } catch {
          // 双法皆败：保持上一采样值
        }
      }
    };

    const tick = async () => {
      try {
        const bn = await publicClient.getBlockNumber();
        void sampleChainThroughput(bn);
        if (lastBlockRef.current === 0n) {
          lastBlockRef.current = bn; // 首轮只建基线
          return;
        }
        for (let s = lastBlockRef.current + 1n; s <= bn; s += 100n) {
          const e = s + 99n > bn ? bn : s + 99n;
          const logs = (await publicClient.getContractEvents({
            address: contractInfo.address,
            abi: contractInfo.abi,
            eventName: "PixelPlaced",
            fromBlock: s,
            toBlock: e,
          })) as { args: { idx?: unknown; color?: unknown }; blockNumber: bigint | null }[];
          // 只补像素不重复计 TPS/排行（实时通道已计过；paintCell 幂等）；
          // 同时按块聚类给并行仪表（聚类与 lastBlockRef 同步推进，窗口不重叠故不重复计数）
          logs.forEach(log => {
            paintCell(Number(log.args.idx ?? 0), Number(log.args.color ?? 0), false);
            if (log.blockNumber !== null) {
              perBlockMapRef.current.set(log.blockNumber, (perBlockMapRef.current.get(log.blockNumber) ?? 0) + 1);
            }
          });
          lastBlockRef.current = e;
        }
        // 输出并行仪表快照：修剪旧块后取最近 20 个有事件块 + 最新整链采样
        const entries = Array.from(perBlockMapRef.current.entries()).sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
        );
        for (let i = 0; i < entries.length - 20; i++) perBlockMapRef.current.delete(entries[i][0]);
        const perBlock = entries.slice(-20).map(([, n]) => n);
        setParallelStats({
          concurrent: perBlock.length > 0 ? perBlock[perBlock.length - 1] : 0,
          perBlock,
          chainTx: chainTxRef.current,
        });
      } catch {
        // RPC 抖动：跳过本轮，2s 后重试
      }
    };
    const id = setInterval(() => {
      if (!stop) void tick();
    }, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, contractInfo?.address]);

  // 实时通道①（主）：Monad 专属 monadLogs WebSocket 订阅——Proposed 即推，比标准确认早约 1 秒
  // 实现用浏览器原生 WebSocket + eth_subscribe + viem decodeEventLog（不依赖 viem 的 subscribeLogs 类型）
  // 断开自动重连（3s），期间 wsActiveRef=false → 下方 polling 通道接管（防 TPS 双计）
  const wsActiveRef = useRef(false);
  const [wsActive, setWsActive] = useState(false); // 徽标渲染态：⚡实时 / ↻轮询
  useEffect(() => {
    if (replayRef.current) return; // 回放模式不开实时 WS
    if (!contractInfo) return;
    const PIXEL_EVENT = parseAbiItem(
      "event PixelPlaced(address indexed user, uint256 indexed idx, uint8 color, uint8 team, uint256 placedAt)",
    );
    let ws: WebSocket | undefined;
    let subId: string | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const handleLog = (raw: { data?: `0x${string}`; topics?: `0x${string}`[] }) => {
      try {
        const topics = raw.topics ?? [];
        if (topics.length === 0) return;
        const decoded = decodeEventLog({
          abi: [PIXEL_EVENT],
          data: raw.data ?? "0x",
          topics: [topics[0], ...topics.slice(1)],
        });
        if (decoded.eventName !== "PixelPlaced") return;
        const a = decoded.args as { user?: unknown; idx?: unknown; color?: unknown };
        wsActiveRef.current = true;
        setWsActive(true);
        const now = Date.now();
        const user = String(a.user ?? "0x0");
        const idx = Number(a.idx ?? 0);
        const c = Number(a.color ?? 0);
        paintCell(idx, c);
        playNote(c);
        recentRef.current.push(now);
        topRef.current[user] = (topRef.current[user] ?? 0) + 1;
        recentRef.current = recentRef.current.filter(t => now - t < 5000);
        setTps(recentRef.current.length / 5);
        setTop5(
          Object.entries(topRef.current)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5),
        );
      } catch {
        // 单帧解码失败忽略
      }
    };

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket("wss://testnet-rpc.monad.xyz");
        ws.onopen = () =>
          ws?.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_subscribe",
              // monadLogs：Monad 专属订阅类型（投机执行，Proposed 即推）
              params: ["monadLogs", { address: contractInfo.address }],
            }),
          );
        ws.onmessage = ev => {
          try {
            const msg = JSON.parse(ev.data as string) as {
              id?: number;
              result?: string;
              method?: string;
              params?: { subscription?: string; result?: { data?: `0x${string}`; topics?: `0x${string}`[] } };
            };
            if (msg.id === 1 && msg.result) {
              subId = msg.result;
            } else {
              const p = msg.params;
              if (msg.method === "eth_subscription" && p && p.subscription === subId && p.result) {
                handleLog(p.result);
              }
            }
          } catch {
            // 非 JSON 帧忽略
          }
        };
        ws.onclose = () => {
          wsActiveRef.current = false;
          setWsActive(false);
          if (!closed) retryTimer = setTimeout(connect, 3000);
        };
        ws.onerror = () => ws?.close();
      } catch {
        wsActiveRef.current = false;
        setWsActive(false);
      }
    };
    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      wsActiveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractInfo?.address]);

  // 实时通道②（备）：SE2 polling watch——WS 激活时静默，断开时接管（防 TPS 双计）
  useScaffoldWatchContractEvent({
    contractName: "PlaceCanvas",
    eventName: "PixelPlaced",
    onLogs: logs => {
      if (replayRef.current) return; // 回放模式不混入实时事件
      if (wsActiveRef.current) return;
      const now = Date.now();
      for (const log of logs) {
        const user = String(log.args.user ?? "0x0");
        const idx = Number(log.args.idx ?? 0);
        const c = Number(log.args.color ?? 0);
        paintCell(idx, c);
        playNote(c);
        recentRef.current.push(now);
        topRef.current[user] = (topRef.current[user] ?? 0) + 1;
      }
      recentRef.current = recentRef.current.filter(t => now - t < 5000);
      setTps(recentRef.current.length / 5);
      setTop5(
        Object.entries(topRef.current)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5),
      );
    },
  });

  // 终局封盘横幅
  useScaffoldWatchContractEvent({
    contractName: "PlaceCanvas",
    eventName: "CanvasSealed",
    onLogs: logs => {
      if (replayRef.current) return; // 回放模式不弹实时封盘横幅
      for (const log of logs) {
        setSealed({
          hash: String(log.args.canvasHash ?? ""),
          total: String(log.args.totalPlaced ?? "0"),
          players: String(log.args.uniquePlayers ?? "0"),
        });
      }
    },
  });

  // 涟漪动画：特效层每帧清空重画，不污染像素层
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const ctx = fxRef.current?.getContext("2d");
      if (ctx) {
        const now = performance.now();
        ctx.clearRect(0, 0, BOARD_WIDTH * CELL, BOARD_HEIGHT * CELL);
        const rs = ripplesRef.current;
        for (let i = rs.length - 1; i >= 0; i--) {
          const r = rs[i];
          const age = now - r.t;
          if (age > 450) {
            rs.splice(i, 1);
            continue;
          }
          ctx.strokeStyle = PALETTE[r.color] ?? "#fff";
          ctx.globalAlpha = 1 - age / 450;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(r.x, r.y, age / 4, 0, 7);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 入场二维码（公网部署后自动指向 /play；生成失败时 URL 文本兜底）
  const [playUrl, setPlayUrl] = useState("");
  const [qrOk, setQrOk] = useState(true);
  useEffect(() => setPlayUrl(new URL("/play", window.location.origin).href), []);
  const qrSrc = useMemo(
    () =>
      playUrl ? `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(playUrl)}` : "",
    [playUrl],
  );

  if (!contractInfo)
    return (
      <main className="flex items-center justify-center min-h-screen text-lg">合约尚未部署：请先 yarn deploy</main>
    );

  return (
    <main className="flex flex-col h-screen bg-[#05060f] text-[#e2e8f0] overflow-hidden">
      {/* HUD：比分与统计直接读链上真值 */}
      <div className="flex items-center gap-6 px-6 py-3 bg-[#0b0e1d] border-b border-[#1e2440] text-xl shrink-0">
        <span>
          紫晶军团 <b className="text-[#a78bfa] text-2xl">{t1?.toString() ?? "0"}</b>
        </span>
        <span>
          黄金部落 <b className="text-[#fbbf24] text-2xl">{t2?.toString() ?? "0"}</b>
        </span>
        <span>
          总交易 <b className="text-2xl">{totalPlaced?.toString() ?? "0"}</b>
        </span>
        <span>
          玩家 <b className="text-2xl">{uniquePlayers?.toString() ?? "0"}</b>
        </span>
        {/* WS 徽标：monadLogs 投机订阅激活=⚡实时；断连降级 polling=↻轮询 */}
        <span className={`ml-auto text-base font-bold ${wsActive ? "text-[#34d399]" : "text-[#fbbf24]"}`}>
          {wsActive ? "⚡实时" : "↻轮询"}
        </span>
        <span className="text-2xl text-[#34d399]">TPS {tps.toFixed(1)}</span>
        {/* P-A 并行仪表：同块并发 + 整链块吞吐 + 本合约最近 20 块迷你柱状图（数据来自对账循环） */}
        <ParallelMeter stats={parallelStats} />
        <span className="text-base text-[#94a3b8]">扫码参战 → {playUrl}</span>
        {/* P-C 回放入口：isSealed 后高亮（终局回放 = L3 数据服务演示）；回放模式下变退出 */}
        {replayMode ? (
          <button
            onClick={() => {
              window.location.href = "/stage";
            }}
            className="px-3 py-1 rounded border border-[#fbbf24] text-[#fbbf24] text-base font-bold cursor-pointer"
          >
            ↩ 退出回放
          </button>
        ) : (
          <button
            onClick={() => {
              window.location.href = "/stage?replay=1";
            }}
            className={`px-3 py-1 rounded border text-base font-bold cursor-pointer ${
              sealed ? "border-[#fbbf24] text-[#fbbf24]" : "border-[#1e2440] text-[#94a3b8]"
            }`}
          >
            ⏪ 回放
          </button>
        )}
      </div>

      {/* 双层画布：像素层(底) + 特效层(涟漪，覆盖) */}
      <div className="relative flex-1 flex items-center justify-center min-h-0">
        <div className="relative" style={{ aspectRatio: "64/36", width: "min(100%, calc((100vh - 90px) * 16 / 9))" }}>
          <canvas
            ref={baseRef}
            width={BOARD_WIDTH * CELL}
            height={BOARD_HEIGHT * CELL}
            className="w-full h-full"
            style={{ imageRendering: "pixelated", boxShadow: "0 0 60px #000a" }}
          />
          <canvas
            ref={fxRef}
            width={BOARD_WIDTH * CELL}
            height={BOARD_HEIGHT * CELL}
            className="absolute inset-0 w-full h-full"
          />
        </div>

        {/* 封盘横幅 */}
        {sealed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#05060fd9] text-center">
            <h1 className="text-5xl font-bold">🏁 画布已上链</h1>
            <p className="mt-4 font-mono text-xl text-[#34d399] break-all max-w-[80%]">{sealed.hash}</p>
            <p className="mt-3 text-xl">
              {sealed.players} 名玩家 · {sealed.total} 笔交易 · 永久上链
            </p>
          </div>
        )}

        {/* 入场二维码 */}
        {qrOk && qrSrc && (
          <div className="absolute left-4 bottom-4 bg-white p-2 rounded-lg text-center">
            {/* 二维码为运行时生成的 data URL，next/image 无法优化，豁免 no-img-element 规则 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrSrc} alt="扫码参战二维码" width={160} height={160} onError={() => setQrOk(false)} />
            <span className="block text-[#0b0e1d] text-sm font-semibold pt-1">📱 扫码参战</span>
          </div>
        )}

        {/* 排行榜（回放模式隐藏：实时排行数据在回放中不更新） */}
        {!replayMode && top5.length > 0 && (
          <div className="absolute right-4 bottom-4 bg-[#0b0e1dcc] px-4 py-3 rounded-lg text-base">
            <b>🏅 排行榜</b>
            {top5.map(([addr, n], i) => (
              <div key={addr}>
                {i + 1}. {addr.slice(0, 8)}… <b>{n}</b>
              </div>
            ))}
          </div>
        )}

        {/* P-B 全场合唱（回放模式隐藏，避免与回放进度条抢交互） */}
        {!replayMode && <MassChorus />}

        {/* P-C 回放引擎：进度条 + 播放/暂停/倍速/重播（回放模式独占） */}
        {replayMode && <ReplayEngine replayEvent={replayEvent} fastPaint={fastPaint} clearCanvas={clearCanvas} />}
      </div>
    </main>
  );
};

export default Stage;
