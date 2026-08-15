"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NextPage } from "next";
import { usePublicClient } from "wagmi";
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

  // 冷启动：按行拉取链上全量画布
  useEffect(() => {
    if (!publicClient || !contractInfo) return;
    (async () => {
      const ctx = baseRef.current?.getContext("2d");
      if (ctx) {
        ctx.fillStyle = EMPTY_COLOR;
        ctx.fillRect(0, 0, BOARD_WIDTH * CELL, BOARD_HEIGHT * CELL);
      }
      for (let y = 0; y < BOARD_HEIGHT; y++) {
        const row = (await publicClient.readContract({
          address: contractInfo.address,
          abi: contractInfo.abi,
          functionName: "getRow",
          args: [y],
        })) as readonly number[];
        for (let x = 0; x < BOARD_WIDTH; x++) if (row[x]) paintCell(y * BOARD_WIDTH + x, Number(row[x]), false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, contractInfo?.address]);

  // 实时落子：像素 + 涟漪 + 音符 + TPS/排行榜
  useScaffoldWatchContractEvent({
    contractName: "PlaceCanvas",
    eventName: "PixelPlaced",
    onLogs: logs => {
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
        <span className="ml-auto text-2xl text-[#34d399]">TPS {tps.toFixed(1)}</span>
        <span className="text-base text-[#94a3b8]">扫码参战 → {playUrl}</span>
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
            <img src={qrSrc} alt="扫码参战二维码" width={160} height={160} onError={() => setQrOk(false)} />
            <span className="block text-[#0b0e1d] text-sm font-semibold pt-1">📱 扫码参战</span>
          </div>
        )}

        {/* 排行榜 */}
        {top5.length > 0 && (
          <div className="absolute right-4 bottom-4 bg-[#0b0e1dcc] px-4 py-3 rounded-lg text-base">
            <b>🏅 排行榜</b>
            {top5.map(([addr, n], i) => (
              <div key={addr}>
                {i + 1}. {addr.slice(0, 8)}… <b>{n}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
};

export default Stage;
