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

// 用户在钱包里拒绝签名（viem UserRejectedRequestError / MetaMask denied / EIP-1193 错误码 4001）
const isUserRejected = (m: string) =>
  /user rejected|user denied|userrejectedrequesterror|rejected the request|4001/i.test(m);

// RPC / 网络类失败（超时、断连、限流），对应 Play 13 态模型里的 retry
const isRpcFailure = (m: string) =>
  /network|timeout|timed out|fetch failed|http request failed|429|rpc|internal error|econnrefused/i.test(m);

// place() 失败 → 用户文案；图标前缀做非颜色线索（a11y），判定顺序：拒签 → 合约 revert → 网络 → 兜底
const placeErrorCopy = (err: unknown) => {
  const m = String((err as Error)?.message ?? err);
  if (isUserRejected(m)) return "🚫 已取消，随时可以重新落子";
  if (m.includes("SameColor")) return "🎨 这个格子已是该颜色，换一格或换色";
  if (m.includes("Cooldown")) return "❄️ 冷却中，稍等…";
  if (m.includes("NotLive")) return "🛑 比赛已结束";
  if (isRpcFailure(m)) return "📡 网络波动，正在重试…";
  return "❌ 失败：" + m.slice(0, 60);
};

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
  // 比赛自然结束时间（seal 后合约会把它改写为封盘时刻，所以三态判定必须 sealed 优先）
  const { data: endAt } = useScaffoldReadContract({
    contractName: "PlaceCanvas",
    functionName: "endAt",
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
  // 封盘两步确认：第一步弹确认层，确认层里的红色按钮才触发第二步 sealGame
  const [sealConfirmOpen, setSealConfirmOpen] = useState(false);
  // 顶条 expired 判定用的本地时钟（每秒走针）
  const [now, setNow] = useState(() => Date.now());

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

  // 每秒走针：驱动顶条 expired 判定（画布是 canvas 绘制，重渲染不会引起重画）
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ESC 关闭封盘确认层（dialog 键盘语义；busy 发交易中不可关）
  useEffect(() => {
    if (!sealConfirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setSealConfirmOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sealConfirmOpen, busy]);

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
      setStatus(placeErrorCopy(err));
    }
    setBusy(false);
  };

  // 主持人终局·第二步：只有确认层里点过"确认封盘"才会走到这里（seal 不可逆，必须两步确认）
  const sealGame = async () => {
    if (busy) return;
    setSealConfirmOpen(false);
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
      setStatus(
        isUserRejected(m)
          ? "🚫 已取消封盘，画布未受影响"
          : isRpcFailure(m)
            ? "📡 网络波动，封盘未完成，请重新确认"
            : "❌ 封盘失败：" + m.slice(0, 60),
      );
    }
    setBusy(false);
  };

  const colors = team === 1 ? TEAM1_COLORS : TEAM2_COLORS;

  // 顶条三态：sealed > expired（endAt < now 且未 seal）> live；endAt 加载中先按 live，避免闪跳
  const endAtMs = endAt !== undefined && endAt !== null ? Number(endAt) * 1000 : null;
  const phase = isSealed ? "sealed" : endAtMs !== null && now > endAtMs ? "expired" : "live";

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

      {/* 顶条三态：live / expired / sealed，图标 + 文案做非颜色线索（a11y） */}
      <div className="mt-2">
        {phase === "sealed" ? (
          <span className="badge badge-neutral gap-1">🏁 已封盘·指纹已上链</span>
        ) : phase === "expired" ? (
          <span className="badge badge-warning badge-outline gap-1">⏰ 比赛时间已到</span>
        ) : (
          <span className="badge badge-success badge-outline gap-1">🟢 战斗进行中</span>
        )}
      </div>

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

      {/* 状态行：冷却期显示 radial-progress 环形进度（daisyui），其余显示文字状态 */}
      <div className="mt-3 min-h-14 flex flex-col items-center justify-center gap-2 text-sm">
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
        <a href="/stage" target="_blank" rel="noreferrer" className="btn btn-xs btn-outline gap-1">
          📺 观看大屏模式
        </a>
      </div>
      {isHost && !isSealed && (
        <button className="btn btn-error btn-sm mt-2" onClick={() => setSealConfirmOpen(true)} disabled={busy}>
          🏁 主持人封盘
        </button>
      )}

      {/* 封盘第一步：确认层（DaisyUI modal 受控渲染）。只有红色"确认封盘"才进入第二步发 seal 交易 */}
      {sealConfirmOpen && (
        <div
          className="modal modal-open"
          role="dialog"
          aria-modal="true"
          aria-labelledby="seal-confirm-title"
          aria-describedby="seal-confirm-desc"
        >
          <div className="modal-box max-w-sm">
            <h3 id="seal-confirm-title" className="text-lg font-bold">
              ❄️ 冻结整幅画布？
            </h3>
            <p id="seal-confirm-desc" className="py-4 text-sm">
              seal() 不可逆，将生成永久链上指纹
            </p>
            <div className="modal-action">
              <button className="btn btn-sm" onClick={() => setSealConfirmOpen(false)}>
                再想想
              </button>
              <button className="btn btn-sm btn-error" onClick={sealGame}>
                确认封盘
              </button>
            </div>
          </div>
          {/* 点击遮罩 = 再想想（键盘路径：Esc / Tab 聚焦按钮） */}
          <div className="modal-backdrop" onClick={() => setSealConfirmOpen(false)} />
        </div>
      )}
      <p className="text-xs opacity-60 mt-1 text-center">每次落子 = 1 笔真实 Monad 测试网交易 · 冷却由智能合约强制</p>
    </main>
  );
};

export default Play;
