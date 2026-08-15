"use client";

import { useEffect, useState } from "react";
import type { NextPage } from "next";
import { decodeEventLog, parseAbiItem, parseEther, parseGwei } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { MONAD_GAS_PRICE_GWEI } from "~~/utils/monad-place";
import { notification } from "~~/utils/scaffold-eth";

// L1 品牌战役创建（03 商业化方案）：主办方付 0.1 测试 MON 场次费，链上创建专属画布战役
// 演示路径：填表 → 付费 → 浏览器显示 CampaignCreated 事件 →「一场商业战役已链上成交」

// ⚠️ stub ABI：A1 的 CampaignFactory 部署产物（deployedContracts）生成前的占位（03 §L1 接口草案）
// 整合点②（16:30）接线：A1 合并后把 ADDRESS 替换为真实部署地址即可全量启用
const CAMPAIGN_FACTORY_ADDRESS = "" as `0x${string}`; // 留空待整合（空值时提交按钮禁用）
const CAMPAIGN_FEE_MON = "0.1"; // L1 场次费（演示定价，README 注明测试网参数）
const MAX_LIVE_HOURS = 24; // 03 方案：liveSeconds 上限 24h

const CREATE_CAMPAIGN_ABI = [
  parseAbiItem(
    "function createCampaign(string title, string t1, string t2, uint256 liveSeconds) payable returns (uint256 id)",
  ),
] as const;
const CAMPAIGN_CREATED_EVENT = parseAbiItem(
  "event CampaignCreated(uint256 indexed id, address indexed sponsor, address canvas, string title)",
);

const HOUR_OPTIONS = [1, 4, 8, 24];

type Created = { id: string; sponsor: string; canvas: string; title: string };

const Campaign: NextPage = () => {
  const { address, isConnected } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  const [title, setTitle] = useState("Monad Blitz 纪念战役");
  const [team1, setTeam1] = useState("紫晶军团");
  const [team2, setTeam2] = useState("黄金部落");
  const [hours, setHours] = useState(8);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [created, setCreated] = useState<Created | null>(null);
  const [confirmed, setConfirmed] = useState(false); // 上链但未解码出 CampaignCreated 的弱成功态

  // 等待交易上链（SE2 pollingInterval 自动轮询）
  const { data: receipt } = useWaitForTransactionReceipt({ hash: txHash });

  // 从回执日志解码 CampaignCreated（stub 合约无法用 useScaffoldEventHistory，本地解码零延迟）
  useEffect(() => {
    if (!receipt?.logs || receipt.status !== "success") return;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: [CAMPAIGN_CREATED_EVENT],
          data: log.data,
          topics: log.topics ?? [],
        });
        if (decoded.eventName === "CampaignCreated") {
          const a = decoded.args as { id?: unknown; sponsor?: unknown; canvas?: unknown; title?: unknown };
          setCreated({
            id: String(a.id ?? ""),
            sponsor: String(a.sponsor ?? ""),
            canvas: String(a.canvas ?? ""),
            title: String(a.title ?? ""),
          });
          return;
        }
      } catch {
        // 非 CampaignCreated 日志，跳过
      }
    }
    setConfirmed(true);
  }, [receipt]);

  const submit = async () => {
    if (!isConnected) {
      notification.warning("请先连接钱包（右上角）");
      return;
    }
    setCreated(null);
    setConfirmed(false);
    try {
      const hash = await writeContractAsync({
        address: CAMPAIGN_FACTORY_ADDRESS,
        abi: CREATE_CAMPAIGN_ABI,
        functionName: "createCampaign",
        args: [title, team1, team2, BigInt(Math.min(hours, MAX_LIVE_HOURS) * 3600)],
        value: parseEther(CAMPAIGN_FEE_MON), // L1 场次费
        gasPrice: parseGwei(MONAD_GAS_PRICE_GWEI.toString()), // Monad 测试网官方最低 50 gwei
      });
      setTxHash(hash);
      notification.success("交易已发送，等待链上确认…");
    } catch (err) {
      notification.error(String((err as Error)?.message ?? err).slice(0, 120));
    }
  };

  // 成功态：CampaignCreated 事件卡片（这就是 L1 收入的链上凭证）
  if (created) {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen px-4 text-center">
        <h1 className="text-3xl font-bold text-success">✅ 一场商业战役已链上成交</h1>
        <div className="card bg-base-100 shadow-xl mt-6 w-full max-w-md">
          <div className="card-body gap-2">
            <h2 className="card-title justify-center">
              Campaign #{created.id} ·「{created.title}」
            </h2>
            <p className="text-sm break-all">
              主办方 <span className="font-mono">{created.sponsor.slice(0, 10)}…</span>
            </p>
            <p className="text-sm break-all">
              专属画布 <span className="font-mono text-primary">{created.canvas.slice(0, 10)}…</span>
            </p>
            <p className="text-xs opacity-60 mt-2">
              {team1} vs {team2} · {hours} 小时 · 场次费 {CAMPAIGN_FEE_MON} MON —— L1 收入模型的链上凭证
            </p>
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm mt-6"
          onClick={() => {
            setCreated(null);
            setConfirmed(false);
            setTxHash(undefined);
          }}
        >
          ➕ 再创建一场
        </button>
      </main>
    );
  }

  return (
    <main className="flex flex-col items-center pt-6 pb-10 px-4 min-h-screen">
      <h1 className="text-2xl font-bold">🎪 品牌战役创建</h1>
      <p className="text-sm opacity-70 mt-1 text-center">
        主办方付一笔场次费（{CAMPAIGN_FEE_MON} 测试 MON），链上创建专属画布战役 —— 三层收入模型的 L1
      </p>

      <div className="card bg-base-100 shadow-xl mt-6 w-full max-w-md">
        <div className="card-body gap-3">
          <label className="form-control">
            <span className="label-text mb-1">战役标题</span>
            <input
              className="input input-bordered w-full"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={64}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="form-control">
              <span className="label-text mb-1">阵营一（紫系）</span>
              <input
                className="input input-bordered w-full"
                value={team1}
                onChange={e => setTeam1(e.target.value)}
                maxLength={32}
              />
            </label>
            <label className="form-control">
              <span className="label-text mb-1">阵营二（金系）</span>
              <input
                className="input input-bordered w-full"
                value={team2}
                onChange={e => setTeam2(e.target.value)}
                maxLength={32}
              />
            </label>
          </div>
          <label className="form-control">
            <span className="label-text mb-1">战役时长（上限 {MAX_LIVE_HOURS}h）</span>
            <select
              className="select select-bordered w-full"
              value={hours}
              onChange={e => setHours(Number(e.target.value))}
            >
              {HOUR_OPTIONS.map(h => (
                <option key={h} value={h}>
                  {h} 小时{h === MAX_LIVE_HOURS ? "（上限）" : ""}
                </option>
              ))}
            </select>
          </label>

          <p className="text-sm">
            场次费：<b>{CAMPAIGN_FEE_MON} MON</b>（测试网演示参数）
          </p>

          {txHash && !created && !confirmed && <p className="text-sm animate-pulse">⌛ 交易已发送，等待链上确认…</p>}
          {confirmed && !created && (
            <p className="text-sm text-success">✅ 交易已上链（未解码到 CampaignCreated，请核对合约地址）</p>
          )}

          {/* stub 地址为空 = 等待 A1 部署接线，代码就绪后填地址即启用 */}
          {!CAMPAIGN_FACTORY_ADDRESS ? (
            <button className="btn btn-primary w-full" disabled>
              ⏳ 合约待接线（整合点②替换 stub 地址）
            </button>
          ) : (
            <button
              className="btn btn-primary w-full"
              disabled={isPending || !isConnected || !address}
              onClick={submit}
            >
              {isPending ? "钱包确认中…" : isConnected ? `💸 付费 ${CAMPAIGN_FEE_MON} MON 创建战役` : "请先连接钱包"}
            </button>
          )}
        </div>
      </div>

      <p className="text-xs opacity-60 mt-4 text-center max-w-md">
        观众打的是品牌的颜色战争，终局画布就是品牌社区共同签名的作品 —— 数据侧回放见 /stage?replay=1（L3）
      </p>
    </main>
  );
};

export default Campaign;
