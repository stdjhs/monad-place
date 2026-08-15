// P-A 并行仪表（02 方案）：「同块并发」是 Monad 并行执行在画布上的直接证据，
// 「整链块吞吐」是平台级对比（eth_getBlockReceipts 官方推荐批量法）。
// 纯展示组件，数据由 stage 对账补拉循环每 2s 采集传入（无额外请求负担）。
// 配色遵循 dataviz 规范：紫=本合约结构 / 绿=整链性能，无渐变，tabular-nums 等宽数字；色值统一走 globals.css 的 mp-* 设计令牌

export type ParallelStats = {
  concurrent: number; // 最近一个有事件块的本合约并发笔数
  perBlock: number[]; // 本合约最近 20 块每块笔数（块高升序）
  chainTx: number | null; // 最新采样块的全网交易数（RPC 双法皆败时沿用上次值）
};

const BAR_MAX_H = 28; // 柱最大高度（px）
const BAR_MIN_H = 3; // 柱最小高度（px），零值也保留基线点

const ParallelMeter = ({ stats }: { stats: ParallelStats }) => {
  const maxPerBlock = Math.max(...stats.perBlock, 1);
  const lastIdx = stats.perBlock.length - 1;
  return (
    <div className="flex items-center gap-4">
      <span>
        同块并发 <b className="text-mp-accent text-2xl tabular-nums">{stats.concurrent}</b>
      </span>
      <span>
        整链 <b className="text-mp-ok text-2xl tabular-nums">{stats.chainTx ?? "—"}</b>
        <span className="text-base text-mp-muted"> tx/块</span>
      </span>
      {/* 本合约最近 20 块迷你柱状图：最后一根脉冲强调「此刻」 */}
      <div className="flex items-end gap-[2px] h-8" title="本合约最近 20 块每块落子数">
        {stats.perBlock.map((n, i) => (
          <div
            key={i}
            className={`w-[4px] ${i === lastIdx ? "bg-mp-accent animate-pulse" : "bg-mp-accent/40"}`}
            style={{ height: `${Math.max(BAR_MIN_H, Math.round((n / maxPerBlock) * BAR_MAX_H))}px` }}
          />
        ))}
      </div>
    </div>
  );
};

export default ParallelMeter;
