import type { ScanResult } from "../shared/types";
import { MAX_COLLECTED_COMMENTS } from "../shared/constants";

export const COLLECTION_LIMITS = [100, 200, 500, 1000, 5000, 10000, 50000, MAX_COLLECTED_COMMENTS] as const;
export interface CollectionPreferences { target: number; autoStart: boolean }
export const DEFAULT_PREFERENCES: CollectionPreferences = { target: MAX_COLLECTED_COMMENTS, autoStart: false };
export function normalizePreferences(value: Partial<CollectionPreferences> | null | undefined): CollectionPreferences {
  return { target: COLLECTION_LIMITS.includes(value?.target as typeof COLLECTION_LIMITS[number]) ? Number(value?.target) : DEFAULT_PREFERENCES.target, autoStart: value?.autoStart === true };
}
export interface CollectionResult {
  scan: ScanResult | null;
  reason: "target" | "end" | "paused" | "round-limit" | "blocked" | "cancelled" | "video-changed";
}
export interface CollectionPageState {
  available: boolean;
  loading: boolean;
  atEnd: boolean;
  atBottom: boolean;
  position?: number;
  extent?: number;
}
export interface CollectionDriver {
  target: number; signal: AbortSignal; identity: () => string; blocked: () => boolean;
  scan: () => ScanResult; scroll: () => boolean; wait: () => Promise<void>;
  progress: (scan: ScanResult, rounds: number) => void | Promise<void>;
  pageState?: () => CollectionPageState;
  suspended?: () => boolean;
  now?: () => number;
  maxRounds?: number;
  settleMs?: number;
  idleTimeoutMs?: number;
}
/** A quiet count is not an end marker: loading and restored pages can repeat old comments. */
export async function collectComments(driver: CollectionDriver): Promise<CollectionResult> {
  const initialIdentity = driver.identity();
  const target = Math.min(MAX_COLLECTED_COMMENTS, Math.max(1, Math.floor(driver.target) || DEFAULT_PREFERENCES.target));
  const now = driver.now ?? (() => performance.now());
  const settleMs = Math.max(0, driver.settleMs ?? 30_000);
  const idleTimeoutMs = Math.max(settleMs, driver.idleTimeoutMs ?? 120_000);
  // A custom safety ceiling pauses the run; regular runs follow page/end evidence.
  const maxRounds = driver.maxRounds ?? Number.POSITIVE_INFINITY;
  let result: ScanResult | null = null; let rounds = 0; let previousCount = -1;
  let previousSignature = "";
  let previousState: CollectionPageState | null = null;
  let lastProgressAt = now(); let previousTick = lastProgressAt;
  let bottomStableSince: number | null = null; let wasSuspended = false;
  for (;;) {
    if (driver.signal.aborted) return { scan: result, reason: "cancelled" };
    if (driver.identity() !== initialIdentity) return { scan: null, reason: "video-changed" };
    if (driver.blocked()) return { scan: result, reason: "blocked" };
    const time = now(); const suspended = driver.suspended?.() === true;
    if (suspended || wasSuspended) {
      const pausedFor = Math.max(0, time - previousTick);
      lastProgressAt += pausedFor;
      if (bottomStableSince !== null) bottomStableSince += pausedFor;
    }
    previousTick = time; wasSuspended = suspended;
    if (suspended) { await driver.wait(); continue; }

    const state = driver.pageState?.() ?? { available: true, loading: false, atEnd: false, atBottom: false };
    if (state.available) {
      result = driver.scan(); await driver.progress(result, rounds);
      if (driver.signal.aborted) return { scan: result, reason: "cancelled" };
      if (driver.identity() !== initialIdentity) return { scan: null, reason: "video-changed" };
      if (driver.blocked()) return { scan: result, reason: "blocked" };
      if (driver.suspended?.()) continue;
      const count = result.comments.length;
      if (count >= target) return { scan: result, reason: "target" };
      const countAdvanced = count > previousCount;
      const observedAdvanced = Boolean(result.observedCommentSignature && result.observedCommentSignature !== previousSignature);
      const positionAdvanced = Number.isFinite(state.position) && Number.isFinite(previousState?.position)
        && state.position! > previousState!.position! + 1;
      const extentAdvanced = Number.isFinite(state.extent) && Number.isFinite(previousState?.extent)
        && state.extent! > previousState!.extent! + 1;
      if (countAdvanced || observedAdvanced || positionAdvanced || extentAdvanced || previousState?.available === false) lastProgressAt = time;
      const geometryChanged = state.position !== previousState?.position || state.extent !== previousState?.extent;
      if (!state.loading && state.atEnd) return { scan: result, reason: "end" };
      if (state.atBottom && !state.loading) {
        if (bottomStableSince === null || countAdvanced || observedAdvanced || geometryChanged) bottomStableSince = time;
        if (time - bottomStableSince >= settleMs) return { scan: result, reason: "end" };
      } else bottomStableSince = null;
      previousCount = count;
      previousSignature = result.observedCommentSignature || "";
    } else bottomStableSince = null;
    previousState = state;
    if (time - lastProgressAt >= idleTimeoutMs) return { scan: result, reason: "paused" };
    if (rounds >= maxRounds) return { scan: result, reason: "round-limit" };
    // Loading placeholders can be present before their lazy-load threshold enters
    // the viewport. Reach that threshold, then wait without nudging a busy bottom.
    if (state.available && (!state.loading || !state.atBottom) && driver.scroll()) rounds += 1;
    await driver.wait();
  }
}
export const STOP_MESSAGES: Record<CollectionResult["reason"], string> = {
  target: "已达到本次采集上限，可排序或导出。",
  end: "评论已加载到底，本次采集完成，可排序或导出。",
  paused: "网页长时间没有加载进展，已保存进度；页面恢复后可以继续采集。",
  "round-limit": "已达到本次滚动保护上限，进度已保留，可以继续采集。",
  blocked: "检测到登录或验证提示，已暂停并保留进度。请在网页完成验证后继续。",
  cancelled: "已停止，已收集的评论仍可导出。",
  "video-changed": "视频已切换，上一次采集已取消。"
};
