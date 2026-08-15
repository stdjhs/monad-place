"use client";

import { useEffect, useRef, useState } from "react";
import type { NextPage } from "next";
import { parseGwei } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import {
  useDeployedContractInfo,
  useScaffoldReadContract,
  useScaffoldWatchContractEvent,
  useScaffoldWriteContract,
} from "~~/hooks/scaffold-eth";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  EMPTY_COLOR,
  MONAD_GAS_PRICE_GWEI,
  PALETTE,
  TEAM1_COLORS,
  TEAM2_COLORS,
} from "~~/utils/monad-place";

// 观众端：连钱包 → 选阵营 → 选颜色 → 点画布落子（每次落子 = 1 笔真实 Monad 交易）
const Play: NextPage = () => {
  const { address, isConnected } = useAccount();
  const { data: contractInfo, isLoading: loadingContract } = useDeployedContractInfo({ contractName: "PlaceCanvas" });
  const publicClient = usePublicClient();

  const { data: cooldownSeconds } = useScaffoldReadContract({
    contractName: "PlaceCanvas",
    functionName: "cooldownSeconds",
  });
  const { data: isSealed } = useScaffoldReadContract({
    contractName: "PlaceCanvas",
    functionName: "isSealed",
  });
  // 主持人（部署者）判定：仅 owner 钱包能看到封盘按钮
  const { data: owner } = useScaffoldReadContract({ contractName: "PlaceCanvas", functionName: "owner" });
  const isHost = !!address && !!owner && address.toLowerCase() === String(owner).toLowerCase();

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "PlaceCanvas" });

  const [team, setTeam] = useState<1 | 2>(1);
  const [color, setColor] = useState(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("选择阵营开始");
  const [cdLeft, setCdLeft] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 本地画布状态（Uint8Array 与链上 pixels 对齐，冷启动 + 事件流维护）
  const gridRef = useRef(new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT));

  const CELL = 12; // 位图分辨率 768x432，CSS 拉伸显示

  const paintCell = (idx: number, c: number) => {
    gridRef.current[idx] = c;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const x = idx % BOARD_WIDTH;
    const y = Math.floor(idx / BOARD_WIDTH);
    ctx.fillStyle = PALETTE[c] ?? EMPTY_COLOR;
    ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
  };

  // 冷启动：36 行并行拉取（Promise.all，出图 ~3s）
  useEffect(() => {
    if (!publicClient || !contractInfo) return;
    (async () => {
      const ctx = canvasRef.current?.getContext("2d");
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
        for (let x = 0; x < BOARD_WIDTH; x++) if (row[x]) paintCell(y * BOARD_WIDTH + x, Number(row[x]));
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, contractInfo?.address]);

  // 实时事件：其他玩家的落子同步到本地画布
  useScaffoldWatchContractEvent({
    contractName: "PlaceCanvas",
    eventName: "PixelPlaced",
    onLogs: logs => {
      for (const log of logs) {
        paintCell(Number(log.args.idx ?? 0), Number(log.args.color ?? 0));
      }
    },
  });

  const onCanvasClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isConnected) {
      setStatus("请先连接钱包");
      return;
    }
    if (isSealed || busy) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(BOARD_WIDTH - 1, Math.floor(((e.clientX - rect.left) / rect.width) * BOARD_WIDTH));
    const y = Math.min(BOARD_HEIGHT - 1, Math.floor(((e.clientY - rect.top) / rect.height) * BOARD_HEIGHT));

    setBusy(true);
    setStatus(`落子 (${x},${y}) 交易发送中…`);
    try {
      // 显式 gasPrice ≥ 50 gwei（Monad 测试网官方要求）
      await writeContractAsync({
        functionName: "place",
        args: [x, y, color],
        gasPrice: parseGwei(MONAD_GAS_PRICE_GWEI.toString()),
      });
      setStatus("✅ 落子成功！");
      const cd = Number(cooldownSeconds ?? 3);
      setCdLeft(cd);
      const t = setInterval(() => {
        setCdLeft(left => {
          if (left <= 1) {
            clearInterval(t);
            return 0;
          }
          return left - 1;
        });
      }, 1000);
    } catch (err) {
      const m = String((err as Error)?.message ?? err);
      setStatus(
        m.includes("Cooldown")
          ? "冷却中，稍等…"
          : m.includes("SameColor")
            ? "同色已占用"
            : m.includes("NotLive")
              ? "比赛已结束"
              : "失败：" + m.slice(0, 60),
      );
    }
    setBusy(false);
  };

  // 主持人终局：封盘冻结画布并生成链上指纹（仅部署者钱包可见此按钮）
  const sealGame = async () => {
    if (busy) return;
    setBusy(true);
    setStatus("封盘中…（整幅画布 keccak256 指纹计算 ≈5.6M gas，请稍候）");
    try {
      await writeContractAsync({
        functionName: "seal",
        gasPrice: parseGwei(MONAD_GAS_PRICE_GWEI.toString()),
        // seal ≈5.65M gas（canvasHash 遍历 2304 格），显式给足防止钱包低估（审计 L1）；viem 参数名为 gas
        gas: 7_000_000n,
      });
      setStatus("🏁 已封盘，画布指纹永久上链");
    } catch (err) {
      const m = String((err as Error)?.message ?? err);
      setStatus("封盘失败：" + m.slice(0, 60));
    }
    setBusy(false);
  };

  const colors = team === 1 ? TEAM1_COLORS : TEAM2_COLORS;

  if (loadingContract) return <main className="flex items-center justify-center min-h-screen">加载合约信息…</main>;
  if (!contractInfo)
    return (
      <main className="flex items-center justify-center min-h-screen text-center px-6">
        合约尚未部署：请先运行 <code className="mx-1 px-1 bg-base-300 rounded">yarn deploy</code>
      </main>
    );

  return (
    <main className="flex flex-col items-center pt-4 pb-8 px-3 min-h-screen">
      <h1 className="text-2xl font-bold">
        Monad Place <span className="text-violet-500">紫晶</span> vs <span className="text-amber-500">黄金</span>
      </h1>

      {/* 阵营选择 */}
      <div className="flex gap-3 mt-3">
        <button
          className={`btn btn-sm ${team === 1 ? "btn-primary" : "btn-outline"}`}
          onClick={() => {
            setTeam(1);
            setColor(1);
          }}
        >
          🟣 紫晶军团
        </button>
        <button
          className={`btn btn-sm ${team === 2 ? "btn-warning" : "btn-outline"}`}
          onClick={() => {
            setTeam(2);
            setColor(9);
          }}
        >
          🟡 黄金部落
        </button>
      </div>

      {/* 当前阵营调色板 */}
      <div className="flex gap-1.5 mt-3 flex-wrap justify-center">
        {colors.map(c => (
          <button
            key={c}
            aria-label={`颜色 ${c}`}
            onClick={() => setColor(c)}
            className={`w-9 h-9 rounded-md border-2 ${color === c ? "border-white scale-110" : "border-transparent"}`}
            style={{ backgroundColor: PALETTE[c] ?? EMPTY_COLOR }}
          />
        ))}
      </div>

      {/* 画布：点击落子，每格 = 1 笔交易 */}
      <canvas
        ref={canvasRef}
        width={BOARD_WIDTH * CELL}
        height={BOARD_HEIGHT * CELL}
        onClick={onCanvasClick}
        className="w-full max-w-2xl mt-4 rounded-lg cursor-crosshair"
        style={{
          aspectRatio: "64/36",
          imageRendering: "pixelated",
          background: EMPTY_COLOR,
          touchAction: "manipulation",
        }}
      />

      <p className="mt-3 h-6 text-sm">
        {isSealed ? "🏁 比赛已封盘，画布指纹已上链" : cdLeft > 0 ? `⏳ 冷却 ${cdLeft}s` : status}
      </p>
      {isHost && !isSealed && (
        <button className="btn btn-error btn-sm mt-2" onClick={sealGame} disabled={busy}>
          🏁 主持人封盘
        </button>
      )}
      <p className="text-xs opacity-60 mt-1 text-center">每次落子 = 1 笔真实 Monad 测试网交易 · 冷却由智能合约强制</p>
    </main>
  );
};

export default Play;
