import { DouyinAdapter } from "../adapters/douyin/DouyinAdapter";
import { findCommentContainer, findCommentScroller, findToolbarAnchor, getVideoContext, getCommentLoadState } from "../adapters/douyin/detector";
import { OBSERVER_DEBOUNCE_MS } from "../shared/constants";
import { isActivateToolbarRequest } from "../shared/messages";
import type { ScanResult, SortMode } from "../shared/types";
import { debounce } from "../utils/debounce";
import { exportCommentsCsv } from "../utils/export-csv";
import { stableSortComments } from "../utils/stable-sort";
import { collectComments, DEFAULT_PREFERENCES, normalizePreferences, STOP_MESSAGES, type CollectionPreferences } from "./collection";
import { StickyCommentToolbar } from "./sticky-toolbar";
import { CommentSessionStore, type SessionLease, type CollectionSessionState } from "./session-store";

const PREFERENCES_KEY = "xiaoleCommentPreferencesV1";
const CONTINUOUS_KEY = "xiaoleCommentContinuousV2";
const CLAIM_EVENT = "xiaole-comment-controller-claim";
const OWNER_ATTRIBUTE = "data-xiaole-comment-owner";
interface ControllerHandle { activate: () => void; destroy: () => void }
const contentWindow = window as Window & { __XIAOLE_COMMENTS__?: ControllerHandle };

function downloadCsv(content: string, videoId: string, count: number): void {
  const now = new Date(); const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `小乐收集-抖音评论-${videoId || "当前视频"}-${count}条-${date}.csv`;
  link.style.display = "none"; document.documentElement.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function visible(element: Element): boolean {
  const style = getComputedStyle(element); return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}
function hasBlockingPrompt(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"], [class*="captcha"], [id*="captcha"], [class*="verify"], [id*="verify"], [class*="login-mask"], [class*="login-panel"]')).slice(0, 200).some(element => visible(element) && /验证码|安全验证|操作频繁|访问异常|请先登录|登录后|扫码登录|手机号登录/u.test(element.textContent ?? ""));
}
function videoIdentity(): string {
  const context = getVideoContext();
  if (context.videoId) return context.videoId;
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).filter(visible);
  const active = videos.find(video => !video.paused) ?? videos[0];
  return `${location.origin}${location.pathname}|${active?.currentSrc || active?.src || context.videoTitle}`;
}
function commentFingerprint(): string {
  const container = findCommentContainer().element;
  const ids = Array.from(container?.querySelectorAll('[data-comment-id], [data-cid], [data-id]') ?? []).slice(0, 12)
    .map(node => node.getAttribute('data-comment-id') || node.getAttribute('data-cid') || node.getAttribute('data-id')).join('|');
  if (!container) return '';
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {acceptNode: node =>
    node.parentElement?.closest('#xl-comment-toolbar') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  let text = ''; let node: Node | null;
  while (text.length < 1200 && (node = walker.nextNode())) text += node.textContent || '';
  return ids + '::' + text.trim().slice(0, 1200);
}
function stopIntent(identity: string, value?: boolean): boolean {
  const key = `xiaole-comment-stopped:${identity}`;
  try {
    if (value === true) sessionStorage.setItem(key, '1');
    if (value === false) sessionStorage.removeItem(key);
    return sessionStorage.getItem(key) === '1';
  } catch { return false; }
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => { window.clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = window.setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true });
  });
}

class ContentController implements ControllerHandle {
  private readonly controllerId = crypto.randomUUID();
  private readonly adapter = new DouyinAdapter();
  private readonly ui: StickyCommentToolbar;
  private readonly observer: MutationObserver;
  private readonly afterMutation: ReturnType<typeof debounce>;
  private currentSort: SortMode = "original";
  private lastScan: ScanResult | null = null;
  private lastError = "";
  private identity = videoIdentity();
  private urlTimer: number | null = null;
  private run: AbortController | null = null;
  private generation = 0;
  private destroyed = false;
  private preferences = { ...DEFAULT_PREFERENCES };
  private preferencesLoaded = false;
  private autoStartedFor = "";
  private transitionUntil = 0;
  private staleFingerprint: string | null = null;
  private lastCommentFingerprint = "";
  private readonly sessions = new CommentSessionStore();
  private sessionKey = "";
  private sessionReady = false;
  private lease: SessionLease | null = null;
  private resumePending = false;
  private resumeExport = false;
  private resumeAfter = 0;
  private sessionSuppressed = false;
  private saving: Promise<void> = Promise.resolve();
  private storageFailure = "";
  private backgroundPaused = false;

  constructor() {
    this.ui = new StickyCommentToolbar({
      onSort: mode => this.scanAndApply(mode), onRefresh: () => this.scanAndApply(this.currentSort),
      onExportCurrent: () => this.exportComments(), onExportTop: () => this.exportComments(this.preferences.target),
      onCollect: () => { void this.collect(false); }, onCollectAndExport: () => { void this.collect(true); },
      onCancelCollection: () => this.cancelCollection(), onCopyDiagnostics: () => { void this.copyDiagnostics(); },
      onPreferences: value => { void this.savePreferences(value); }
    });
    this.afterMutation = debounce(() => { this.checkVideo(); this.ensureToolbar(); this.scanAndUpdateCount(); }, OBSERVER_DEBOUNCE_MS);
    this.observer = new MutationObserver(mutations => {
      if (mutations.some(m => m.addedNodes.length || m.removedNodes.length || m.type === "characterData")) this.afterMutation();
    });
  }
  start(): void {
    document.addEventListener(CLAIM_EVENT, this.handleClaim); document.documentElement.setAttribute(OWNER_ATTRIBUTE, this.controllerId); document.dispatchEvent(new Event(CLAIM_EVENT));
    this.ensureToolbar(); this.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    chrome.runtime.onMessage.addListener(this.handleMessage); window.addEventListener("pagehide", this.handlePageHide, { once: true });
    this.urlTimer = window.setInterval(() => { this.checkVideo(); this.ensureToolbar(); this.scanAndUpdateCount(); }, 1000);
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('online', this.handleVisibility);
    void this.loadPreferences();
  }
  activate(): void { this.ensureToolbar(); this.scanAndApply(this.currentSort); this.ui.reveal(); }
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true; this.generation += 1; this.run?.abort(); this.run = null;
    this.observer.disconnect(); this.afterMutation.cancel(); if (this.urlTimer !== null) window.clearInterval(this.urlTimer);
    try { chrome.runtime.onMessage.removeListener(this.handleMessage); } catch { /* Context invalidated by Chrome reload. */ }
    document.removeEventListener(CLAIM_EVENT, this.handleClaim); window.removeEventListener("pagehide", this.handlePageHide);
    document.removeEventListener('visibilitychange', this.handleVisibility); window.removeEventListener('online', this.handleVisibility);
    if (document.documentElement.getAttribute(OWNER_ATTRIBUTE) === this.controllerId) document.documentElement.removeAttribute(OWNER_ATTRIBUTE);
    this.ui.destroy(); this.adapter.clear(); if (contentWindow.__XIAOLE_COMMENTS__ === this) delete contentWindow.__XIAOLE_COMMENTS__;
  }
  private readonly handleMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean => {
    if (sender.id !== chrome.runtime.id || !isActivateToolbarRequest(message)) return false;
    this.activate(); sendResponse({ ok: true }); return false;
  };
  private readonly handlePageHide = (): void => this.destroy();
  private readonly handleVisibility = (): void => { if (!document.hidden) this.maybeAutoStart(); };
  private readonly handleClaim = (): void => { if (document.documentElement.getAttribute(OWNER_ATTRIBUTE) !== this.controllerId) this.destroy(); };
  private ensureToolbar(): void { const match = findCommentContainer(); if (match.element) this.ui.mount(match.element, findToolbarAnchor(match.element)); }
  private checkVideo(): void {
    const next = videoIdentity(); if (next === this.identity) return;
    const oldLease = this.lease;
    if (oldLease && this.run) void this.saveProgress(oldLease).then(() => this.sessions.setState(oldLease, 'paused')).catch(() => undefined);
    this.stopScrolling();
    this.generation += 1; this.run?.abort(); this.run = null; this.identity = next; this.autoStartedFor = "";
    this.staleFingerprint = this.lastCommentFingerprint || null; this.transitionUntil = Date.now() + 1000;
    this.lastScan = null; this.currentSort = "original"; this.adapter.clear(); this.ui.unmount(); this.ui.setCollectionState(false, 0, "视频已切换，等待新评论加载。"); this.ui.update("original", 0, "视频已切换，等待新评论加载。");
    this.lease = null; this.sessionReady = false; this.resumePending = false; this.sessionSuppressed = false;
    if (this.preferencesLoaded) void this.restoreSession();
  }
  private canScan(): boolean {
    this.checkVideo(); if (this.destroyed || Date.now() < this.transitionUntil) return false;
    const fingerprint = commentFingerprint();
    if (this.staleFingerprint && fingerprint === this.staleFingerprint) return false;
    this.staleFingerprint = null; this.lastCommentFingerprint = fingerprint; return true;
  }
  private async loadPreferences(): Promise<void> {
    try {
      const saved = await chrome.storage.local.get([PREFERENCES_KEY, CONTINUOUS_KEY]);
      this.preferences = normalizePreferences(saved[PREFERENCES_KEY]);
      if (!saved[CONTINUOUS_KEY]) {
        this.preferences.target = 100000;
        await chrome.storage.local.set({[PREFERENCES_KEY]:this.preferences,[CONTINUOUS_KEY]:true});
      }
      const response = await chrome.runtime.sendMessage({type:'XIAOLE_COMMENT_SESSION'});
      if (!response?.ok || typeof response.key !== 'string') throw new Error('无法建立当前标签页的采集进度。');
      this.sessionKey = response.key;
    }
    catch { this.ui.update(this.currentSort, 0, "无法读取偏好设置，暂使用本页默认设置。", true); }
    this.preferencesLoaded = true; this.ui.setPreferences(this.preferences); await this.restoreSession();
  }

  private async restoreSession(): Promise<void> {
    const generation = this.generation; const identity = this.identity;
    this.sessionReady = false;
    try {
      if (!this.sessionKey) throw new Error('无法保存进度，请刷新页面重试。');
      const saved = await this.sessions.load(this.sessionKey, identity);
      if (this.destroyed || generation !== this.generation) return;
      const manuallyStopped = stopIntent(identity);
      this.sessionSuppressed = manuallyStopped;
      if (saved) {
        this.adapter.restore(identity, saved.comments);
        this.currentSort = saved.metadata.sort;
        this.resumePending = !manuallyStopped && (saved.metadata.state === 'running' || saved.metadata.state === 'paused');
        this.sessionSuppressed = !this.resumePending;
        if (manuallyStopped && (saved.metadata.state === 'running' || saved.metadata.state === 'paused')) {
          await this.sessions.setState(saved.metadata, 'stopped');
          if (this.destroyed || generation !== this.generation) return;
        }
        this.resumeExport = saved.metadata.exportAfter;
        if (this.resumePending) this.preferences.target = saved.metadata.target;
        this.ui.setPreferences(this.preferences);
        this.ui.update(this.currentSort, saved.comments.length, this.resumePending
          ? `已恢复 ${saved.comments.length} 条评论，等待评论区加载后继续。`
          : saved.metadata.state === 'completed' ? `上次采集已完成，已恢复 ${saved.comments.length} 条评论。` : `已恢复 ${saved.comments.length} 条评论；上次已手动停止。`);
      }
      this.storageFailure = '';
    } catch (error) {
      if (generation !== this.generation) return;
      this.storageFailure = error instanceof Error ? error.message : '无法读取采集进度';
      this.ui.update(this.currentSort, 0, this.storageFailure, true);
    } finally {
      if (!this.destroyed && generation === this.generation) { this.sessionReady = true; this.scanAndUpdateCount(); }
    }
  }

  private saveProgress(lease: SessionLease): Promise<void> {
    const changes = this.adapter.drainChanges();
    if (!changes.length) return this.saving;
    const scrollTop = findCommentScroller()?.scrollTop || 0;
    const pending = this.saving.then(async () => {
      const result = await this.sessions.checkpoint(lease, changes, {scrollTop});
      if (!result.accepted && this.lease?.runId === lease.runId && this.run && !this.run.signal.aborted) throw new Error('采集任务已由另一页面更新，请重新开始。');
    });
    this.saving = pending.catch(error => {
      if (this.identity === lease.videoId && this.lease?.runId === lease.runId) {
        this.adapter.retainChanges(changes); this.storageFailure = '保存进度失败，已暂停；请先导出当前评论，再重试。'; this.run?.abort();
      }
      this.lastError = error instanceof Error ? error.message : '保存进度失败';
    });
    return pending;
  }

  private async finishSession(lease: SessionLease, state: CollectionSessionState): Promise<void> {
    await this.saveProgress(lease); await this.sessions.setState(lease, state);
  }
  private async savePreferences(value: CollectionPreferences): Promise<void> {
    const wasEnabled = this.preferences.autoStart; this.preferences = normalizePreferences(value); this.ui.setPreferences(this.preferences);
    if (!this.preferences.autoStart && this.run) this.cancelCollection();
    try { await chrome.storage.local.set({ [PREFERENCES_KEY]: this.preferences }); }
    catch { this.ui.update(this.currentSort, this.lastScan?.comments.length ?? 0, "设置仅在当前页面生效，无法写入浏览器存储。", true); }
    if (!wasEnabled && this.preferences.autoStart) { this.autoStartedFor = ""; this.sessionSuppressed = false; stopIntent(this.identity, false); }
    this.maybeAutoStart();
  }
  private maybeAutoStart(): void {
    if (!this.preferencesLoaded || !this.sessionReady || this.storageFailure || this.run || this.destroyed || this.sessionSuppressed || stopIntent(this.identity) || document.hidden || Date.now() < this.resumeAfter) return;
    if (!this.resumePending && (!this.preferences.autoStart || this.autoStartedFor === this.identity)) return;
    if (!findCommentContainer().element || !this.canScan() || hasBlockingPrompt() || !navigator.onLine) return;
    void this.collect(this.resumePending ? this.resumeExport : false, true);
  }
  private scanAndApply(mode: SortMode): void {
    if (this.run || !this.sessionReady || !this.canScan()) return; this.currentSort = mode; this.ensureToolbar();
    try { const result = this.adapter.scan(); this.lastScan = result; this.lastError = "";
      if (!result.comments.length) return this.ui.showError(result.pageStatus, result.diagnostics);
      const reordered = this.adapter.reorder(stableSortComments(result.comments, mode), this.sortLabel(mode)); this.ui.update(mode, result.comments.length, reordered.message);
    } catch (error) { this.showError(error); }
  }
  private exportComments(limit?: number): void {
    if (this.run || !this.sessionReady || !this.canScan()) return;
    try { const result = this.adapter.scan(); this.lastScan = result;
      if (!result.comments.length) return this.ui.showError(result.pageStatus, result.diagnostics);
      const sorted = stableSortComments(result.comments, this.currentSort); const exported = limit ? sorted.slice(0, limit) : sorted;
      downloadCsv(exportCommentsCsv(exported), result.pageStatus.videoId, exported.length); this.ui.update(this.currentSort, result.comments.length, `已按当前排序导出 ${exported.length} 条主评论。`);
    } catch (error) { this.showError(error); }
  }
  private async collect(exportAfter: boolean, automatic = false): Promise<void> {
    if (this.run || !this.sessionReady || !this.canScan()) return;
    if (!this.sessionKey || this.storageFailure) { this.ui.update(this.currentSort, this.lastScan?.comments.length || 0, this.storageFailure || '正在准备进度存储，请刷新重试。', true); return; }
    this.ensureToolbar(); this.autoStartedFor = this.identity;
    const run = new AbortController(); this.run = run; const generation = this.generation; const identity = this.identity;
    const keepPosition = automatic && this.resumePending && this.lease?.videoId === identity;
    this.lease = null;
    if (!automatic) stopIntent(identity, false);
    this.sessionSuppressed = false; this.resumePending = false; this.backgroundPaused = false;
    this.ui.setCollectionState(true, this.lastScan?.comments.length ?? 0, automatic ? '正在恢复采集，已读评论会自动去重……' : '正在从评论区开头采集，刷新后可自动继续……');
    try {
      const lease = await this.sessions.begin(this.sessionKey, identity, {target:this.preferences.target, exportAfter, sort:this.currentSort});
      if (generation !== this.generation || this.destroyed) { await this.sessions.setState(lease, 'paused'); return; }
      this.lease = lease;
      if (run.signal.aborted) { await this.finishSession(lease, 'stopped'); if (generation === this.generation && !this.destroyed) this.ui.setCollectionState(false, this.lastScan?.comments.length || 0, STOP_MESSAGES.cancelled); return; }
      await this.saveProgress(lease);
      if (generation !== this.generation || this.destroyed || videoIdentity() !== identity) return;
      if (run.signal.aborted) { await this.finishSession(lease, 'stopped'); this.ui.setCollectionState(false, this.lastScan?.comments.length || 0, STOP_MESSAGES.cancelled); return; }
      if (!keepPosition) findCommentScroller()?.scrollTo({top:0,behavior:'instant'});
      await wait(500, run.signal);
      const outcome = await collectComments({
        target: this.preferences.target, signal: run.signal, identity: videoIdentity,
        blocked: () => hasBlockingPrompt(), pageState: getCommentLoadState,
        suspended: () => {
          const paused = document.hidden || !navigator.onLine;
          if (paused && !this.backgroundPaused) this.ui.setCollectionState(true, this.lastScan?.comments.length || 0, '采集暂挂，回到本页或网络恢复后自动继续。');
          this.backgroundPaused = paused; return paused;
        },
        scan: () => this.adapter.scan(),
        scroll: () => { const scroller = findCommentScroller(); if (!scroller) return false;
          const distance = Math.max(480, Math.round(scroller.clientHeight * .82));
          // Instant movement is deterministic even while the site replaces its list.
          const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
          if (atBottom && getCommentLoadState().loading) return false;
          if (atBottom) scroller.scrollBy({top:-2,behavior:'instant'});
          scroller.scrollTo({ top: Math.min(scroller.scrollHeight, scroller.scrollTop + distance), behavior: "instant" }); return true;
        },
        wait: () => wait(1500, run.signal),
        progress: async scan => { if (this.generation !== generation) return; this.lastScan = scan; this.lastCommentFingerprint = commentFingerprint(); await this.saveProgress(lease); if (this.generation === generation && !run.signal.aborted) this.ui.setCollectionState(true, scan.comments.length, `正在采集 ${scan.comments.length} / ${this.preferences.target} 条主评论，进度已保存。`); }
      });
      if (this.destroyed || this.generation !== generation || videoIdentity() !== identity) { this.checkVideo(); return; }
      this.lastScan = outcome.scan ?? this.lastScan;
      const completed = outcome.reason === 'end' || outcome.reason === 'target';
      const stopped = outcome.reason === 'cancelled';
      this.resumePending = !completed && !stopped; this.resumeExport = exportAfter;
      this.sessionSuppressed = completed || stopped; this.resumeAfter = Date.now() + 15000;
      await this.finishSession(lease, completed ? 'completed' : stopped ? 'stopped' : 'paused');
      if (this.destroyed || generation !== this.generation || videoIdentity() !== identity) return;
      if (run.signal.aborted && !stopped) { this.ui.setCollectionState(false, this.lastScan?.comments.length || 0, STOP_MESSAGES.cancelled); return; }
      let message = STOP_MESSAGES[outcome.reason];
      const count = this.lastScan?.comments.length ?? 0;
      if (outcome.scan && completed) {
        const sorted = stableSortComments(outcome.scan.comments, this.currentSort); this.adapter.reorder(sorted, this.sortLabel(this.currentSort));
        if (exportAfter && sorted.length) { const exported = sorted.slice(0, this.preferences.target); downloadCsv(exportCommentsCsv(exported), outcome.scan.pageStatus.videoId, exported.length); message += ` 已导出 ${exported.length} 条。`; }
      }
      this.ui.setCollectionState(false, count, message);
    } catch (error) {
      if (this.generation === generation && !this.destroyed) {
        this.resumePending = !this.sessionSuppressed && !this.storageFailure; this.resumeAfter = Date.now() + 15000;
        if (this.lease) await this.sessions.setState(this.lease, this.sessionSuppressed ? 'stopped' : 'paused').catch(() => undefined);
        if (this.destroyed || generation !== this.generation || videoIdentity() !== identity) return;
        this.ui.setCollectionState(false, this.lastScan?.comments.length ?? 0, this.storageFailure || '采集暂时中断，已保存进度，页面恢复后会继续。');
        this.lastError = error instanceof Error ? error.message : '采集暂时中断';
      }
    } finally { if (this.run === run) this.run = null; }
  }
  private stopScrolling(): void {
    const scroller = findCommentScroller(); scroller?.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
  }
  private cancelCollection(): void {
    stopIntent(this.identity, true);
    this.autoStartedFor = this.identity; this.resumePending = false; this.sessionSuppressed = true; this.run?.abort(); this.stopScrolling();
    if (this.lease) void this.finishSession(this.lease, 'stopped').catch(() => undefined);
  }
  private scanAndUpdateCount(): void {
    if (this.run || !this.sessionReady || !this.canScan()) return;
    try { this.lastScan = this.adapter.scan(); this.ui.updateCount(this.lastScan.comments.length); this.maybeAutoStart(); } catch { /* A page transition may be in progress. */ }
  }
  private async copyDiagnostics(): Promise<void> {
    const status = this.adapter.getPageStatus();
    const scroller = findCommentScroller();
    const text = JSON.stringify({ tool: "小乐收集 · 评论助手", pageUrl: location.href, pageState: status.state, message: status.message, error: this.lastError || null,
      loadState:getCommentLoadState(), scroller:scroller ? {tag:scroller.tagName,className:scroller.className,scrollTop:scroller.scrollTop,scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight} : null,
      diagnostics: this.lastScan?.diagnostics ?? null, copiedAt: new Date().toISOString() }, null, 2);
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch {
      const textarea = document.createElement("textarea"); textarea.value = text; textarea.style.cssText = "position:fixed;opacity:0"; document.documentElement.append(textarea); textarea.select(); copied = typeof document.execCommand === "function" && document.execCommand("copy"); textarea.remove();
    }
    this.ui.update(this.currentSort, this.lastScan?.comments.length ?? 0, copied ? "诊断信息已复制，不包含评论正文。" : "复制失败，请重试。", !copied);
  }
  private showError(error: unknown): void { this.lastError = error instanceof Error ? error.message : "未知错误"; this.ui.showError({ ...this.adapter.getPageStatus(), state: "structure-changed", message: "读取评论时出现异常，请刷新重试或复制诊断。" }, this.lastScan?.diagnostics ?? null); }
  private sortLabel(mode: SortMode): string { return mode === "likes" ? "点赞从高到低" : mode === "replies" ? "回复从高到低" : "首次读取顺序"; }
}
try { contentWindow.__XIAOLE_COMMENTS__?.destroy(); } catch { delete contentWindow.__XIAOLE_COMMENTS__; }
const controller = new ContentController(); contentWindow.__XIAOLE_COMMENTS__ = controller; controller.start();
