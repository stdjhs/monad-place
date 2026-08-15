"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
  // 入场态（M5）：终局时间戳，用于 live/expired/sealed 顶条
  const { data: endAt } = useScaffoldReadContract({ contractName: "PlaceCanvas", functionName: "endAt" });
  // 渲染期不可调用 Date.now()（React Compiler 纯函数规则）：用每秒 tick 的 state 驱动过期判定
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const expired = !isSealed && endAt !== undefined && nowTs / 1000 > Number(endAt);
  // 主持人（部署者）判定：仅 owner 钱包能看到封盘按钮
  const { data: owner } = useScaffoldReadContract({ contractName: "PlaceCanvas", functionName: "owner" });
  const isHost = !!address && !!owner && address.toLowerCase() === String(owner).toLowerCase();

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "PlaceCanvas" });

  const [team, setTeam] = useState<1 | 2>(1);
  const [color, setColor] = useState(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("选择阵营开始");
  const [cdLeft, setCdLeft] = useState(0);
  const [confirmSeal, setConfirmSeal] = useState(false); // M3：封盘两步确认弹层

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
      // 状态矩阵补齐（M2-play）：每类失败给出明确可行动文案（带图标=非颜色线索）
      setStatus(
        m.includes("Cooldown")
          ? "⏳ 冷却中，稍等…"
          : m.includes("SameColor")
            ? "🎨 这个格子已是该颜色，换一格或换色"
            : m.includes("NotLive")
              ? "🏁 比赛已结束"
              : /rejected|denied|cancel/i.test(m)
                ? "↩️ 已取消，随时可以重新落子"
                : /timeout|network|fetch|ECONN/i.test(m)
                  ? "📡 网络波动，请重试…"
                  : "⚠️ 失败：" + m.slice(0, 60),
      );
    }
    setBusy(false);
  };

  // 主持人终局：两步确认（B 轨 /host 交互设计）→ 确认后才发交易（不可逆操作的仪式感）
  const sealGame = async () => {
    setConfirmSeal(false);
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
    <main className="flex flex-col items-center pt-4 pb-8 px-3 min-h-screen bg-mp-bg text-mp-fg">
      {/* M5 入场态顶条：live / expired / sealed（图标=非颜色线索；原型 Entry 状态条样式） */}
      <div
        className={`w-full max-w-2xl text-center text-sm py-1.5 rounded-full mb-1 border ${
          isSealed ? "mp-panel text-mp-muted" : expired ? "mp-panel text-mp-gold" : "mp-panel text-mp-ok"
        }`}
      >
        {isSealed ? "🏁 已封盘 · 指纹已上链" : expired ? "⏰ 比赛时间已到" : "🟢 战斗进行中 · 扫码即参战"}
      </div>
      <h1 className="text-2xl font-bold font-display mt-1">
        Monad Place <span className="text-mp-accent">紫晶</span> vs <span className="text-mp-gold">黄金</span>
      </h1>

      {/* 阵营选择（原型 team-selector：面板化 + 8px 控件圆角 + 100ms 反馈） */}
      <div className="mp-panel flex gap-3 mt-3 px-4 py-3">
        <button
          className={`mp-btn mp-touch px-4 text-sm font-bold border ${
            team === 1 ? "bg-mp-accent text-white border-transparent" : "border-white/15 text-mp-muted"
          }`}
          onClick={() => {
            setTeam(1);
            setColor(1);
          }}
        >
          🟣 紫晶军团
        </button>
        <button
          className={`mp-btn mp-touch px-4 text-sm font-bold border ${
            team === 2 ? "bg-mp-gold text-mp-bg border-transparent" : "border-white/15 text-mp-muted"
          }`}
          onClick={() => {
            setTeam(2);
            setColor(9);
          }}
        >
          🟡 黄金部落
        </button>
      </div>

      {/* 当前阵营调色板（原型 color-palette：44px 触控 + 8px 圆角） */}
      <div className="mp-panel flex gap-2 mt-3 px-4 py-3 flex-wrap justify-center">
        {colors.map(c => (
          <button
            key={c}
            aria-label={`颜色 ${c}`}
            onClick={() => setColor(c)}
            className={`mp-btn w-11 h-11 border-2 ${color === c ? "border-white scale-110" : "border-transparent"}`}
            style={{ backgroundColor: PALETTE[c] ?? EMPTY_COLOR }}
          />
        ))}
      </div>

      {/* 画布：点击落子，每格 = 1 笔交易（原型 canvas 近黑专属底 --canvas-bg） */}
      <div className="mp-panel p-2 w-full max-w-2xl mt-4">
        <canvas
          ref={canvasRef}
          width={BOARD_WIDTH * CELL}
          height={BOARD_HEIGHT * CELL}
          onClick={onCanvasClick}
          className="w-full rounded-lg cursor-crosshair"
          style={{
            aspectRatio: "64/36",
            imageRendering: "pixelated",
            background: EMPTY_COLOR,
            touchAction: "manipulation",
          }}
        />
      </div>

      {/* 状态行：冷却期显示 radial-progress 环形进度（daisyui），其余显示文字状态 */}
      <div className="mp-panel mt-3 min-h-14 px-4 py-2 flex flex-col items-center justify-center gap-2 text-sm w-full max-w-2xl">
        {isSealed ? (
          <span>🏁 比赛已封盘，画布指纹已上链</span>
        ) : cdLeft > 0 ? (
          <span className="flex items-center gap-2">
            <span
              className="radial-progress text-violet-500"
              style={
                {
                  "--value": Math.round((1 - cdLeft / Math.max(Number(cooldownSeconds ?? 3), 1)) * 100),
                  "--size": "2.2rem",
                  "--thickness": "3px",
                } as CSSProperties
              }
              role="progressbar"
              aria-valuenow={cdLeft}
            >
              {cdLeft}
            </span>
            冷却中…
          </span>
        ) : (
          <span>{status}</span>
        )}
        {/* 观看模式入口：大屏投影页（合唱 / 并行仪表 / 回放都在那里） */}
        <a
          href="/stage"
          target="_blank"
          rel="noreferrer"
          className="mp-btn text-xs text-mp-muted border border-white/15 px-3 py-1.5 font-bold"
        >
          📺 观看大屏模式
        </a>
      </div>
      {isHost && !isSealed && (
        <button
          className="mp-btn mp-touch mt-2 px-5 text-sm font-bold text-white bg-red-600 border border-red-400/40"
          onClick={() => setConfirmSeal(true)}
          disabled={busy}
        >
          🏁 主持人封盘
        </button>
      )}

      {/* M3 两步确认弹层（B 轨 /host 设计：不可逆操作的仪式感） */}
      {confirmSeal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="确认封盘"
        >
          <div className="mp-panel p-6 max-w-sm w-full text-center">
            <h2 className="text-lg font-bold mb-2">冻结整幅画布？</h2>
            <p className="text-sm opacity-80 mb-1">
              seal() <b>不可逆</b>：将停止一切落子，并对当前 2304 格生成永久 keccak256 链上指纹。
            </p>
            <p className="text-xs opacity-60 mb-5">建议在 Demo 终局时刻、主持人喊停后执行。</p>
            <div className="flex gap-3 justify-center">
              <button className="btn btn-sm btn-outline mp-touch" onClick={() => setConfirmSeal(false)}>
                再想想
              </button>
              <button className="btn btn-sm btn-error mp-touch" onClick={sealGame} disabled={busy}>
                {busy ? "封盘中…" : "确认封盘"}
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="text-xs opacity-60 mt-1 text-center">每次落子 = 1 笔真实 Monad 测试网交易 · 冷却由智能合约强制</p>
    </main>
  );
};

export default Play;
