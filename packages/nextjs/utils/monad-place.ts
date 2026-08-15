// Monad Place 共享常量与工具（合约 64x36 画布 + 16 色双阵营 + 五声音阶）
// 下标 = 合约颜色编号（0 空白不用）；1-8 紫晶军团(冷色)，9-16 黄金部落(暖色)
export const BOARD_WIDTH = 64;
export const BOARD_HEIGHT = 36;

export const PALETTE: (string | null)[] = [
  null,
  "#7c3aed",
  "#8b5cf6",
  "#a78bfa",
  "#6366f1",
  "#38bdf8",
  "#06b6d4",
  "#14b8a6",
  "#0ea5e9",
  "#f59e0b",
  "#f97316",
  "#ef4444",
  "#dc2626",
  "#eab308",
  "#facc15",
  "#fb923c",
  "#fde047",
];

export const TEAM1_COLORS = Array.from({ length: 8 }, (_, i) => i + 1); // 紫晶军团
export const TEAM2_COLORS = Array.from({ length: 8 }, (_, i) => i + 9); // 黄金部落

export const EMPTY_COLOR = "#0b0e1d";

// 五声音阶（宫商角徵羽）：任何落子组合都和谐；两阵营差一个八度
const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0]; // C D E G A
let audioContext: AudioContext | undefined;

export function playNote(color: number) {
  try {
    if (typeof window === "undefined") return;
    audioContext =
      audioContext ??
      new (
        window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      )();
    const t = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "triangle";
    osc.frequency.value = SCALE[color % 5] * (color <= 8 ? 1 : 2);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  } catch {
    // 音频失败不影响游戏
  }
}

// Monad 官方要求：测试网 Gas 基础费用最低 50 gwei，显式设置避免钱包估算过低
export const MONAD_GAS_PRICE_GWEI = 52n;
