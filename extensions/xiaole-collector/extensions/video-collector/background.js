if (typeof importScripts === "function") importScripts("bilibili-core.js", "bilibili-background.js");

const DEFAULT_WORKS_TABLE_NAME = "竞品达人视频数据";
const MONITOR_URL = "https://www.douyin.com/jingxuan?dycollector=fish";
const MONITOR_QUEUE_KEY = "douhotMonitorQueueV1";
const MONITOR_STATUS_KEY = "douhotMonitorStatusV1";
const MONITOR_RETRY_ALARM = "douhotMonitorRetryV1";
const TRANSCRIPTION_JOBS_KEY = "douhotTranscriptionJobsV1";
const TRANSCRIPTION_ALARM = "douhotTranscriptionPollV1";
const BASE_TRANSCRIPTION_REQUEST_ALARM = "douhotBaseTranscriptionRequestV1";
const BASE_TRANSCRIPTION_REQUEST_FIELD = "转逐字稿";
const DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com/api/v1";
const DOUYIN_SOURCE_STRATEGY = "play-uri-v1";
const TRANSCRIPTION_MEDIA_RECOVERY_VERSION = 1;
const TRANSCRIPTION_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MONITOR_SETTINGS = {
  enabled: false,
  targetConversation: "",
  selfSenderName: "",
  scanIntervalMs: 300,
  resolveTimeoutMs: 8000,
  openOnStartup: false,
};

const DEFAULT_FEISHU_SETTINGS = {
  enabled: false,
  collectorName: "",
  authMode: "personalBaseToken",
  personalBaseToken: "",
  appId: "",
  appSecret: "",
  appToken: "",
  tableId: "",
  autoCreateFields: true,
  upsertByCreatorId: true,
};

const DEFAULT_TRANSCRIPTION_SETTINGS = {
  enabled: false,
  apiKey: "",
  model: "paraformer-v2",
};

// All choices use the existing DashScope asynchronous file-transcription API.
const TRANSCRIPTION_MODELS = [
  { id: "paraformer-v2", group: "Paraformer", label: "Paraformer V2（原默认）", description: "保留原来的转写方式，支持中文、英文及部分方言。" },
  { id: "paraformer-v1", group: "Paraformer", label: "Paraformer V1", description: "适用于中文普通话和英文录音。" },
  { id: "paraformer-mtl-v1", group: "Paraformer", label: "Paraformer 多语种", description: "适用于多语种及中文方言录音。" },
  { id: "paraformer-8k-v2", group: "Paraformer", label: "Paraformer 8k V2（电话录音）", description: "用于 8kHz 中文电话录音；普通抖音视频请选择通用录音模型。" },
  { id: "paraformer-8k-v1", group: "Paraformer", label: "Paraformer 8k V1（电话录音）", description: "用于 8kHz 中文电话录音；普通抖音视频请选择通用录音模型。" },
  { id: "qwen-audio-3.1-asr-flash-filetrans", group: "千问文件转写", label: "千问 Audio 3.1 · 文件转写", description: "支持多语种及中文方言，自动识别语言。" },
  { id: "qwen-audio-3.0-asr-flash-filetrans", group: "千问文件转写", label: "千问 Audio 3.0 · 文件转写", description: "支持多语种及中文方言，自动识别语言。" },
  { id: "qwen3-asr-flash-filetrans", group: "千问文件转写", label: "千问3 ASR · 文件转写", description: "支持多语种及部分中文方言，自动识别语言。" },
  { id: "qwen3-asr-flash-filetrans-2025-11-17", group: "千问文件转写", label: "千问3 ASR · 固定版 2025-11-17", description: "千问3文件转写的固定版本，便于比较不同版本的转写结果。" },
  { id: "fun-asr", group: "Fun-ASR", label: "Fun-ASR", description: "支持多语种及中文方言，自动识别语言。" },
  { id: "fun-asr-mtl", group: "Fun-ASR", label: "Fun-ASR 多语种", description: "支持多语种及中文普通话、粤语，自动识别语言。" },
  { id: "fun-asr-2025-11-07", group: "Fun-ASR", label: "Fun-ASR · 固定版 2025-11-07", description: "支持多语种及中文方言的固定版本。" },
  { id: "fun-asr-2025-08-25", group: "Fun-ASR", label: "Fun-ASR · 固定版 2025-08-25", description: "适用于中文普通话和英文录音的固定版本。" },
  { id: "fun-asr-mtl-2025-08-25", group: "Fun-ASR", label: "Fun-ASR 多语种 · 固定版 2025-08-25", description: "Fun-ASR 多语种的固定版本，支持中文普通话和粤语等。" },
];

function normalizeTranscriptionModel(value) {
  const model = String(value || DEFAULT_TRANSCRIPTION_SETTINGS.model).trim();
  if (!TRANSCRIPTION_MODELS.some((item) => item.id === model)) {
    throw new Error("请选择列表中的录音文件转写模型。");
  }
  return model;
}

let commentReaderTabId = 0;
let commentReaderCloseTimer = 0;
let monitorDraining = false;
let monitorDrainRequested = false;
let transcriptionProcessing = false;
let baseTranscriptionRequestProcessing = false;
let transcriptionJobsMutation = Promise.resolve();
const worksTableMutations = new Map();
const ACTIVE_TRANSCRIPTION_JOB_STATUSES = new Set(["queued", "submitted", "sync_pending"]);

// Serialize read/modify/write operations, including arrivals during network
// requests. A rejected operation must not poison the following operations.
function mutateTranscriptionJobs(operation) {
  const pending = transcriptionJobsMutation.then(operation);
  transcriptionJobsMutation = pending.catch(() => undefined);
  return pending;
}

async function mutateWorksTable(settings, tableId, operation) {
  const key = `${settings.appToken}:${tableId}`;
  const previous = worksTableMutations.get(key) || Promise.resolve();
  const pending = previous.then(operation);
  const tail = pending.catch(() => undefined);
  worksTableMutations.set(key, tail);
  try {
    return await pending;
  } finally {
    if (worksTableMutations.get(key) === tail) worksTableMutations.delete(key);
  }
}
const temporaryDouyinDetailTabs = new Set();
const MANUAL_RUN_LEASE_MS = 90000;
const manualRuns = new Map();

function manualRunError(message) {
  const error = new Error(message);
  error.code = "MANUAL_RUN_ENDED";
  return error;
}

function endManualRun(run, reason = "采集任务已结束，请重新开始。") {
  if (!run || run.ended) return;
  run.ended = reason;
  clearTimeout(run.leaseTimer);
  run.abortController.abort();
  chrome.tabs?.onRemoved?.removeListener(run.removedListener);
  chrome.tabs?.onUpdated?.removeListener(run.updatedListener);
  if (manualRuns.get(run.key) === run) manualRuns.delete(run.key);
  for (const wake of run.waiters) wake();
  run.waiters.clear();
}

function renewManualRun(run) {
  clearTimeout(run.leaseTimer);
  run.expiresAt = Date.now() + MANUAL_RUN_LEASE_MS;
  run.leaseTimer = setTimeout(() => endManualRun(run, "采集页面已断开，任务已停止，请重新开始。"), MANUAL_RUN_LEASE_MS);
}

function getManualRun(runId, tabId) {
  if (runId === undefined || runId === null || runId === "") return null;
  if (!Number.isInteger(tabId) || tabId <= 0 || typeof runId !== "string" || !/^[\w-]{8,128}$/.test(runId)) {
    throw manualRunError("采集任务标识无效，请重新开始。");
  }
  const run = manualRuns.get(`${tabId}:${runId}`);
  if (!run || run.ended) throw manualRunError("采集任务已失效，请重新开始。");
  if (run.expiresAt <= Date.now()) {
    endManualRun(run, "采集页面已断开，任务已停止，请重新开始。");
    throw manualRunError(run.ended);
  }
  return run;
}

function controlManualRun(payload, tabId) {
  const { runId, action } = payload || {};
  if (!Number.isInteger(tabId) || tabId <= 0 || typeof runId !== "string" || !/^[\w-]{8,128}$/.test(runId)) {
    throw manualRunError("采集任务标识无效，请重新开始。");
  }
  const key = `${tabId}:${runId}`;
  if (action === "finish") {
    endManualRun(manualRuns.get(key));
    return { runId, paused: false };
  }
  if (action === "start") {
    let run = manualRuns.get(key);
    if (!run) {
      // A new task in the same document replaces any orphaned task from before
      // a refresh. Other tabs and the private-message monitor are independent.
      for (const previous of manualRuns.values()) {
        if (previous.tabId === tabId) endManualRun(previous);
      }
      run = { key, runId, tabId, paused: false, ended: "", waiters: new Set(), expiresAt: 0, leaseTimer: 0, abortController: new AbortController() };
      manualRuns.set(key, run);
      run.removedListener = (removedTabId) => {
        if (removedTabId === tabId) endManualRun(run, "采集页面已关闭，任务已停止。");
      };
      run.updatedListener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "loading") endManualRun(run, "采集页面已刷新，任务已停止。");
      };
      chrome.tabs?.onRemoved?.addListener(run.removedListener);
      chrome.tabs?.onUpdated?.addListener(run.updatedListener);
    }
    renewManualRun(run);
    return { runId, paused: run.paused };
  }
  const run = getManualRun(runId, tabId);
  if (!["pause", "resume", "heartbeat"].includes(action)) throw new Error("未知采集任务操作。");
  renewManualRun(run);
  if (action === "pause") run.paused = true;
  if (action === "resume") {
    run.paused = false;
    for (const wake of run.waiters) wake();
    run.waiters.clear();
  }
  return { runId, paused: run.paused };
}

async function manualRunCheckpoint(run) {
  if (!run) return;
  for (;;) {
    if (!run.ended && run.expiresAt <= Date.now()) endManualRun(run, "采集页面已断开，任务已停止，请重新开始。");
    if (run.ended) throw manualRunError(run.ended);
    if (!run.paused) return;
    await new Promise((resolve) => run.waiters.add(resolve));
  }
}

const FIELD_TYPE = {
  text: 1,
  number: 2,
  singleSelect: 3,
  multiSelect: 4,
  dateTime: 5,
  checkbox: 7,
};

const FIELD_DEFINITIONS = [
  { name: "采集时间", type: FIELD_TYPE.text, pick: (result) => formatDateTime(result.extractedAt) },
  { name: "热点宝链接", type: FIELD_TYPE.text, pick: (result) => result.platform === "哔哩哔哩" ? undefined : result.sourceUrl },
  { name: "抖音主页", type: FIELD_TYPE.text, pick: (result) => result.profile?.douyinProfileUrl },
  { name: "博主名称", type: FIELD_TYPE.text, pick: (result) => result.profile?.name },
  { name: "抖音号", type: FIELD_TYPE.text, pick: (result) => result.profile?.douyinId },
  { name: "总粉丝量", type: FIELD_TYPE.number, pick: (result) => integerValue(result.profile?.followerCount) },
  { name: "总获赞量", type: FIELD_TYPE.number, pick: (result) => integerValue(result.profile?.totalLiked) },
  { name: "总作品数", type: FIELD_TYPE.number, pick: (result) => integerValue(result.profile?.workCount) },
  { name: "签名", type: FIELD_TYPE.text, pick: (result) => result.profile?.signature },
  {
    name: "标签",
    type: FIELD_TYPE.multiSelect,
    uiType: "MultiSelect",
    property: (result) => ({ options: getTags(result).map((name) => ({ name })) }),
    pick: getTags,
  },
  { name: "近30天平均点赞量", type: FIELD_TYPE.number, pick: (result) => result.product30d?.averageLikes },
  { name: "近30天平均分享量", type: FIELD_TYPE.number, pick: (result) => result.product30d?.averageShares },
  { name: "近30天平均评论量", type: FIELD_TYPE.number, pick: (result) => result.product30d?.averageComments },
  { name: "粉丝男占比", type: FIELD_TYPE.number, pick: (result) => portraitPercent(result, "男") },
  { name: "粉丝女占比", type: FIELD_TYPE.number, pick: (result) => portraitPercent(result, "女") },
  { name: "男性TGI", type: FIELD_TYPE.number, pick: (result) => portraitTgi(result, "男") },
  { name: "女性TGI", type: FIELD_TYPE.number, pick: (result) => portraitTgi(result, "女") },
  { name: "城市占比TOP10", type: FIELD_TYPE.text, pick: (result) => formatRows(result.fanPortrait?.city, 10) },
  { name: "省份占比TOP10", type: FIELD_TYPE.text, pick: (result) => formatRows(result.fanPortrait?.province, 10) },
  { name: "年龄占比", type: FIELD_TYPE.text, pick: (result) => formatRows(result.fanPortrait?.age) },
  { name: "城市等级占比", type: FIELD_TYPE.text, pick: (result) => formatRows(result.fanPortrait?.cityLevel) },
  { name: "设备价格占比", type: FIELD_TYPE.text, pick: (result) => formatRows(result.fanPortrait?.devicePrice) },
  { name: "设备品牌占比", type: FIELD_TYPE.text, pick: (result) => formatRows(result.fanPortrait?.deviceBrand) },
  { name: "来源平台", type: FIELD_TYPE.text, pick: (result) => result.platform || "抖音" },
  { name: "B站主页", type: FIELD_TYPE.text, pick: (result) => result.profile?.bilibiliProfileUrl },
  { name: "B站UID", type: FIELD_TYPE.text, pick: (result) => result.profile?.bilibiliUid },
  { name: "达人ID", type: FIELD_TYPE.text, pick: (result) => result.creatorId },
];

const WORK_FIELD_DEFINITIONS = [
  { name: "标题", type: FIELD_TYPE.text, pick: ({ work }) => work.title },
  {
    name: "标签",
    type: FIELD_TYPE.multiSelect,
    uiType: "MultiSelect",
    property: (result) => ({ options: uniqueStrings((result.works || []).flatMap((work) => work.tags || [])).map((name) => ({ name })) }),
    options: (result) => uniqueStrings((result.works || []).flatMap((work) => work.tags || [])),
    pick: ({ work }) => work.tags || [],
  },
  {
    name: "博主名称",
    type: FIELD_TYPE.singleSelect,
    uiType: "SingleSelect",
    property: (result) => ({ options: uniqueStrings((result.works || []).map((work) => work.authorName || result.creatorName || "未知博主")).map((name) => ({ name })) }),
    options: (result) => uniqueStrings((result.works || []).map((work) => work.authorName || result.creatorName || "未知博主")),
    pick: ({ result, work }) => work.authorName || result.creatorName || "未知博主",
  },
  {
    name: "收集人",
    type: FIELD_TYPE.text,
    pick: ({ result, work }) => String(work.collectorName || result.collectorName || "").trim() || undefined,
  },
  { name: "封面", type: FIELD_TYPE.text, pick: ({ work }) => work.coverUrl },
  { name: "点赞", type: FIELD_TYPE.number, pick: ({ work }) => integerValue(work.likeCount) },
  { name: "评论", type: FIELD_TYPE.number, pick: ({ work }) => integerValue(work.commentCount) },
  { name: "前3条热评", type: FIELD_TYPE.text, pick: ({ work }) => work.hotCommentsText },
  { name: "收藏", type: FIELD_TYPE.number, pick: ({ work }) => integerValue(work.collectCount) },
  { name: "分享", type: FIELD_TYPE.number, pick: ({ work }) => integerValue(work.shareCount) },
  { name: "作品时长", type: FIELD_TYPE.number, pick: ({ work }) => integerValue(work.durationSeconds) },
  { name: "发布日期", type: FIELD_TYPE.dateTime, uiType: "DateTime", pick: ({ work }) => work.publishTimestamp || work.publishDate },
  { name: "视频链接", type: FIELD_TYPE.text, pick: ({ work }) => work.videoLink },
  { name: "视频源网址", type: FIELD_TYPE.text, pick: ({ work }) => preferredTranscriptionMediaUrl(work) || work.videoLink },
  { name: "作品网址", type: FIELD_TYPE.text, pick: ({ work }) => work.videoLink },
  { name: BASE_TRANSCRIPTION_REQUEST_FIELD, type: FIELD_TYPE.checkbox, pick: () => undefined },
  { name: "直接转逐字稿", type: FIELD_TYPE.text, pick: ({ work }) => work.transcriptText || undefined },
  { name: "逐字稿状态", type: FIELD_TYPE.text, pick: ({ work }) => work.transcriptStatus || undefined },
  { name: "来源平台", type: FIELD_TYPE.text, pick: ({ work }) => work.platform || "抖音" },
  { name: "播放量", type: FIELD_TYPE.number, pick: ({ work }) => integerValue(work.playCount) },
  { name: "弹幕", type: FIELD_TYPE.number, pick: ({ work }) => integerValue(work.danmakuCount) },
  { name: "投币", type: FIELD_TYPE.number, pick: ({ work }) => integerValue(work.coinCount) },
];

// Keep video rows in the user-selected table; creator profiles use a separate table.
function usesConfiguredVideoTable(settings) {
  return Boolean(settings.appToken && settings.tableId);
}

function workFieldDefinitions(settings) {
  if (!usesConfiguredVideoTable(settings)) return WORK_FIELD_DEFINITIONS;
  const aliases = { "直接转逐字稿": "逐字稿", "收集人": "采集作者", "播放量": "播放量数值" };
  return WORK_FIELD_DEFINITIONS.filter((def) => def.name !== "作品网址")
    .map((def) => ({ ...def, name: aliases[def.name] || def.name }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;
  Promise.resolve()
    .then(async () => {
      if (message.type === "douhot:manualRunControl") {
        return { ok: true, data: controlManualRun(message.payload, sender?.tab?.id || 0) };
      }
      const manualRun = getManualRun(message.runId, sender?.tab?.id || 0);
      await manualRunCheckpoint(manualRun);
      if (message.type.startsWith("bilibili:")) {
        return { ok: true, data: await BiliBg.handle(message, sender, manualRun) };
      }
      if (message.type === "douhot:getSettings") {
        return { ok: true, data: await getFeishuSettings() };
      }
      if (message.type === "douhot:saveSettings") {
        await saveFeishuSettings(message.payload || {});
        void drainMonitorQueue().catch(() => undefined);
        void processBaseTranscriptionRequests().catch(() => undefined);
        return { ok: true };
      }
      if (message.type === "douhot:getCollectorName") {
        const settings = await getFeishuSettings();
        return { ok: true, data: { collectorName: settings.collectorName || "" } };
      }
      if (message.type === "douhot:saveCollectorName") {
        const current = await getFeishuSettings();
        const collectorName = String(message.payload?.collectorName || "").trim();
        await saveFeishuSettings({ ...current, collectorName });
        return { ok: true, data: { collectorName } };
      }
      if (message.type === "douhot:getTranscriptionSettings") {
        const data = await getTranscriptionSettings();
        return { ok: true, data: { ...data, apiKeyConfigured: Boolean(data.apiKey) }, models: TRANSCRIPTION_MODELS };
      }
      if (message.type === "douhot:setTranscriptionModel") {
        if (typeof message.payload?.model !== "string" || !message.payload.model.trim()) {
          throw new Error("请选择列表中的录音文件转写模型。");
        }
        const model = normalizeTranscriptionModel(message.payload?.model);
        const current = await getTranscriptionSettings();
        const data = await saveTranscriptionSettings({ ...current, model });
        return { ok: true, data: { model: data.model, enabled: data.enabled, apiKeyConfigured: Boolean(data.apiKey) } };
      }
      if (message.type === "douhot:retryAccountBlockedTranscriptions") {
        const data = await retryAccountBlockedTranscriptionJobs();
        if (data.queued) void processTranscriptionJobs().catch(() => undefined);
        return { ok: true, data };
      }
      if (message.type === "douhot:saveTranscriptionSettings") {
        const data = await saveTranscriptionSettings(message.payload || {});
        void processTranscriptionJobs().catch(() => undefined);
        void processBaseTranscriptionRequests().catch(() => undefined);
        return { ok: true, data: { ...data, apiKeyConfigured: Boolean(data.apiKey) } };
      }
      if (message.type === "douhot:setTranscriptionEnabled") {
        const current = await getTranscriptionSettings();
        const data = await saveTranscriptionSettings({
          ...current,
          enabled: message.payload?.enabled === true,
        });
        if (data.enabled) void processTranscriptionJobs().catch(() => undefined);
        void processBaseTranscriptionRequests().catch(() => undefined);
        return { ok: true, data: { ...data, apiKeyConfigured: Boolean(data.apiKey) } };
      }
      if (message.type === "douhot:getMonitorSettings") {
        return { ok: true, data: await getMonitorSettings() };
      }
      if (message.type === "douhot:saveMonitorSettings") {
        const data = await saveMonitorSettings(message.payload || {});
        if (data.enabled) {
          const monitorTab = await ensureMonitorTab({ active: false });
          if (monitorTab.tabId) await chrome.tabs.reload(monitorTab.tabId);
        } else {
          await reloadMonitorTabs();
          await setMonitorStatus({ state: "off", message: "监控已关闭", pageStatus: "off" });
          await setMonitorBadge("off");
        }
        return { ok: true, data };
      }
      if (message.type === "douhot:setMonitorEnabled") {
        const current = await getMonitorSettings();
        const data = await saveMonitorSettings({
          ...current,
          enabled: message.payload?.enabled === true,
        });
        if (data.enabled) {
          await setMonitorStatus({ state: "starting", message: "正在开启监控", pageStatus: "starting" });
          const monitorTab = await ensureMonitorTab({ active: true, force: true });
          if (monitorTab.existing && monitorTab.tabId) await chrome.tabs.reload(monitorTab.tabId);
        } else {
          await reloadMonitorTabs();
          await setMonitorStatus({ state: "off", message: "监控已关闭", pageStatus: "off" });
          await setMonitorBadge("off");
        }
        return { ok: true, data };
      }
      if (message.type === "douhot:getMonitorStatus") {
        return { ok: true, data: await getMonitorStatus() };
      }
      if (message.type === "douhot:openMonitor") {
        const data = await ensureMonitorTab({ active: true, force: true });
        return { ok: true, data };
      }
      if (message.type === "douhot:monitorTrustedClick") {
        await trustedClick(sender?.tab?.id || 0, message.point);
        return { ok: true };
      }
      if (message.type === "douhot:monitorTrustedKey") {
        await trustedKeypress(sender?.tab?.id || 0, message.key);
        return { ok: true };
      }
      if (message.type === "douhot:monitorSyncWork") {
        const data = await enqueueMonitorResult(message.payload);
        return { ok: true, data };
      }
      if (message.type === "douhot:monitorHeartbeat") {
        const payload = message.payload || {};
        const state = payload.status === "error" ? "error" : payload.status === "written" ? "ok" : "watching";
        const data = await setMonitorStatus({
          state,
          message: payload.detail || (state === "watching" ? "正在监控抖音私聊" : "监控状态已更新"),
          pageStatus: payload.status || "",
        });
        return { ok: true, data };
      }
      if (message.type === "douhot:testFeishu") {
        const data = await testFeishu(message.payload);
        return { ok: true, data };
      }
      if (message.type === "douhot:fetchDouyinApiJson") {
        const data = await fetchDouyinApiJsonForPage(message.payload?.url, manualRun);
        return { ok: true, data };
      }
      if (message.type === "douhot:resolveDouyinVisibleWork") {
        const data = await resolveDouyinVisibleWork(
          message.payload?.awemeId,
          message.payload?.videoLink,
        );
        return { ok: true, data };
      }
      if (message.type === "douhot:syncFeishu") {
        const data = await syncFeishu(message.payload, manualRun);
        return { ok: true, data };
      }
      if (message.type === "douhot:syncWorksFeishu") {
        const data = await syncWorksFeishuWithTranscription(message.payload, sender?.tab?.id || 0, manualRun);
        return { ok: true, data };
      }
      if (message.type === "douhot:fetchTopComments") {
        const data = await fetchDouyinTopComments(message.payload?.awemeId, message.payload?.videoLink, message.payload?.creatorName, sender?.tab?.id || 0, manualRun);
        return { ok: true, data };
      }
      if (message.type === "douhot:resolveCreatorId") {
        const data = await resolveDouyinCreatorId(message.payload?.input, manualRun);
        return { ok: true, data };
      }
      return { ok: false, error: `未知消息类型：${message.type}` };
    })
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function getFeishuSettings() {
  const stored = await chrome.storage.local.get({ feishu: DEFAULT_FEISHU_SETTINGS });
  const settings = { ...DEFAULT_FEISHU_SETTINGS, ...(stored.feishu || {}) };
  if (!stored.feishu?.authMode && stored.feishu?.personalBaseToken) settings.authMode = "personalBaseToken";
  return settings;
}

async function fetchDouyinApiJsonForPage(input, manualRun = null) {
  await manualRunCheckpoint(manualRun);
  const url = new URL(String(input || ""));
  const allowedPaths = new Set([
    "/aweme/v1/web/aweme/post/",
    "/aweme/v1/web/aweme/detail/",
  ]);
  if (url.origin !== "https://www.douyin.com" || !allowedPaths.has(url.pathname)) {
    throw new Error("不允许代理这个抖音接口地址");
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json, text/plain, */*" },
    ...(manualRun ? { signal: manualRun.abortController.signal } : {}),
  });
  const text = await response.text();
  if (!response.ok || !text) {
    throw new Error(`抖音接口没有返回数据（HTTP ${response.status}）`);
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error("抖音接口没有返回 JSON，可能被浏览器拦截");
  }
}

async function getTranscriptionSettings() {
  const stored = await chrome.storage.local.get({ transcription: DEFAULT_TRANSCRIPTION_SETTINGS });
  const settings = { ...DEFAULT_TRANSCRIPTION_SETTINGS, ...(stored.transcription || {}) };
  settings.model = normalizeTranscriptionModel(settings.model);
  return settings;
}

async function saveTranscriptionSettings(input) {
  const current = await getTranscriptionSettings();
  const settings = {
    enabled: input.enabled === true,
    apiKey: String(input.apiKey || "").trim(),
    model: normalizeTranscriptionModel(input.model ?? current.model),
  };
  await chrome.storage.local.set({ transcription: settings });
  return settings;
}

async function getMonitorSettings() {
  const stored = await chrome.storage.local.get({ douhotMonitor: DEFAULT_MONITOR_SETTINGS });
  return { ...DEFAULT_MONITOR_SETTINGS, ...(stored.douhotMonitor || {}) };
}

async function saveMonitorSettings(input) {
  const settings = {
    enabled: input.enabled !== false,
    targetConversation: String(input.targetConversation || DEFAULT_MONITOR_SETTINGS.targetConversation).trim(),
    selfSenderName: String(input.selfSenderName || DEFAULT_MONITOR_SETTINGS.selfSenderName).trim(),
    scanIntervalMs: DEFAULT_MONITOR_SETTINGS.scanIntervalMs,
    resolveTimeoutMs: DEFAULT_MONITOR_SETTINGS.resolveTimeoutMs,
    openOnStartup: input.openOnStartup !== false,
  };
  if (!settings.targetConversation) throw new Error("目标私聊名称不能为空");
  if (!settings.selfSenderName) throw new Error("自己的抖音昵称不能为空");
  await chrome.storage.local.set({ douhotMonitor: settings });
  return settings;
}

async function getMonitorStatus() {
  const stored = await chrome.storage.local.get({
    [MONITOR_STATUS_KEY]: {
      state: "idle",
      message: "等待监控启动",
      updatedAt: "",
      lastSuccessAt: "",
      lastError: "",
    },
  });
  return stored[MONITOR_STATUS_KEY];
}

async function setMonitorStatus(patch) {
  const current = await getMonitorStatus();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [MONITOR_STATUS_KEY]: next });
  return next;
}

function isMonitorUrl(value) {
  try {
    const url = new URL(value || "");
    return (url.hostname === "www.douyin.com" || url.hostname === "douyin.com")
      && url.searchParams.get("dycollector") === "fish";
  } catch (_error) {
    return false;
  }
}

async function ensureMonitorTab(options = {}) {
  const settings = await getMonitorSettings();
  if (!settings.enabled && !options.force) return { opened: false, reason: "disabled" };
  const tabs = await chrome.tabs.query({ url: ["https://www.douyin.com/*", "https://douyin.com/*"] });
  const existing = tabs.find((tab) => tab.id && isMonitorUrl(tab.url));
  if (existing?.id) {
    if (options.active) await chrome.tabs.update(existing.id, { active: true });
    return { opened: true, existing: true, tabId: existing.id };
  }
  const created = await chrome.tabs.create({ url: MONITOR_URL, active: options.active === true });
  return { opened: true, existing: false, tabId: created.id || 0 };
}

async function reloadMonitorTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://www.douyin.com/*", "https://douyin.com/*"] });
  const monitorTabs = tabs.filter((tab) => tab.id && isMonitorUrl(tab.url));
  await Promise.all(monitorTabs.map((tab) => chrome.tabs.reload(tab.id).catch(() => undefined)));
  return monitorTabs.length;
}

async function trustedClick(tabId, point) {
  if (!tabId || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("可信点击参数无效");
  }
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
    });
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined);
  }
}

async function trustedKeypress(tabId, key) {
  if (!tabId || key !== "Escape") throw new Error("可信按键参数无效");
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    const params = {
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    };
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      ...params,
      type: "rawKeyDown",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      ...params,
      type: "keyUp",
    });
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined);
  }
}

async function readMonitorQueue() {
  const stored = await chrome.storage.local.get({ [MONITOR_QUEUE_KEY]: [] });
  return Array.isArray(stored[MONITOR_QUEUE_KEY]) ? stored[MONITOR_QUEUE_KEY] : [];
}

async function writeMonitorQueue(queue) {
  await chrome.storage.local.set({ [MONITOR_QUEUE_KEY]: queue.slice(-300) });
}

function monitorResultKey(result) {
  return result?.works?.[0]?.videoLink || result?.works?.[0]?.awemeId || "";
}

async function setMonitorBadge(state) {
  const text = state === "ok" ? "✓" : state === "error" ? "!" : "";
  await chrome.action.setBadgeText({ text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color: state === "ok" ? "#16a34a" : "#dc2626" });
  }
}

async function enqueueMonitorResult(result) {
  const feishuSettings = await getFeishuSettings();
  result = attachCollectorName(result, feishuSettings.collectorName);
  const transcription = await getTranscriptionSettings();
  if (transcription.enabled && result?.works?.length) {
    result.transcriptionRequested = true;
    result.works = result.works.map((work) => ({
      ...work,
      transcriptionRequested: true,
      transcriptStatus: work.mediaUrl ? "等待转写" : "无法转写：缺少视频文件地址",
    }));
  }
  const key = monitorResultKey(result);
  if (!key) throw new Error("监控事件缺少视频链接");
  const queue = await readMonitorQueue();
  if (!queue.some((item) => item.key === key)) {
    queue.push({ key, result, queuedAt: new Date().toISOString() });
    await writeMonitorQueue(queue);
  }
  await setMonitorStatus({ state: "syncing", message: `正在同步：${result?.works?.[0]?.authorName || key}` });
  // Return as soon as the item is durably queued. The page can close the video
  // and process the next chat message while Feishu writes in the background.
  monitorDrainRequested = true;
  void drainMonitorQueue().catch(() => undefined);
  return { queued: true, pendingCount: queue.length };
}

async function drainMonitorQueue() {
  if (monitorDraining) return { queued: true };
  monitorDraining = true;
  try {
    let lastResult = null;
    while (true) {
      monitorDrainRequested = false;
      const queue = await readMonitorQueue();
      if (!queue.length) break;
      const item = queue[0];
      try {
        lastResult = await syncWorksFeishu(item.result);
        if (item.result?.transcriptionRequested) {
          await enqueueTranscriptionForResult(item.result, {
            completedVideoLinks: lastResult.completedVideoLinks,
            destination: lastResult.destination,
          });
        }
        // Re-read after the network request. New monitor events may have been
        // appended while this item was syncing; removing from the latest queue
        // preserves those events instead of overwriting them with a stale copy.
        const latestQueue = await readMonitorQueue();
        const remainingQueue = latestQueue.filter((queued) => queued.key !== item.key);
        await writeMonitorQueue(remainingQueue);
        const work = item.result?.works?.[0] || {};
        await setMonitorStatus({
          state: "ok",
          message: `已同步：${work.authorName || "未知博主"}`,
          lastSuccessAt: new Date().toISOString(),
          lastVideoLink: work.videoLink || item.key,
          lastTitle: work.title || "",
          lastError: "",
          pendingCount: remainingQueue.length,
        });
        await setMonitorBadge("ok");
      } catch (error) {
        const message = error?.message || String(error);
        await setMonitorStatus({
          state: "error",
          message: `同步失败：${message}`,
          lastError: message,
          pendingCount: queue.length,
        });
        await setMonitorBadge("error");
        throw error;
      }
    }
    return { queued: false, sync: lastResult };
  } finally {
    monitorDraining = false;
    // Covers an enqueue that lands after the final empty-queue read but before
    // this drain releases its lock. Failed items are otherwise left for alarms.
    if (monitorDrainRequested) void drainMonitorQueue().catch(() => undefined);
  }
}

async function readTranscriptionJobs() {
  const stored = await chrome.storage.local.get({ [TRANSCRIPTION_JOBS_KEY]: [] });
  return Array.isArray(stored[TRANSCRIPTION_JOBS_KEY]) ? stored[TRANSCRIPTION_JOBS_KEY] : [];
}

async function writeTranscriptionJobs(jobs) {
  // Unfinished tasks must never be evicted just because a batch exceeds 100.
  await chrome.storage.local.set({ [TRANSCRIPTION_JOBS_KEY]: jobs });
}

async function upsertTranscriptionJob(job) {
  return mutateTranscriptionJobs(async () => {
    const jobs = await readTranscriptionJobs();
    const index = jobs.findIndex((item) => item.key === job.key);
    if (index >= 0) jobs[index] = job;
    else jobs.push(job);
    await writeTranscriptionJobs(jobs);
  });
}

async function removeTranscriptionJob(key) {
  return mutateTranscriptionJobs(async () => {
    const jobs = await readTranscriptionJobs();
    await writeTranscriptionJobs(jobs.filter((item) => item.key !== key));
  });
}

function isTranscriptionAccountBlockedError(error) {
  return /Arrearage|overdue.payment|account is in good standing|账号欠费|账户欠费|余额不足/i.test(
    `${error?.code || ""} ${error?.message || error || ""}`,
  );
}

async function retryAccountBlockedTranscriptionJobs() {
  const settings = await getTranscriptionSettings();
  if (!settings.apiKey) throw new Error("请先保存阿里云百炼 API Key。");
  return mutateTranscriptionJobs(async () => {
    const jobs = await readTranscriptionJobs();
    let queued = 0;
    const recovered = jobs.map((job) => {
      // Only retry submissions rejected by billing. A cloud task or saved text
      // must keep its original completion path to avoid duplicate charges.
      if (job.status !== "failed" || job.taskId || job.transcriptText
        || !isTranscriptionAccountBlockedError(job.lastError)
        || !job.mediaUrl || !job.result?.works?.length) return job;
      queued += 1;
      return { ...job, status: "queued", attempts: 0, nextPollAt: 0,
        lastError: "", updatedAt: new Date().toISOString() };
    });
    if (queued) await writeTranscriptionJobs(recovered);
    return { queued };
  });
}

function normalizeHttpUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  return url.replace(/^http:\/\//i, "https://");
}

function isSeparateMediaTrackUrl(value) {
  try {
    const url = new URL(normalizeHttpUrl(value));
    // These paths identify separate playback tracks, not a complete video.
    // An MP4 extension or an HEVC codec alone does not imply a missing track.
    return /\/media-(?:video|audio)-[a-z0-9][a-z0-9._-]*(?:\/|$)/i.test(url.pathname);
  } catch (_error) {
    return false;
  }
}

function buildDouyinSourceUrl(playUri) {
  const uri = String(playUri || "").trim();
  if (!uri) return "";
  if (/^[a-z][a-z\d+.-]*:/i.test(uri) && !/^https?:\/\//i.test(uri)) return "";
  if (/^https?:\/\//i.test(uri) || uri.startsWith("//")) {
    const normalized = normalizeHttpUrl(uri);
    if (isSeparateMediaTrackUrl(normalized)) return "";
    try {
      const url = new URL(normalized);
      const videoId = url.searchParams.get("video_id") || "";
      if (url.pathname.includes("/aweme/v1/playwm/") && videoId) {
        return buildDouyinSourceUrl(videoId);
      }
      return url.toString();
    } catch (_error) {
      return normalized;
    }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(uri)) return "";
  return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=720p&line=0`;
}

function preferredTranscriptionMediaUrl(work) {
  const mediaUrl = normalizeHttpUrl(work?.mediaUrl);
  const fallbackUrl = normalizeHttpUrl(work?.mediaFallbackUrl);
  return [
    buildDouyinSourceUrl(work?.sourcePlayUri),
    /^https?:\/\//i.test(mediaUrl) ? buildDouyinSourceUrl(mediaUrl) : "",
    /^https?:\/\//i.test(fallbackUrl) ? buildDouyinSourceUrl(fallbackUrl) : "",
  ].find((url) => isUsableTranscriptionMediaUrl(url)) || "";
}

function isTranscriptionMediaDownloadError(error) {
  const value = `${error?.code || ""} ${error?.message || error || ""}`;
  return /FILE_DOWNLOAD_FAILED|FILE_403_FORBIDDEN|FILE_404_NOT_FOUND|InvalidFile\.DownloadFailed|The audio file cannot be downloaded|Failed to download (?:the )?(?:input|audio) files?/i.test(value);
}

async function migrateFailedMediaTranscriptionJobs() {
  return mutateTranscriptionJobs(async () => {
    const jobs = await readTranscriptionJobs();
    let changed = false;
    const migrated = jobs.map((original) => {
      if (original.status !== "failed"
        || original.mediaRecoveryVersion === TRANSCRIPTION_MEDIA_RECOVERY_VERSION
        || !isTranscriptionMediaDownloadError(original.lastError)) {
        return original;
      }
      changed = true;
      return {
        ...original,
        status: "queued",
        taskId: "",
        attempts: 0,
        nextPollAt: 0,
        needsMediaUpload: true,
        mediaRecoveryCount: 1,
        mediaRecoveryVersion: TRANSCRIPTION_MEDIA_RECOVERY_VERSION,
        sourceDownloadError: original.lastError,
        updatedAt: new Date().toISOString(),
      };
    });
    if (changed) await writeTranscriptionJobs(migrated);
    return { migrated: changed };
  });
}

function transcriptionDestination(settings) {
  return { appToken: settings.appToken, tableId: settings.tableId };
}

function checkTranscriptionDestination(destination, settings) {
  if (destination && (destination.appToken !== settings.appToken || destination.tableId !== settings.tableId)) {
    const error = new Error("目标表已更改，旧转写任务已保留；请恢复入队时的飞书目标后继续。");
    error.code = "DESTINATION_CHANGED";
    throw error;
  }
}

async function enqueueTranscriptionForResult(result, { completedVideoLinks = [], startProcessing = true, destination = null } = {}) {
  const capturedDestination = destination || transcriptionDestination(await getFeishuSettings());
  const completed = new Set(completedVideoLinks);
  const queueResult = await mutateTranscriptionJobs(async () => {
    const jobs = await readTranscriptionJobs();
    let queued = 0;
    let existingCount = 0;
    let completedCount = 0;
    let skipped = 0;
    for (const work of result?.works || []) {
      if (!work.transcriptionRequested) continue;
      if (completed.has(work.videoLink)) {
        completedCount += 1;
        continue;
      }
      const mediaUrl = preferredTranscriptionMediaUrl(work);
      if (!mediaUrl || !work.videoLink) {
        skipped += 1;
        continue;
      }
      const existing = jobs.find((item) => item.key === work.videoLink);
      if (existing) {
        checkTranscriptionDestination(existing.destination, capturedDestination);
        if (existing.status === "failed" && mediaUrl) {
          const needsMediaUpload = Boolean(work.transcriptionMediaRecoveryRequested
            || isTranscriptionMediaDownloadError(existing.sourceDownloadError || existing.lastError));
          Object.assign(existing, {
            ...existing,
            mediaUrl,
            result: { ...result, works: [{ ...work, mediaUrl }] },
            status: "queued",
            taskId: "",
            attempts: 0,
            needsMediaUpload,
            mediaRecoveryCount: needsMediaUpload ? 1 : 0,
            mediaRecoveryVersion: TRANSCRIPTION_MEDIA_RECOVERY_VERSION,
            sourceDownloadError: needsMediaUpload ? existing.sourceDownloadError || existing.lastError : "",
            nextPollAt: 0,
            sourceUrlStrategy: DOUYIN_SOURCE_STRATEGY,
            updatedAt: new Date().toISOString(),
            lastError: "",
          });
          queued += 1;
        } else {
          existingCount += 1;
        }
        continue;
      }
      jobs.push({
        key: work.videoLink,
        destination: capturedDestination,
        mediaUrl,
        result: { ...result, works: [{ ...work, mediaUrl }] },
        status: "queued",
        taskId: "",
        attempts: 0,
        needsMediaUpload: Boolean(work.transcriptionMediaRecoveryRequested),
        mediaRecoveryCount: work.transcriptionMediaRecoveryRequested ? 1 : 0,
        mediaRecoveryVersion: TRANSCRIPTION_MEDIA_RECOVERY_VERSION,
        nextPollAt: 0,
        sourceUrlStrategy: DOUYIN_SOURCE_STRATEGY,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: "",
      });
      queued += 1;
    }
    if (queued) await writeTranscriptionJobs(jobs);
    return { queued, existing: existingCount, completed: completedCount, skipped };
  });
  if (queueResult.queued && startProcessing) void processTranscriptionJobs().catch(() => undefined);
  return queueResult;
}

async function processTranscriptionJobs() {
  if (transcriptionProcessing) return { running: true };
  transcriptionProcessing = true;
  try {
    const settings = await getTranscriptionSettings();

    const jobs = await readTranscriptionJobs();
    const pending = jobs.filter((job) =>
      ACTIVE_TRANSCRIPTION_JOB_STATUSES.has(job.status)
      && Number(job.nextPollAt || 0) <= Date.now());

    for (const originalJob of pending) {
      let job = { ...originalJob };
      try {
        checkTranscriptionDestination(job.destination, await getFeishuSettings());
        if (job.status === "sync_pending") {
          await updateTranscriptionRecord(job, job.transcriptStatus, job.transcriptText);
          await removeTranscriptionJob(job.key);
          continue;
        }
        if (!settings.apiKey) continue;
        if (job.status === "queued") {
          // Read again for each submission so a saved switch also applies to
          // queued jobs in a batch that is already being processed.
          const submissionSettings = await getTranscriptionSettings();
          if (!submissionSettings.apiKey) continue;
          let submissionUrl = job.mediaUrl;
          if (job.needsMediaUpload) {
            await updateTranscriptionRecord(job, "正在重新获取视频文件").catch(() => undefined);
            const { blob, ...recovered } = await recoverTranscriptionMedia(job);
            job = { ...job, ...recovered };
            // Keep only the real source URL in storage/Feishu. The temporary
            // file is bound to this exact model/key and submitted immediately.
            await upsertTranscriptionJob(job);
            await updateTranscriptionRecord(job, "正在上传视频文件后转写").catch(() => undefined);
            submissionUrl = await uploadDashScopeTranscriptionMedia(submissionSettings, blob);
          }
          checkTranscriptionDestination(job.destination, await getFeishuSettings());
          const submitted = await submitDashScopeTranscription(submissionSettings, submissionUrl, { temporary: job.needsMediaUpload });
          job = {
            ...job,
            status: "submitted",
            taskId: submitted.taskId,
            model: submitted.model,
            nextPollAt: Date.now() + 30000,
            updatedAt: new Date().toISOString(),
            lastError: "",
          };
          await upsertTranscriptionJob(job);
          await updateTranscriptionRecord(job, "转写中").catch(() => undefined);
          continue;
        }

        const polled = await pollDashScopeTranscription(settings, job.taskId);
        if (polled.status === "PENDING" || polled.status === "RUNNING") {
          job.nextPollAt = Date.now() + 30000;
          job.updatedAt = new Date().toISOString();
          await upsertTranscriptionJob(job);
          await updateTranscriptionRecord(job, "转写中").catch(() => undefined);
          continue;
        }
        if (polled.status !== "SUCCEEDED" || polled.subtaskStatus === "FAILED" || !polled.transcriptionUrl) {
          const error = new Error(polled.error || `阿里云转写任务状态：${polled.status || "未知"}`);
          error.code = polled.errorCode;
          throw error;
        }

        const transcriptText = await fetchDashScopeTranscript(polled.transcriptionUrl);
        const limit = 90000;
        const finalText = transcriptText.length > limit ? `${transcriptText.slice(0, limit)}\n\n[逐字稿过长，已截断]` : transcriptText;
        const finalStatus = transcriptText.length > limit ? "已完成（内容过长已截断）" : "已完成";
        // Persist the successful result before touching Feishu. Sync failures
        // retry this exact text, even after worker restart or API key removal.
        job = {
          ...job, status: "sync_pending", transcriptText: finalText, transcriptStatus: finalStatus,
          syncAttempts: 0, nextPollAt: 0, updatedAt: new Date().toISOString(),
        };
        await upsertTranscriptionJob(job);
        await updateTranscriptionRecord(job, finalStatus, finalText);
        await removeTranscriptionJob(job.key);
      } catch (error) {
        if (error?.code === "DESTINATION_CHANGED") {
          await upsertTranscriptionJob({ ...job, nextPollAt: Date.now() + 60000,
            updatedAt: new Date().toISOString(), lastError: error.message });
          continue;
        }
        if (job.status === "sync_pending") {
          await upsertTranscriptionJob({
            ...job, syncAttempts: Number(job.syncAttempts || 0) + 1,
            nextPollAt: Date.now() + 60000, updatedAt: new Date().toISOString(),
            lastError: `逐字稿回写失败：${error?.message || String(error)}`,
          });
          continue;
        }
        if (isTranscriptionMediaDownloadError(error) && !job.needsMediaUpload && !job.mediaRecoveryCount) {
          job = {
            ...job, status: "queued", taskId: "", attempts: 0,
            nextPollAt: Date.now() + 1000, needsMediaUpload: true, mediaRecoveryCount: 1,
            mediaRecoveryVersion: TRANSCRIPTION_MEDIA_RECOVERY_VERSION,
            sourceDownloadError: error.code || error.message,
            updatedAt: new Date().toISOString(), lastError: error.message,
          };
          await upsertTranscriptionJob(job);
          await updateTranscriptionRecord(job, "视频下载失败，正在重新获取文件").catch(() => undefined);
          continue;
        }
        const attempts = Number(job.attempts || 0) + 1;
        const message = isTranscriptionMediaDownloadError(error) && job.needsMediaUpload
          ? `阿里云仍无法下载已上传文件：${error.code || error.message}` : error?.message || String(error);
        const failed = attempts >= 3 || (job.status === "submitted" && isTranscriptionMediaDownloadError(error));
        job = {
          ...job,
          status: failed ? "failed" : job.status,
          attempts,
          nextPollAt: Date.now() + (failed ? 0 : 60000),
          updatedAt: new Date().toISOString(),
          lastError: message,
        };
        await upsertTranscriptionJob(job);
        if (failed) await updateTranscriptionRecord(job, `转写失败：${message.slice(0, 120)}`).catch(() => undefined);
      }
    }
    return { processed: pending.length, ...(!settings.apiKey ? { blocked: true, reason: "missing-api-key" } : {}) };
  } finally {
    transcriptionProcessing = false;
  }
}

async function withTranscriptionMediaTimeout(operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("视频文件请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function transcriptionMediaFormat(bytes) {
  const tag = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  if (tag(4, 4) === "ftyp") return { extension: "mp4", type: "video/mp4" };
  if (tag(0, 4) === "RIFF" && tag(8, 4) === "WAVE") return { extension: "wav", type: "audio/wav" };
  if (tag(0, 4) === "OggS") return { extension: "ogg", type: "audio/ogg" };
  if (tag(0, 4) === "fLaC") return { extension: "flac", type: "audio/flac" };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { extension: "webm", type: "video/webm" };
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return { extension: "aac", type: "audio/aac" };
  if (tag(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { extension: "mp3", type: "audio/mpeg" };
  return null;
}

async function downloadTranscriptionMedia(url) {
  if (!isUsableTranscriptionMediaUrl(url)) throw new Error("不是完整音视频文件地址");
  return withTranscriptionMediaTimeout(async (signal) => {
    const response = await fetch(url, { method: "GET", redirect: "follow", credentials: "include", cache: "no-store", signal });
    let reader;
    try {
      if (!response.ok || response.status !== 200) throw new Error(`视频源下载 HTTP ${response.status}`);
      const mediaUrl = normalizeHttpUrl(response.url || url);
      if (!isUsableTranscriptionMediaUrl(mediaUrl)) throw new Error("视频源跳转到了页面或分离轨道");
      if (/text\/|json|xml/i.test(response.headers.get("Content-Type") || "")) throw new Error("视频源返回的是网页或错误信息");
      if (Number(response.headers.get("Content-Length") || 0) > TRANSCRIPTION_MEDIA_MAX_BYTES) throw new Error("视频超过 100MB，无法自动上传补转");
      reader = response.body?.getReader();
      if (!reader) throw new Error("视频源没有返回文件内容");
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > TRANSCRIPTION_MEDIA_MAX_BYTES) throw new Error("视频超过 100MB，无法自动上传补转");
        chunks.push(value);
      }
      if (size < 12) throw new Error("视频源返回了空文件或不完整文件");
      const blob = new Blob(chunks);
      const format = transcriptionMediaFormat(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
      if (!format) throw new Error("视频源内容不是可识别的音视频文件");
      return { blob: new Blob(chunks, { type: format.type }), mediaUrl };
    } finally {
      if (reader) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    }
  });
}

async function recoverTranscriptionMedia(job) {
  if (isBilibiliVideoLink(job.result?.works?.[0]?.videoLink || job.key)) return BiliBg.recoverMedia(job);
  const originalWork = job.result?.works?.[0] || {};
  const id = String(originalWork.awemeId || originalWork.id || extractAwemeIdFromVideoLink(job.key) || "");
  let freshWork = null;
  let lookupError = "";
  if (/^\d{8,}$/.test(id)) {
    try {
      freshWork = await resolveDouyinWorkForTranscription(id, originalWork.videoLink || job.key);
      if (!douyinWorkMatchesId(freshWork, id)) throw new Error("重新读取的作品 ID 不匹配");
    } catch (error) {
      freshWork = null;
      lookupError = safeMediaLookupError(error);
    }
  }
  const candidates = [...new Set([
    preferredTranscriptionMediaUrl(freshWork),
    normalizeHttpUrl(freshWork?.mediaFallbackUrl),
    normalizeHttpUrl(freshWork?.mediaUrl),
    normalizeHttpUrl(originalWork.mediaFallbackUrl),
    normalizeHttpUrl(job.mediaUrl),
  ].filter(isUsableTranscriptionMediaUrl))].slice(0, 4);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const downloaded = await downloadTranscriptionMedia(candidate);
      return {
        ...downloaded,
        result: { ...job.result, works: [{ ...originalWork, sourcePlayUri: "",
          mediaUrl: downloaded.mediaUrl, mediaFallbackUrl: downloaded.mediaUrl }] },
      };
    } catch (error) {
      failures.push(safeMediaLookupError(error));
    }
  }
  throw new Error(`视频文件获取失败：${[lookupError, ...failures].filter(Boolean).join("；") || "没有可用视频源"}；请保持抖音登录并重新打开原视频采集`);
}

async function uploadDashScopeTranscriptionMedia(settings, blob) {
  const model = normalizeTranscriptionModel(settings.model);
  if (!blob?.size || blob.size > TRANSCRIPTION_MEDIA_MAX_BYTES) throw new Error("上传文件为空或超过 100MB");
  const query = new URLSearchParams({ action: "getPolicy", model });
  const json = await withTranscriptionMediaTimeout(async (signal) => {
    const response = await fetch(`${DASHSCOPE_API_BASE}/uploads?${query}`, {
      method: "GET", credentials: "omit", cache: "no-store", signal, headers: { Authorization: `Bearer ${settings.apiKey}` },
    });
    return readJsonResponse(response, "获取阿里云临时上传凭证失败");
  });
  const policy = json?.data;
  const host = new URL(policy?.upload_host || "https://invalid.local");
  if (host.protocol !== "https:" || !host.hostname.endsWith(".aliyuncs.com") || host.username || host.password
    || !policy?.upload_dir || ["oss_access_key_id", "signature", "policy", "x_oss_object_acl", "x_oss_forbid_overwrite"].some((name) => policy[name] === undefined)) {
    throw new Error("阿里云返回的临时上传凭证不完整或地址无效");
  }
  const format = transcriptionMediaFormat(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
  if (!format) throw new Error("上传文件格式无法识别");
  const filename = `douhot-${crypto.randomUUID()}.${format.extension}`;
  const key = `${String(policy.upload_dir).replace(/\/$/, "")}/${filename}`;
  const form = new FormData();
  for (const [name, value] of Object.entries({
    OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy,
    "x-oss-object-acl": policy.x_oss_object_acl, "x-oss-forbid-overwrite": policy.x_oss_forbid_overwrite,
    key, success_action_status: "200",
  })) form.append(name, String(value));
  form.append("file", blob, filename);
  await withTranscriptionMediaTimeout(async (signal) => {
    const response = await fetch(host.toString(), { method: "POST", credentials: "omit", body: form, signal });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error(`阿里云临时文件上传失败：HTTP ${response.status}`);
  });
  return `oss://${key}`;
}

async function submitDashScopeTranscription(settings, mediaUrl, { temporary = false } = {}) {
  const isTemporary = temporary && /^oss:\/\/[^/?#\s]+\/[^?#\s]+$/.test(mediaUrl || "");
  if (!isTemporary && !/^https?:\/\//i.test(mediaUrl || "")) throw new Error("视频文件地址不是公网 HTTP/HTTPS URL");
  if (isSeparateMediaTrackUrl(mediaUrl)) throw new Error("视频源是分离轨道，缺少完整音视频；请重新采集或补转");
  const model = normalizeTranscriptionModel(settings.model);
  // Qwen3 and its dated version use file_url. Qwen-Audio 3.x and the
  // other families use file_urls with a required parameters object.
  const isQwenFiletrans = model.startsWith("qwen3-asr-flash-filetrans");
  const parameters = { channel_id: [0] };
  // Paraformer V1/MTL do not accept language_hints; Fun-ASR accepts only
  // one hint. Leave language detection automatic for these models.
  if (model === "paraformer-v2") parameters.language_hints = ["zh", "en"];
  if (isQwenFiletrans) parameters.enable_itn = false;
  const response = await fetch(`${DASHSCOPE_API_BASE}/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      ...(isTemporary ? { "X-DashScope-OssResourceResolve": "enable" } : {}),
    },
    body: JSON.stringify({
      model,
      input: isQwenFiletrans ? { file_url: mediaUrl } : { file_urls: [mediaUrl] },
      parameters,
    }),
  });
  const json = await readJsonResponse(response, "阿里云转写任务提交失败");
  const taskId = json?.output?.task_id || "";
  if (!taskId) throw new Error(json?.message || json?.code || "阿里云没有返回 task_id");
  return { taskId, model };
}

async function pollDashScopeTranscription(settings, taskId) {
  if (!taskId) throw new Error("阿里云转写任务缺少 task_id");
  const response = await fetch(`${DASHSCOPE_API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
  });
  const json = await readJsonResponse(response, "查询阿里云转写任务失败");
  const output = json?.output || {};
  const result = output.result || (Array.isArray(output.results) ? output.results[0] || {} : {});
  return {
    status: output.task_status || "",
    transcriptionUrl: result.transcription_url || "",
    subtaskStatus: result.subtask_status || "",
    errorCode: result.code || output.code || json?.code || "",
    error: result.message || result.code || output.message || output.code || json?.message || json?.code || "",
  };
}

async function fetchDashScopeTranscript(url) {
  const response = await fetch(url, { method: "GET" });
  const json = await readJsonResponse(response, "下载阿里云逐字稿失败");
  const transcripts = Array.isArray(json?.transcripts)
    ? json.transcripts
    : Array.isArray(json?.output?.transcripts) ? json.output.transcripts : [];
  const paragraphs = transcripts.map((transcript) => {
    if (String(transcript?.text || "").trim()) return String(transcript.text).trim();
    return (transcript?.sentences || []).map((sentence) => String(sentence?.text || "").trim()).filter(Boolean).join("\n");
  }).filter(Boolean);
  if (!paragraphs.length) throw new Error("阿里云返回的转写结果中没有文字");
  return paragraphs.join("\n\n");
}

async function readJsonResponse(response, fallback) {
  let json = null;
  try {
    json = await response.json();
  } catch (_error) {
    throw new Error(`${fallback}：HTTP ${response.status}`);
  }
  if (!response.ok || json?.code) {
    const detail = isTranscriptionAccountBlockedError({ code: json?.code, message: json?.message })
      ? "阿里云账号欠费或余额不足；充值到账后，在插件设置点击「重试欠费失败的转写」。"
      : json?.message || json?.code || response.status;
    const error = new Error(`${fallback}：${detail}`);
    error.code = json?.code || "";
    throw error;
  }
  return json;
}

async function updateTranscriptionRecord(job, status, transcriptText) {
  const result = {
    ...job.result,
    works: (job.result?.works || []).map((work) => ({
      ...work,
      transcriptStatus: status,
      transcriptText,
    })),
  };
  return syncWorksFeishu(result, null, { transcriptionUpdate: true, destination: job.destination });
}

async function resolveDouyinCreatorId(input, manualRun = null) {
  const direct = parseCreatorIdFromText(input);
  if (direct) return { creatorId: direct, source: "direct" };

  let url = extractFirstUrl(input);
  let lastError = "";
  for (let attempt = 0; attempt < 3 && url; attempt += 1) {
    await manualRunCheckpoint(manualRun);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        credentials: "include",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        ...(manualRun ? { signal: manualRun.abortController.signal } : {}),
      });
      const finalUrl = response.url || url;
      const fromFinalUrl = parseCreatorIdFromText(finalUrl);
      if (fromFinalUrl) return { creatorId: fromFinalUrl, source: "redirect", url: finalUrl };

      const text = await response.text();
      const fromHtml = parseCreatorIdFromText(text) || extractCreatorIdFromDouyinHtml(text);
      if (fromHtml) return { creatorId: fromHtml, source: "html", url: finalUrl };

      const nextUrl = extractRedirectUrl(text, finalUrl);
      if (!nextUrl || nextUrl === url) break;
      url = nextUrl;
    } catch (error) {
      if (manualRun?.ended) throw manualRunError(manualRun.ended);
      lastError = error.message || String(error);
      break;
    }
  }
  return { creatorId: "", error: lastError };
}

async function saveFeishuSettings(input) {
  const settings = {
    enabled: Boolean(input.enabled),
    collectorName: String(input.collectorName || "").trim(),
    authMode: ["openApi", "personalBaseToken"].includes(input.authMode) ? input.authMode : "personalBaseToken",
    personalBaseToken: String(input.personalBaseToken || "").trim(),
    appId: String(input.appId || "").trim(),
    appSecret: String(input.appSecret || "").trim(),
    appToken: String(input.appToken || "").trim(),
    tableId: String(input.tableId || "").trim(),
    autoCreateFields: input.autoCreateFields !== false,
    upsertByCreatorId: input.upsertByCreatorId !== false,
  };
  const previous = await getFeishuSettings();
  const authChanged = ["authMode", "appId", "appSecret"].some((key) => previous[key] !== settings[key]);
  await chrome.storage.local.set({ feishu: settings, ...(authChanged ? { feishuTokenCache: null } : {}) });
}

async function testFeishu(inputSettings) {
  const settings = normalizeSettings(inputSettings || (await getFeishuSettings()));
  const auth = await getFeishuAuth(settings);
  const fields = await listFields(settings, auth);
  const records = await feishuApi("GET",
    `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(settings.tableId)}/records?page_size=1`, auth);
  if (!Array.isArray(records?.items)) throw new Error("飞书记录查询返回格式异常，暂不能确认连接可用于同步。");
  return {
    fieldCount: fields.length,
    recordsReadable: Array.isArray(records?.items),
    tableId: settings.tableId,
    appToken: settings.appToken,
    authMode: settings.authMode,
  };
}

async function syncFeishu(result, manualRun = null) {
  await manualRunCheckpoint(manualRun);
  if (!result) throw new Error("没有收到达人数据。");
  let settings = normalizeSettings(await getFeishuSettings());

  const auth = await getFeishuAuth(settings, manualRun);
  const defs = FIELD_DEFINITIONS;
  if (usesConfiguredVideoTable(settings)) {
    const table = await mutateWorksTable(settings, "creator-table-init", async () => {
      const tables = await listTables(settings, auth);
      const existing = tables.find((item) => (item.name || item.table_name) === "小乐达人档案");
      if (existing) return existing;
      const created = await feishuApi("POST", `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables`, auth,
        { table: { name: "小乐达人档案", default_view_name: "达人资料", fields: defs.map((def) => buildFieldCreatePayload(def, result)) } });
      return created.table || created;
    });
    const creatorTableId = table.table_id || table.tableId || table.id;
    if (!creatorTableId) throw new Error("未能取得达人资料表，请重试。");
    settings = { ...settings, tableId: creatorTableId };
  }
  const ensureResult = await ensureFields(settings, auth, defs, result);
  const fieldsPayload = buildRecordFields(result, defs, ensureResult.fieldByName, ensureResult.fieldOrder);

  if (Object.keys(fieldsPayload).length === 0) {
    throw new Error("没有可写入的字段，请检查表格字段配置。");
  }

  const existingRecordId = settings.upsertByCreatorId
    ? await findRecordIdByCreatorId(settings, auth, ensureResult.fieldByName, result.creatorId)
    : "";

  const endpoint = `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(settings.tableId)}/records`;
  const saved = existingRecordId
    ? await feishuApi("PUT", `${endpoint}/${encodeURIComponent(existingRecordId)}`, auth, { fields: fieldsPayload })
    : await feishuApi("POST", endpoint, auth, { fields: fieldsPayload });

  return {
    recordId: saved?.record?.record_id || saved?.record_id || existingRecordId || "",
    operation: existingRecordId ? "updated" : "created",
    createdFields: ensureResult.createdFields,
    skippedFields: ensureResult.skippedFields,
  };
}

async function syncWorksFeishu(result, manualRun = null, { transcriptionUpdate = false, destination = null } = {}) {
  await manualRunCheckpoint(manualRun);
  if (!result?.works?.length) throw new Error("没有收到作品数据。");
  const settings = normalizeSettings(await getFeishuSettings());
  checkTranscriptionDestination(destination, settings);
  result = attachCollectorName(result, settings.collectorName);
  const auth = await getFeishuAuth(settings, manualRun);
  const table = await getOrCreateWorksTable(settings, auth, result);
  const tableId = table.table_id || table.tableId;
  if (!tableId) throw new Error("没有拿到视频数据表 ID。");

  const defs = workFieldDefinitions(settings);
  const transcriptField = usesConfiguredVideoTable(settings) ? "逐字稿" : "直接转逐字稿";
  const ensureResult = await ensureFields(settings, auth, defs, result, tableId);
  if (!transcriptionUpdate) await ensureDynamicOptions(settings, auth, tableId, ensureResult.fieldByName, defs, result);
  if (transcriptionUpdate && (!ensureResult.fieldByName.has("逐字稿状态")
    || (result.works.some((work) => work.transcriptText !== undefined) && !ensureResult.fieldByName.has(transcriptField)))) {
    throw new Error("缺少逐字稿或状态字段，转写结果已保留，等待表格字段恢复后回写。");
  }

  const fieldsPayloads = result.works
    .map((work) => buildWorkRecordFields(result, work, defs, ensureResult.fieldByName, ensureResult.fieldOrder))
    .filter((fields) => fields["视频链接"] || fields["标题"]);
  if (!fieldsPayloads.length) {
    throw new Error("没有可写入的作品字段，请检查采集结果。");
  }

  return mutateWorksTable(settings, tableId, async () => {
    // Read the current text/status inside the same lock as writes. Concurrent
    // metadata syncs and completed-task writes cannot apply stale row snapshots.
    const records = await listWorksTableRecords(settings, auth, tableId);
    const existingByLink = new Map(records.map((record) => [
      normalizeReadValue(readBaseRecordField(record, ensureResult.fieldByName, "视频链接")), record,
    ]));
    const activeLinks = new Set((await readTranscriptionJobs())
      .filter((job) => ACTIVE_TRANSCRIPTION_JOB_STATUSES.has(job.status)).map((job) => job.key));
    const completedVideoLinks = [];
    let created = 0;
    let updated = 0;
    const endpoint = `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/records`;

    for (const fields of fieldsPayloads) {
      await manualRunCheckpoint(manualRun);
      const link = normalizeReadValue(fields["视频链接"]);
      const existingRecord = link ? existingByLink.get(link) : null;
      const existingRecordId = existingRecord?.record_id || "";
      if (existingRecordId) {
        if (transcriptionUpdate) {
          // Progress/completion must not overwrite titles, counts or other
          // metadata captured before a user edited the record.
          for (const name of Object.keys(fields)) {
            if (!["逐字稿状态", transcriptField, "视频源网址"].includes(name)) delete fields[name];
          }
        } else {
          const text = readRecordTranscript(existingRecord, ensureResult.fieldByName);
          const status = normalizeReadValue(readBaseRecordField(existingRecord, ensureResult.fieldByName, "逐字稿状态")).trim();
          if (text || status) {
            delete fields[transcriptField];
            delete fields["逐字稿状态"];
          }
          const canUseCompletedText = text
            && !isCheckedCell(readBaseRecordField(existingRecord, ensureResult.fieldByName, BASE_TRANSCRIPTION_REQUEST_FIELD))
            && (status.startsWith("已完成") || (!activeLinks.has(link) && (!status || isStaleTranscriptionStatus(status))));
          if (canUseCompletedText) {
            completedVideoLinks.push(link);
            if (ensureResult.fieldByName.has("逐字稿状态") && !status.startsWith("已完成")) {
              fields["逐字稿状态"] = completedTranscriptStatus(text);
            }
          }
        }
        await feishuApi("PUT", `${endpoint}/${encodeURIComponent(existingRecordId)}`, auth, { fields });
        updated += 1;
      } else {
        const saved = await feishuApi("POST", endpoint, auth, { fields });
        const recordId = saved?.record?.record_id || saved?.record_id || "";
        if (link && recordId) existingByLink.set(link, { record_id: recordId, fields: { ...fields } });
        created += 1;
      }
    }

    return {
      tableId,
      destination: transcriptionDestination(settings),
      tableName: table.name || table.table_name || DEFAULT_WORKS_TABLE_NAME,
      created,
      updated,
      total: fieldsPayloads.length,
      createdFields: ensureResult.createdFields,
      skippedFields: ensureResult.skippedFields,
      completedVideoLinks,
    };
  });
}

async function syncWorksFeishuWithTranscription(result, sourceTabId = 0, manualRun = null) {
  await manualRunCheckpoint(manualRun);
  if (!result?.transcriptionRequested) {
    return syncWorksFeishu(result, manualRun);
  }

  const transcriptionSettings = await getTranscriptionSettings();
  const feishuSettings = await getFeishuSettings();
  const apiKeyConfigured = Boolean(transcriptionSettings.apiKey);
  const attributedResult = attachCollectorName(result, feishuSettings.collectorName);
  const preparedWorks = [];
  for (const work of attributedResult.works || []) {
    await manualRunCheckpoint(manualRun);
    preparedWorks.push(await prepareWorkForTranscription(work, apiKeyConfigured, sourceTabId, manualRun));
  }
  const preparedResult = {
    ...attributedResult,
    transcriptionRequested: true,
    works: preparedWorks,
  };

  const syncResult = await syncWorksFeishu(preparedResult, manualRun);
  if (!apiKeyConfigured) {
    return {
      ...syncResult,
      transcription: {
        requested: true,
        queued: 0,
        existing: 0,
        skipped: preparedResult.works.length,
        missingApiKey: true,
      },
    };
  }

  await manualRunCheckpoint(manualRun);
  const queueResult = await enqueueTranscriptionForResult(preparedResult, {
    completedVideoLinks: syncResult.completedVideoLinks,
    destination: syncResult.destination,
  });
  return {
    ...syncResult,
    transcription: {
      requested: true,
      missingApiKey: false,
      ...queueResult,
      mediaLookupError: preparedResult.works.find((work) => !syncResult.completedVideoLinks?.includes(work.videoLink) && !work.mediaUrl && work.mediaLookupError)?.mediaLookupError || "",
    },
  };
}

async function prepareWorkForTranscription(inputWork, apiKeyConfigured, sourceTabId = 0, manualRun = null) {
  await manualRunCheckpoint(manualRun);
  if (isBilibiliVideoLink(inputWork?.videoLink)) {
    let work = { ...inputWork, transcriptionRequested: true };
    if (!apiKeyConfigured) return { ...work, transcriptStatus: "未转写：请先配置阿里云 API Key" };
    try {
      const resolved = await BiliBg.resolveWorkAudio(work.videoLink, manualRun);
      work = { ...work, cid: resolved.cid, mediaUrl: resolved.mediaUrl, mediaFallbackUrl: resolved.mediaFallbackUrl,
        mediaAlternatives: resolved.mediaAlternatives, transcriptionMediaRecoveryRequested: true, transcriptStatus: "等待转写" };
    } catch (error) {
      if (error.code === "MANUAL_RUN_ENDED") throw error;
      work = { ...work, mediaUrl: "", mediaLookupError: safeMediaLookupError(error), transcriptStatus: "无法转写：B站音轨读取失败" };
    }
    return work;
  }
  let work = { ...(inputWork || {}) };
  let mediaUrl = preferredTranscriptionMediaUrl(work);
  let mediaLookupError = "";
  const isNote = isDouyinNoteWork(work);

  // 首页弹窗或主页卡片有时只暴露标题和互动数。只要是视频且有作品 ID，
  // 在写入飞书前再通过后台/登录中的抖音页补取一次真实播放地址。
  if (apiKeyConfigured && !isNote && !isUsableTranscriptionMediaUrl(mediaUrl)) {
    const awemeId = String(work.awemeId || work.id || extractAwemeIdFromVideoLink(work.videoLink) || "").trim();
    if (awemeId) {
      await manualRunCheckpoint(manualRun);
      const loadedMediaUrl = await resolveLoadedDouyinMediaUrl(sourceTabId, awemeId);
      if (loadedMediaUrl) {
        work.mediaFallbackUrl = loadedMediaUrl;
        mediaUrl = loadedMediaUrl;
      }
    }
    if (awemeId && !isUsableTranscriptionMediaUrl(mediaUrl)) {
      try {
        await manualRunCheckpoint(manualRun);
        const resolved = await resolveDouyinWorkForTranscription(awemeId, work.videoLink, manualRun);
        work = mergeResolvedTranscriptionWork(work, resolved);
        mediaUrl = preferredTranscriptionMediaUrl(work);
        if (!isUsableTranscriptionMediaUrl(mediaUrl)) mediaLookupError = "详情补取未返回可用媒体";
      } catch (error) {
        if (error?.code === "MANUAL_RUN_ENDED") throw error;
        mediaLookupError = safeMediaLookupError(error);
        // The row is still synced; the explicit status below distinguishes a
        // failed media lookup from an image-note that has no video by design.
      }
    }
    if (!awemeId) mediaLookupError = "采集结果没有作品 ID";
  }

  const usableMediaUrl = isUsableTranscriptionMediaUrl(mediaUrl) ? mediaUrl : "";
  return {
    ...work,
    mediaUrl: usableMediaUrl,
    mediaLookupError: usableMediaUrl ? "" : mediaLookupError,
    transcriptionRequested: true,
    transcriptStatus: !apiKeyConfigured
      ? "未转写：请先配置阿里云 API Key"
      : isNote
        ? "无法转写：图文作品没有视频文件"
        : usableMediaUrl
          ? "等待转写"
          : "无法转写：未能读取视频文件地址",
  };
}

function safeMediaLookupError(error) {
  return String(error?.message || error || "媒体读取失败")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/\b(?:authorization|cookie|token|api[_-]?key|sign(?:ature)?)\s*[:=]\s*[^\s,;]+/gi, "[已隐藏凭据]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 200);
}

async function resolveLoadedDouyinMediaUrl(tabId, awemeId) {
  const work = await readLoadedDouyinWorkMedia(tabId, awemeId);
  return work ? preferredTranscriptionMediaUrl(work) : "";
}

function douyinWorkMatchesId(work, awemeId) {
  if (!work || typeof work !== "object" || !/^\d{8,}$/.test(String(awemeId || ""))) return false;
  const ids = [work.aweme_id, work.awemeId, work.id]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => String(value).trim());
  for (const link of [work.videoLink, work.share_url, work.shareUrl, work.url]) {
    const id = extractAwemeIdFromVideoLink(link);
    if (id) ids.push(id);
  }
  return ids.length > 0 && ids.every((id) => id === String(awemeId));
}

async function readLoadedDouyinWorkMedia(tabId, awemeId) {
  const id = String(awemeId || "").trim();
  if (!tabId || !/^\d{8,}$/.test(id)) return null;
  try {
    const response = await chromePromise(chrome.tabs.sendMessage, tabId, {
      type: "douhot:readLoadedWorkMedia",
      awemeId: id,
    });
    if (!response?.ok) return null;
    const work = response?.data?.work || response?.work;
    return douyinWorkMatchesId(work, id) ? work : null;
  } catch (_error) {
    return null;
  }
}

function isMatchingDouyinDetailUrl(value, awemeId) {
  try {
    const url = new URL(value);
    return ["www.douyin.com", "douyin.com"].includes(url.hostname)
      && url.pathname.replace(/\/$/, "") === `/video/${awemeId}`
      && extractAwemeIdFromVideoLink(url.toString()) === String(awemeId);
  } catch (_error) {
    return false;
  }
}

function douyinMediaResourceIdentity(value) {
  const url = new URL(normalizeHttpUrl(value));
  for (const name of Array.from(url.searchParams.keys())) {
    if (/^(?:range|bytestart|byteend|byte_start|byte_end)$/i.test(name)) url.searchParams.delete(name);
  }
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

async function resolveUniqueFreshDouyinMediaUrl(tabId, awemeId, debuggerAlreadyAttached = false, diagnostics = null) {
  // Only pages created for this lookup are eligible: an existing feed keeps
  // resources from other works, even when its address bar names the target.
  if (!temporaryDouyinDetailTabs.has(tabId)) return "";

  const target = { tabId };
  let attached = false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isMatchingDouyinDetailUrl(tab?.url, awemeId)) {
      if (diagnostics) diagnostics.resourceError = "页面ID不匹配";
      return "";
    }
    if (!debuggerAlreadyAttached) {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
    }
    const evaluated = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `JSON.stringify({ url: location.href, urls: Array.from(new Set([
        ...Array.from(document.querySelectorAll("video")).map((video) => video.currentSrc || video.src || ""),
        ...performance.getEntriesByType("resource").map((entry) => entry.name || "")
      ])).filter(Boolean) })`,
      returnByValue: true,
    });
    const raw = evaluated?.result?.value;
    const result = JSON.parse(typeof raw === "string" ? raw : "{}");
    if (!isMatchingDouyinDetailUrl(result.url, awemeId) || !Array.isArray(result.urls)) {
      if (diagnostics) diagnostics.resourceError = "未读到匹配页面资源";
      return "";
    }
    const urls = new Map();
    for (const value of result.urls.filter((value) => isLikelyDouyinVideoResource(value) && !isSeparateMediaTrackUrl(value))) {
      const originalUrl = normalizeHttpUrl(value);
      const identity = douyinMediaResourceIdentity(originalUrl);
      const hasRange = Array.from(new URL(originalUrl).searchParams.keys())
        .some((name) => /^(?:range|bytestart|byteend|byte_start|byte_end)$/i.test(name));
      // Use normalized identities only for comparison. Signed playback URLs
      // must retain their original query order and values when returned.
      if (!urls.has(identity) || !hasRange) urls.set(identity, originalUrl);
    }
    if (diagnostics) diagnostics.candidateCount = urls.size;
    if (urls.size !== 1) return "";
    const currentTab = await chrome.tabs.get(tabId);
    if (!isMatchingDouyinDetailUrl(currentTab?.url, awemeId)) return "";
    return Array.from(urls.values())[0];
  } catch (error) {
    if (diagnostics) diagnostics.resourceError = safeMediaLookupError(error).slice(0, 45);
    return "";
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined);
  }
}

function isLikelyDouyinVideoResource(value) {
  const source = normalizeHttpUrl(value);
  if (!/^https?:\/\//i.test(source) || /\.(?:jpe?g|png|webp|gif|svg|vtt|json)(?:$|[?#])/i.test(source)) return false;
  try {
    const url = new URL(source);
    const hostLooksLikeVideo = /(douyinvod|idouyinvod|bytecdn|volccdn|bytefcdn|ourdvsss|toscdn)/i.test(url.hostname);
    const pathLooksLikeVideo = /(?:\.mp4(?:$|[?#])|video[_/-]?mp4|\/video\/tos\/|mime_type=video)/i.test(source);
    return hostLooksLikeVideo && pathLooksLikeVideo;
  } catch (_error) {
    return false;
  }
}

function isDouyinNoteWork(work) {
  return /\/(?:share\/)?note\//i.test(String(work?.videoLink || ""));
}

function mergeResolvedTranscriptionWork(original, resolved) {
  if (!resolved || typeof resolved !== "object") return original;
  const expectedId = original?.awemeId || original?.id || extractAwemeIdFromVideoLink(original?.videoLink);
  if (expectedId && !douyinWorkMatchesId(resolved, expectedId)) return original;
  const merged = { ...original };
  const fillFields = [
    "id",
    "awemeId",
    "title",
    "authorName",
    "videoLink",
    "sourcePlayUri",
    "mediaFallbackUrl",
    "mediaUrl",
  ];
  for (const field of fillFields) {
    if (merged[field] !== undefined && merged[field] !== null && merged[field] !== "") continue;
    if (resolved[field] === undefined || resolved[field] === null || resolved[field] === "") continue;
    merged[field] = resolved[field];
  }
  return merged;
}

async function processBaseTranscriptionRequests() {
  if (baseTranscriptionRequestProcessing) return { running: true };
  baseTranscriptionRequestProcessing = true;
  try {
    const transcriptionSettings = await getTranscriptionSettings();
    const settings = normalizeSettings(await getFeishuSettings());
    const auth = await getFeishuAuth(settings);
    const table = await getOrCreateWorksTable(settings, auth, { works: [] });
    const tableId = table.table_id || table.tableId;
    if (!tableId) throw new Error("没有拿到视频数据表 ID");

    // Installing/opening the extension only reads the target. The checkbox is
    // created when the user first captures a video with field creation enabled.
    const fieldByName = mapFieldsByName(await listFields(settings, auth, tableId));
    if (!fieldByName.has(BASE_TRANSCRIPTION_REQUEST_FIELD)) return { scanned: 0, reason: "no-request-field" };
    const { records, repaired } = await repairStaleTranscriptionRecords(settings, auth, tableId, fieldByName);
    if (!transcriptionSettings.apiKey) {
      return { blocked: true, reason: "missing-api-key", scanned: records.length, repaired };
    }
    const requestedRecords = records.filter((record) =>
      isCheckedCell(readBaseRecordField(record, fieldByName, BASE_TRANSCRIPTION_REQUEST_FIELD)));

    let accepted = 0;
    let failed = 0;
    for (const record of requestedRecords.slice(0, 50)) {
      try {
        const result = await processBaseTranscriptionRequestRecord(settings, auth, tableId, fieldByName, record);
        if (result.accepted) accepted += 1;
        else if (result.failed) failed += 1;
      } catch (error) {
        failed += 1;
        const message = error?.message || String(error);
        await updateWorksTableRecord(settings, auth, tableId, record.record_id, {
          "逐字稿状态": `补转准备失败：${message.slice(0, 120)}`,
        }).catch(() => undefined);
      }
    }
    return { scanned: records.length, requested: requestedRecords.length, accepted, failed, repaired };
  } finally {
    baseTranscriptionRequestProcessing = false;
  }
}

async function processBaseTranscriptionRequestRecord(settings, auth, tableId, fieldByName, record) {
  const videoLink = normalizeReadValue(
    readBaseRecordField(record, fieldByName, "视频链接")
      || readBaseRecordField(record, fieldByName, "作品网址"),
  ).trim();
  if (!videoLink) {
    await updateWorksTableRecord(settings, auth, tableId, record.record_id, {
      "逐字稿状态": "无法补转：缺少视频链接",
    });
    return { accepted: false, failed: true };
  }

  const storedSourceUrl = normalizeReadValue(readBaseRecordField(record, fieldByName, "视频源网址")).trim();
  const storedStatus = normalizeReadValue(readBaseRecordField(record, fieldByName, "逐字稿状态"));
  const previousJob = (await readTranscriptionJobs()).find((job) => job.key === videoLink);
  if (previousJob && ACTIVE_TRANSCRIPTION_JOB_STATUSES.has(previousJob.status)) {
    // Acknowledge an existing job without writing a status from this earlier
    // scan: it may have completed while the request was being handled.
    await updateWorksTableRecord(settings, auth, tableId, record.record_id, {
      [BASE_TRANSCRIPTION_REQUEST_FIELD]: false,
    });
    return { accepted: true, queued: { queued: 0, existing: 1, skipped: 0 } };
  }
  const mediaDownloadFailed = isTranscriptionMediaDownloadError(storedStatus)
    || (previousJob?.status === "failed" && isTranscriptionMediaDownloadError(previousJob.sourceDownloadError || previousJob.lastError));
  const collectorName = normalizeReadValue(readBaseRecordField(record, fieldByName, "收集人")).trim();
  let work = {
    id: extractAwemeIdFromVideoLink(videoLink),
    awemeId: extractAwemeIdFromVideoLink(videoLink),
    title: normalizeReadValue(readBaseRecordField(record, fieldByName, "标题")).trim(),
    authorName: normalizeReadValue(readBaseRecordField(record, fieldByName, "博主名称")).trim(),
    collectorName,
    videoLink,
    mediaUrl: isUsableTranscriptionMediaUrl(storedSourceUrl) ? storedSourceUrl : "",
    transcriptText: normalizeReadValue(
      readBaseRecordField(record, fieldByName, "直接转逐字稿")
        || readBaseRecordField(record, fieldByName, "逐字稿"),
    ),
    transcriptionRequested: true,
    transcriptionMediaRecoveryRequested: Boolean(mediaDownloadFailed || isBilibiliVideoLink(videoLink)),
    transcriptStatus: "等待转写",
  };

  if (isBilibiliVideoLink(videoLink) || mediaDownloadFailed || !isUsableTranscriptionMediaUrl(preferredTranscriptionMediaUrl(work))) {
    const resolved = isBilibiliVideoLink(videoLink)
      ? await BiliBg.resolveWorkAudio(videoLink)
      : await resolveDouyinWorkForTranscription(work.awemeId, videoLink);
    work = {
      ...work,
      ...resolved,
      id: work.id || resolved.id || resolved.awemeId,
      awemeId: work.awemeId || resolved.awemeId || resolved.id,
      title: work.title || resolved.title || "",
      authorName: work.authorName || resolved.authorName || "",
      collectorName,
      videoLink,
      transcriptionRequested: true,
      transcriptStatus: "等待转写",
    };
  }

  const mediaUrl = preferredTranscriptionMediaUrl(work);
  if (!isUsableTranscriptionMediaUrl(mediaUrl)) {
    await updateWorksTableRecord(settings, auth, tableId, record.record_id, {
      "逐字稿状态": "无法补转：没有读取到可用视频源",
    });
    return { accepted: false, failed: true };
  }

  work.mediaUrl = mediaUrl;
  const result = {
    sourceUrl: videoLink,
    extractedAt: new Date().toISOString(),
    creatorId: "",
    creatorName: work.authorName,
    collectorName,
    sort: "base-request",
    sortText: "飞书勾选补转",
    filters: {},
    limit: 1,
    count: 1,
    transcriptionRequested: true,
    works: [work],
  };
  const queued = await enqueueTranscriptionForResult(result, { startProcessing: false, destination: transcriptionDestination(settings) });
  if (!queued.queued && !queued.existing) {
    await updateWorksTableRecord(settings, auth, tableId, record.record_id, {
      "逐字稿状态": "无法补转：转写任务未能入队",
    });
    return { accepted: false, failed: true };
  }

  await mutateWorksTable(settings, tableId, () => mutateTranscriptionJobs(async () => {
    const current = (await readTranscriptionJobs()).find((job) => job.key === videoLink);
    const fields = { [BASE_TRANSCRIPTION_REQUEST_FIELD]: false, "视频源网址": mediaUrl };
    if (current?.status === "queued") fields["逐字稿状态"] = "等待转写";
    // The job may have advanced while video-source preparation was running.
    // Hold both mutations until the acknowledgment is written so a late
    // "waiting" patch cannot arrive after the completion patch.
    await feishuApi("PUT", `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(record.record_id)}`,
      auth, { fields });
  }));
  if (queued.queued) void processTranscriptionJobs().catch(() => undefined);
  return { accepted: true, queued };
}

function readRecordTranscript(record, fieldByName) {
  const primary = normalizeReadValue(readBaseRecordField(record, fieldByName, "直接转逐字稿")).trim();
  return primary || normalizeReadValue(readBaseRecordField(record, fieldByName, "逐字稿")).trim();
}

function isStaleTranscriptionStatus(status) {
  return ["等待转写", "转写中", "转写任务已在处理中", "正在重新获取视频文件", "正在上传视频文件后转写",
    "视频下载失败，正在重新获取文件"].includes(status);
}

function completedTranscriptStatus(text) {
  return text.endsWith("[逐字稿过长，已截断]") ? "已完成（内容过长已截断）" : "已完成";
}

async function repairStaleTranscriptionRecords(settings, auth, tableId, fieldByName) {
  return mutateWorksTable(settings, tableId, async () => {
    const records = await listWorksTableRecords(settings, auth, tableId);
    const activeLinks = new Set((await readTranscriptionJobs())
      .filter((job) => ACTIVE_TRANSCRIPTION_JOB_STATUSES.has(job.status)).map((job) => job.key));
    let repaired = 0;
    if (!fieldByName.has("逐字稿状态")) return { records, repaired };
    for (const record of records) {
      const link = normalizeReadValue(readBaseRecordField(record, fieldByName, "视频链接")).trim();
      const text = readRecordTranscript(record, fieldByName);
      const status = normalizeReadValue(readBaseRecordField(record, fieldByName, "逐字稿状态")).trim();
      if (!text || !isStaleTranscriptionStatus(status) || activeLinks.has(link)
        || isCheckedCell(readBaseRecordField(record, fieldByName, BASE_TRANSCRIPTION_REQUEST_FIELD))) continue;
      // Keep this a status-only repair; no cloud ASR call or checkbox change.
      try {
        await feishuApi("PUT", `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(record.record_id)}`,
          auth, { fields: { "逐字稿状态": completedTranscriptStatus(text) } });
        repaired += 1;
      } catch (_error) {
        // A bad/deleted row must not block later checkbox requests. Retry on
        // the next scan after the table or connection recovers.
      }
    }
    return { records, repaired };
  });
}

async function listWorksTableRecords(settings, auth, tableId) {
  const records = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "500" });
    if (pageToken) query.set("page_token", pageToken);
    const data = await feishuApi(
      "GET",
      `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/records?${query.toString()}`,
      auth,
    );
    records.push(...(data?.items || []));
    pageToken = data?.has_more ? data?.page_token || "" : "";
  } while (pageToken);
  return records;
}

function readBaseRecordField(record, fieldByName, fieldName) {
  const fields = record?.fields || {};
  const field = fieldByName.get(fieldName);
  return fields[field?.field_id] ?? fields[fieldName];
}

function isCheckedCell(value) {
  if (value === true || value === 1) return true;
  if (value && typeof value === "object") {
    if ("value" in value) return isCheckedCell(value.value);
    if ("checked" in value) return isCheckedCell(value.checked);
  }
  return String(value || "").toLowerCase() === "true";
}

async function updateWorksTableRecord(settings, auth, tableId, recordId, fields) {
  if (!recordId) throw new Error("缺少飞书记录 ID");
  return mutateWorksTable(settings, tableId, () => feishuApi(
    "PUT",
    `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
    auth,
    { fields },
  ));
}

function extractAwemeIdFromVideoLink(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const direct = url.searchParams.get("modal_id") || url.searchParams.get("aweme_id") || "";
    if (/^\d{8,}$/.test(direct)) return direct;
    const match = url.pathname.match(/\/(?:share\/)?(?:video|note)\/(\d{8,})/);
    return match ? match[1] : "";
  } catch (_error) {
    const match = text.match(/\/(?:share\/)?(?:video|note)\/(\d{8,})/);
    return match ? match[1] : "";
  }
}

function isUsableTranscriptionMediaUrl(value) {
  const source = normalizeHttpUrl(value);
  if (!/^https?:\/\//i.test(source) || isSeparateMediaTrackUrl(source)) return false;
  try {
    const url = new URL(source);
    if (isBilibiliVideoLink(source)) return false;
    if (url.hostname === "v.douyin.com") return false;
    if ((url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"))
      && /\/(?:share\/)?(?:video|note|user)\//.test(url.pathname)) {
      return false;
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function isBilibiliVideoLink(value) {
  try {
    const url = new URL(value);
    return url.hostname === "b23.tv" || (["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(url.hostname)
      && /^\/video\//.test(url.pathname));
  } catch (_error) { return false; }
}

async function resolveDouyinWorkForTranscription(awemeId, videoLink, manualRun = null) {
  const id = String(awemeId || extractAwemeIdFromVideoLink(videoLink) || "").trim();
  if (!/^\d{8,}$/.test(id)) throw new Error("视频链接中没有有效的作品 ID");

  await manualRunCheckpoint(manualRun);
  try {
    const direct = await fetchDouyinWorkForTranscription(id, manualRun);
    if (douyinWorkMatchesId(direct, id) && preferredTranscriptionMediaUrl(direct)) return direct;
  } catch (_error) {
    if (_error?.code === "MANUAL_RUN_ENDED" || manualRun?.ended) throw manualRunError(manualRun?.ended || _error.message);
    // The site's own detail-page request can succeed when unsigned API calls fail.
  }

  await manualRunCheckpoint(manualRun);
  return resolveDouyinDetailMediaWork(id);
}

function transcriptionWorkFromDetailPayload(data, awemeId) {
  const detail = firstPresent([
    data?.aweme_detail,
    data?.awemeDetail,
    data?.item,
    data?.data?.aweme_detail,
    data?.data?.item,
  ]);
  if (!douyinWorkMatchesId(detail, awemeId)) return null;
  const work = normalizeTranscriptionWorkDetail(detail);
  return douyinWorkMatchesId(work, awemeId) ? work : null;
}

function isTargetDouyinDetailResponse(value, awemeId) {
  try {
    const url = new URL(value);
    return ["www.douyin.com", "www-hj.douyin.com", "douyin.com"].includes(url.hostname)
      && url.pathname === "/aweme/v1/web/aweme/detail/"
      && url.searchParams.get("aweme_id") === String(awemeId);
  } catch (_error) {
    return false;
  }
}

async function resolveDouyinDetailMediaWork(awemeId) {
  const id = String(awemeId || "").trim();
  if (!/^\d{8,}$/.test(id)) throw new Error("视频链接中没有有效的作品 ID");
  const url = `https://www.douyin.com/video/${id}`;
  let tabId = 0;
  let attached = false;
  let listenerRegistered = false;
  let networkWork = null;
  let loadedWork = null;
  const diagnostics = { debuggerState: "未连接", bodyState: "无目标详情响应", candidateCount: "未读取", resourceError: "" };
  const observedEndpoints = new Set();
  const requestIds = new Set();
  const onNetworkEvent = (source, method, params = {}) => {
    if (source?.tabId !== tabId || !temporaryDouyinDetailTabs.has(tabId)) return;
    if (method === "Network.responseReceived") {
      try {
        const responseUrl = new URL(params.response?.url);
        if (/^\/aweme\/v\d+\/web\/aweme\//.test(responseUrl.pathname) && observedEndpoints.size < 3) {
          observedEndpoints.add(`${responseUrl.pathname}=${params.response?.status || "?"}`);
        }
      } catch (_error) {
        // Diagnostics record paths/status only, never signed queries or bodies.
      }
    }
    if (method === "Network.responseReceived"
      && isTargetDouyinDetailResponse(params.response?.url, id)
      && params.response?.status >= 200 && params.response?.status < 300) {
      requestIds.add(params.requestId);
      diagnostics.bodyState = "目标详情等待body";
      return;
    }
    if (method === "Network.loadingFailed") {
      if (requestIds.delete(params.requestId)) diagnostics.bodyState = "目标详情加载失败";
      return;
    }
    if (method !== "Network.loadingFinished" || !requestIds.delete(params.requestId)) return;
    void chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: params.requestId })
      .then((response) => {
        const body = response?.base64Encoded
          ? new TextDecoder().decode(Uint8Array.from(atob(response.body || ""), (character) => character.charCodeAt(0)))
          : response?.body;
        let data;
        try {
          data = JSON.parse(body || "null");
        } catch (_error) {
          diagnostics.bodyState = "详情body非JSON";
          return;
        }
        const work = transcriptionWorkFromDetailPayload(data, id);
        if (!work) {
          diagnostics.bodyState = "详情body无匹配作品ID";
        } else if (preferredTranscriptionMediaUrl(work)) {
          networkWork = work;
          diagnostics.bodyState = "详情媒体已读取";
        } else {
          diagnostics.bodyState = "详情ID匹配但无媒体";
        }
      })
      .catch((error) => { diagnostics.bodyState = `body读取失败:${safeMediaLookupError(error).slice(0, 50)}`; });
  };

  try {
    const tab = await chromePromise(chrome.tabs.create, { url: "about:blank", active: false });
    tabId = tab?.id || 0;
    if (!tabId) throw new Error("无法打开作品详情页");
    temporaryDouyinDetailTabs.add(tabId);
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
      diagnostics.debuggerState = "已连接";
      chrome.debugger.onEvent.addListener(onNetworkEvent);
      listenerRegistered = true;
      await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
      diagnostics.debuggerState = "Network已启用";
    } catch (error) {
      diagnostics.debuggerState = `${attached ? "Network启用失败" : "attach失败"}:${safeMediaLookupError(error).slice(0, 65)}`;
      // DOM/script lookup remains available if Chrome cannot attach a debugger.
    }
    await chromePromise(chrome.tabs.update, tabId, { url, active: false });
    await waitForTabLoad(tabId, 18000);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const currentTab = await chrome.tabs.get(tabId);
      if (!isMatchingDouyinDetailUrl(currentTab?.url, id)) throw new Error("作品详情页已跳转，无法确认视频归属");
      if (networkWork) return networkWork;
      loadedWork = await readLoadedDouyinWorkMedia(tabId, id);
      if (networkWork) return networkWork;
      if (loadedWork && preferredTranscriptionMediaUrl(loadedWork)) return loadedWork;
      if (attempt < 23) await delay(500);
    }
    const mediaUrl = await resolveUniqueFreshDouyinMediaUrl(tabId, id, attached, diagnostics);
    if (networkWork) return networkWork;
    if (!mediaUrl) throw new Error("作品详情页未能读取归属明确的视频文件地址");
    return {
      ...(loadedWork || {}),
      id,
      awemeId: id,
      videoLink: url,
      sourcePlayUri: "",
      mediaUrl,
      mediaFallbackUrl: mediaUrl,
    };
  } catch (error) {
    throw new Error(safeMediaLookupError([
      safeMediaLookupError(error),
      diagnostics.debuggerState,
      diagnostics.bodyState,
      `候选${diagnostics.candidateCount}${diagnostics.resourceError ? `:${diagnostics.resourceError}` : ""}`,
      observedEndpoints.size ? Array.from(observedEndpoints).join(",") : "未见aweme接口响应",
    ].join("；")));
  } finally {
    if (listenerRegistered) chrome.debugger.onEvent.removeListener(onNetworkEvent);
    requestIds.clear();
    temporaryDouyinDetailTabs.delete(tabId);
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => undefined);
    if (tabId) await chromePromise(chrome.tabs.remove, tabId).catch(() => undefined);
  }
}

async function resolveDouyinVisibleWork(awemeId, videoLink) {
  const id = String(awemeId || extractAwemeIdFromVideoLink(videoLink) || "").trim();
  if (!/^\d{8,}$/.test(id)) throw new Error("视频链接中没有有效的作品 ID");
  const url = `https://www.douyin.com/video/${id}`;

  let tabId = 0;
  try {
    const tab = await chromePromise(chrome.tabs.create, { url, active: false });
    tabId = tab?.id || 0;
    if (!tabId) throw new Error("无法打开作品详情页");
    temporaryDouyinDetailTabs.add(tabId);
    await waitForTabLoad(tabId, 18000);
    const response = await sendMessageToTabWithRetry(
      tabId,
      { type: "douhot:collectVisibleWork", awemeId: id },
      8,
      700,
    );
    if (!response?.ok) throw new Error(response?.error || "作品详情页没有返回数据");
    const work = response?.data?.work || response?.work;
    if (!douyinWorkMatchesId(work, id)) throw new Error("作品详情页返回的作品 ID 不匹配");
    const currentTab = await chrome.tabs.get(tabId);
    if (!isMatchingDouyinDetailUrl(currentTab?.url, id)) throw new Error("作品详情页已跳转，无法确认作品归属");

    const loadedWork = await readLoadedDouyinWorkMedia(tabId, id);
    const normalizedWork = normalizeTranscriptionWorkDetail(work);
    const mediaUrl = (loadedWork && preferredTranscriptionMediaUrl(loadedWork))
      || preferredTranscriptionMediaUrl(normalizedWork)
      || await resolveUniqueFreshDouyinMediaUrl(tabId, id);
    if (isUsableTranscriptionMediaUrl(mediaUrl)) {
      work.video = {
        ...(work.video || {}),
        play_addr: {
          ...(work.video?.play_addr || {}),
          url_list: [mediaUrl],
        },
      };
      work.mediaUrl = mediaUrl;
    }
    return { work };
  } finally {
    temporaryDouyinDetailTabs.delete(tabId);
    if (tabId) {
      await chromePromise(chrome.tabs.remove, tabId).catch(() => undefined);
    }
  }
}

async function fetchDouyinWorkForTranscription(awemeId, manualRun = null) {
  await manualRunCheckpoint(manualRun);
  const url = new URL("/aweme/v1/web/aweme/detail/", "https://www.douyin.com");
  Object.entries({
    ...douyinWebCommonParams(),
    aweme_id: awemeId,
  }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json, text/plain, */*" },
    ...(manualRun ? { signal: manualRun.abortController.signal } : {}),
  });
  const text = await response.text();
  if (!response.ok || !text) throw new Error(`抖音详情接口没有返回数据：${response.status}`);
  const data = JSON.parse(text);
  const work = transcriptionWorkFromDetailPayload(data, awemeId);
  if (!work) throw new Error("抖音详情接口没有返回匹配的作品数据");
  return work;
}

function normalizeTranscriptionWorkDetail(detail, fallbackAwemeId = "") {
  const video = detail?.video || {};
  const playAddress = video?.play_addr || video?.playAddr || {};
  const sourcePlayUri = [
    playAddress?.uri,
    video?.play_addr_h264?.uri,
    video?.play_addr_265?.uri,
  ].map((value) => String(value || "").trim()).find((value) => buildDouyinSourceUrl(value)) || "";
  const mediaFallbackUrl = firstHttpUrl([
    playAddress?.url_list,
    playAddress?.urlList,
    video?.play_addr_h264?.url_list,
    video?.play_addr_265?.url_list,
    video?.download_addr?.url_list,
    video?.downloadAddr?.urlList,
  ]);
  const awemeId = String(firstPresent([
    detail?.aweme_id,
    detail?.awemeId,
    fallbackAwemeId,
  ]) || "").trim();
  const author = detail?.author || {};
  return {
    id: awemeId,
    awemeId,
    title: String(firstPresent([detail?.desc, detail?.title, ""]) || "").trim(),
    authorName: String(firstPresent([author?.nickname, author?.name, ""]) || "").trim(),
    videoLink: awemeId ? `https://www.douyin.com/video/${encodeURIComponent(awemeId)}` : "",
    sourcePlayUri,
    mediaFallbackUrl,
    mediaUrl: buildDouyinSourceUrl(sourcePlayUri) || buildDouyinSourceUrl(mediaFallbackUrl) || normalizeHttpUrl(mediaFallbackUrl),
  };
}

function firstHttpUrl(value, depth = 0) {
  if (!value || depth > 5) return "";
  if (typeof value === "string") {
    return (/^https?:\/\//i.test(value) || value.startsWith("//")) && !isSeparateMediaTrackUrl(value)
      ? normalizeHttpUrl(value) : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstHttpUrl(item, depth + 1);
      if (url) return url;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) {
      const url = firstHttpUrl(child, depth + 1);
      if (url) return url;
    }
  }
  return "";
}

function attachCollectorName(result, fallbackName = "") {
  if (!result || !Array.isArray(result.works)) return result;
  const hasCapturedCollector = Object.prototype.hasOwnProperty.call(result, "collectorName");
  const collectorName = String(hasCapturedCollector ? result.collectorName || "" : fallbackName || "").trim();
  return {
    ...result,
    collectorName,
    works: result.works.map((work) => {
      const hasWorkCollector = Object.prototype.hasOwnProperty.call(work, "collectorName");
      return {
        ...work,
        collectorName: String(hasWorkCollector ? work.collectorName || "" : collectorName || "").trim(),
      };
    }),
  };
}

function normalizeSettings(settings) {
  const normalized = { ...DEFAULT_FEISHU_SETTINGS, ...(settings || {}) };
  if (!settings?.authMode && settings?.personalBaseToken) normalized.authMode = "personalBaseToken";
  const missing = [];
  normalized.authMode = ["openApi", "personalBaseToken"].includes(normalized.authMode) ? normalized.authMode : "personalBaseToken";
  if (normalized.authMode === "openApi") {
    if (!normalized.appId) missing.push("App ID");
    if (!normalized.appSecret) missing.push("App Secret");
  } else if (!normalized.personalBaseToken) {
    missing.push("多维表格授权码 personalBaseToken");
  }
  if (!normalized.appToken) missing.push("多维表格 app_token/base_token");
  if (!normalized.tableId) missing.push("table_id");
  if (missing.length) {
    throw new Error(`飞书配置不完整：${missing.join("、")}`);
  }
  return normalized;
}

async function getFeishuAuth(settings, manualRun = null) {
  await manualRunCheckpoint(manualRun);
  if (settings.authMode === "openApi") {
    return {
      token: await getTenantAccessToken(settings, manualRun),
      apiBase: "https://open.feishu.cn/open-apis",
      manualRun,
    };
  }
  return {
    token: settings.personalBaseToken,
    apiBase: "https://base-api.feishu.cn/open-apis",
    manualRun,
  };
}

async function getTenantAccessToken(settings, manualRun = null) {
  await manualRunCheckpoint(manualRun);
  const cache = await chrome.storage.local.get({ feishuTokenCache: null });
  if (cache.feishuTokenCache?.token && cache.feishuTokenCache.appId === settings.appId && cache.feishuTokenCache.expiresAt > Date.now() + 60000) {
    return cache.feishuTokenCache.token;
  }

  await manualRunCheckpoint(manualRun);
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: settings.appId,
      app_secret: settings.appSecret,
    }),
    ...(manualRun ? { signal: manualRun.abortController.signal } : {}),
  });
  const json = await response.json();
  if (!response.ok || json.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败：${json.msg || json.message || response.status}`);
  }

  const token = json.tenant_access_token;
  const expiresAt = Date.now() + Math.max(1, Number(json.expire || 7200) - 120) * 1000;
  await chrome.storage.local.set({ feishuTokenCache: { token, expiresAt, appId: settings.appId } });
  return token;
}

async function listFields(settings, auth, tableId = settings.tableId) {
  const items = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    const data = await feishuApi(
      "GET",
      `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/fields?${query.toString()}`,
      auth,
    );
    items.push(...(data?.items || []));
    pageToken = data?.has_more ? data?.page_token || "" : "";
  } while (pageToken);
  return items;
}

async function ensureFields(settings, auth, defs, result, tableId = settings.tableId) {
  let fields = await listFields(settings, auth, tableId);
  let fieldByName = mapFieldsByName(fields);
  const missingDefs = defs.filter((def) => !fieldByName.has(def.name));
  const createdFields = [];

  if (missingDefs.length && settings.autoCreateFields) {
    for (const def of missingDefs) {
      await feishuApi(
        "POST",
        `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
        auth,
        buildFieldCreatePayload(def, result),
      );
      createdFields.push(def.name);
    }
    fields = await listFields(settings, auth, tableId);
    fieldByName = mapFieldsByName(fields);
  }

  const skippedFields = defs.filter((def) => !fieldByName.has(def.name)).map((def) => def.name);
  return { fieldByName, fieldOrder: mapFieldOrder(fields), createdFields, skippedFields };
}

function buildFieldCreatePayload(def, result) {
  const payload = { field_name: def.name, type: def.type };
  if (def.uiType) payload.ui_type = def.uiType;
  const property = typeof def.property === "function" ? def.property(result) : def.property;
  if (property) payload.property = property;
  return payload;
}

async function listTables(settings, auth) {
  const items = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    const data = await feishuApi(
      "GET",
      `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables?${query.toString()}`,
      auth,
    );
    items.push(...(data?.items || data?.tables || []));
    pageToken = data?.has_more ? data?.page_token || "" : "";
  } while (pageToken);
  return items;
}

async function getOrCreateWorksTable(settings, auth, result) {
  const tables = await listTables(settings, auth);
  if (usesConfiguredVideoTable(settings)) {
    const selected = tables.find((table) => (table.table_id || table.tableId || table.id) === settings.tableId);
    if (!selected) throw new Error("填写的视频数据表不存在或没有访问权限，请在设置页测试连接。");
    return { ...selected, table_id: selected.table_id || selected.tableId || selected.id };
  }
  const existing = tables.find((table) => (table.name || table.table_name) === DEFAULT_WORKS_TABLE_NAME);
  if (existing) return existing;

  const created = await feishuApi(
    "POST",
    `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables`,
    auth,
    {
      table: {
        name: DEFAULT_WORKS_TABLE_NAME,
        default_view_name: "全部作品",
        fields: WORK_FIELD_DEFINITIONS.map((def) => buildFieldCreatePayload(def, result)),
      },
    },
  );
  return created?.table || created;
}

async function ensureDynamicOptions(settings, auth, tableId, fieldByName, defs, result) {
  for (const def of defs) {
    if (!def.options) continue;
    const field = fieldByName.get(def.name);
    if (!field?.field_id) continue;
    const wanted = uniqueStrings(def.options(result));
    if (!wanted.length) continue;
    const existingOptions = field.property?.options || [];
    const existingNames = new Set(existingOptions.map((option) => option.name).filter(Boolean));
    const missing = wanted.filter((name) => !existingNames.has(name));
    if (!missing.length) continue;

    const property = {
      ...(field.property || {}),
      options: [...existingOptions, ...missing.map((name) => ({ name }))],
    };
    try {
      await feishuApi(
        "PUT",
        `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(field.field_id)}`,
        auth,
        { field_name: field.field_name || field.name || def.name, type: field.type || def.type, property },
      );
    } catch (error) {
      if (error?.code === "MANUAL_RUN_ENDED" || auth.manualRun?.ended) throw error;
      // Some Base endpoints can auto-create option names during record writes. Keep going and let the write surface the real error if not.
    }
  }
}

function buildWorkRecordFields(result, work, defs, fieldByName, fieldOrder) {
  const payload = {};
  const orderedDefs = defs
    .slice()
    .sort((left, right) => (fieldOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (fieldOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER));
  for (const def of orderedDefs) {
    const field = fieldByName.get(def.name);
    if (!field) continue;
    const value = normalizeCellValue(field.type || def.type, def.pick({ result, work }));
    if (value === undefined) continue;
    payload[field.field_name || field.name || def.name] = value;
  }
  return payload;
}

async function listRecordIdsByFieldValue(settings, auth, tableId, fieldByName, fieldName) {
  const field = fieldByName.get(fieldName);
  if (!field) return new Map();

  const map = new Map();
  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "500" });
    if (pageToken) query.set("page_token", pageToken);
    const data = await feishuApi(
      "GET",
      `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(tableId)}/records?${query.toString()}`,
      auth,
    );
    const records = data?.items || [];
    records.forEach((record) => {
      const fields = record.fields || {};
      const value = normalizeReadValue(fields[field.field_id] ?? fields[fieldName]);
      if (value && record.record_id) map.set(value, record.record_id);
    });
    pageToken = data?.has_more ? data?.page_token || "" : "";
  } while (pageToken);
  return map;
}

async function findRecordIdByCreatorId(settings, auth, fieldByName, creatorId) {
  if (!creatorId) return "";
  const creatorField = fieldByName.get("达人ID");
  if (!creatorField) return "";

  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    const data = await feishuApi(
      "GET",
      `/bitable/v1/apps/${encodeURIComponent(settings.appToken)}/tables/${encodeURIComponent(settings.tableId)}/records?${query.toString()}`,
      auth,
    );
    const records = data?.items || [];
    const matched = records.find((record) => {
      const fields = record.fields || {};
      const value = fields[creatorField.field_id] ?? fields["达人ID"];
      return normalizeReadValue(value) === creatorId;
    });
    if (matched?.record_id) return matched.record_id;
    pageToken = data?.has_more ? data?.page_token || "" : "";
  } while (pageToken);
  return "";
}

function mapFieldsByName(fields) {
  return new Map(fields.map((field) => [field.field_name || field.name, field]));
}

function mapFieldOrder(fields) {
  return new Map(fields.map((field, index) => [field.field_name || field.name, index]));
}

function buildRecordFields(result, defs, fieldByName, fieldOrder) {
  const payload = {};
  const orderedDefs = defs
    .slice()
    .sort((left, right) => {
      if (left.name === "达人ID") return 1;
      if (right.name === "达人ID") return -1;
      return (fieldOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (fieldOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER);
    });
  for (const def of orderedDefs) {
    const field = fieldByName.get(def.name);
    if (!field) continue;
    const value = normalizeCellValue(field.type || def.type, def.pick(result));
    if (value === undefined) continue;
    payload[field.field_name || field.name || def.name] = value;
  }
  return payload;
}

function normalizeCellValue(type, value) {
  if (value === undefined || value === null) return undefined;
  const typeNumber = Number(type);
  if (typeNumber === FIELD_TYPE.number) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (typeNumber === FIELD_TYPE.dateTime || type === "DateTime") {
    return normalizeDateTimeValue(value);
  }
  if (typeNumber === FIELD_TYPE.checkbox || type === "Checkbox") {
    return value === true || value === 1 || String(value).toLowerCase() === "true";
  }
  if (typeNumber === FIELD_TYPE.multiSelect || type === "MultiSelect") {
    const values = Array.isArray(value) ? value : String(value).split(/[、,，]/);
    const normalized = uniqueStrings(values);
    return normalized.length ? normalized : undefined;
  }
  if (Array.isArray(value)) return value.join("、");
  return String(value);
}

function normalizeDateTimeValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return value > 100000000000 ? Math.round(value) : Math.round(value * 1000);
  }
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) ? (number > 100000000000 ? number : number * 1000) : undefined;
  }
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function getTags(result) {
  return uniqueStrings(result?.profile?.tags || []);
}

function uniqueStrings(values) {
  const seen = new Set();
  const list = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
  }
  return list;
}

function normalizeReadValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeReadValue).join("");
  }
  if (value && typeof value === "object") {
    if ("text" in value) return String(value.text || "");
    if ("value" in value) return String(value.value || "");
    return JSON.stringify(value);
  }
  return value === undefined || value === null ? "" : String(value);
}

async function feishuApi(method, path, auth, body) {
  await manualRunCheckpoint(auth.manualRun);
  const response = await fetch(`${auth.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(auth.manualRun ? { signal: auth.manualRun.abortController.signal } : {}),
  });

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new Error(`飞书接口没有返回 JSON：${response.status}`);
  }
  if (!response.ok || json.code !== 0) {
    throw new Error(`飞书接口失败：${json.msg || json.message || json.error || response.status}`);
  }
  return json.data;
}

function formatRows(rows = [], limit) {
  const list = limit ? rows.slice(0, limit) : rows;
  return list
    .map((row) => `${row.name || ""} ${row.ratioText || ""}${row.tgiText ? ` / TGI ${row.tgiText}` : ""}`.trim())
    .filter(Boolean)
    .join("，");
}

function portraitPercent(result, name) {
  const row = (result.fanPortrait?.gender || []).find((item) => item.name === name);
  if (!row) return undefined;
  const value = Number(row.ratio);
  if (!Number.isFinite(value)) return undefined;
  return Math.abs(value) <= 1 ? Number((value * 100).toFixed(2)) : value;
}

function portraitTgi(result, name) {
  const row = (result.fanPortrait?.gender || []).find((item) => item.name === name);
  const value = Number(row?.tgi);
  return Number.isFinite(value) ? value : undefined;
}

function integerValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : undefined;
}

function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value || "");
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function fetchDouyinTopComments(awemeId, videoLink = "", creatorName = "", sourceTabId = 0, manualRun = null) {
  const id = String(awemeId || "").trim();
  if (!id) return { comments: [] };

  let lastError = "";
  let collected = [];
  for (const url of buildDouyinCommentUrls(id)) {
    await manualRunCheckpoint(manualRun);
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json, text/plain, */*" },
        ...(manualRun ? { signal: manualRun.abortController.signal } : {}),
      });
      const text = await response.text();
      if (!response.ok || !text) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const data = JSON.parse(text);
      const comments = normalizeDouyinComments(extractDouyinCommentList(data));
      collected = mergeUniqueDouyinComments(collected, comments);
      const code = firstPresent([data?.status_code, data?.statusCode, data?.code, data?.data?.status_code, data?.data?.code]);
      if (code !== undefined && code !== null && Number(code) !== 0) {
        lastError = String(firstPresent([data?.status_msg, data?.statusMsg, data?.msg, data?.message, data?.data?.status_msg]) || code);
      }
    } catch (error) {
      if (error?.code === "MANUAL_RUN_ENDED" || manualRun?.ended) throw manualRunError(manualRun?.ended || error.message);
      lastError = error.message || String(error);
    }
  }
  if (videoLink) {
    await manualRunCheckpoint(manualRun);
    const pageResult = await fetchDouyinTopCommentsFromVideoTab(videoLink, id, creatorName, sourceTabId);
    collected = mergeUniqueDouyinComments(collected, pageResult.comments || []);
    if (collected.length || pageResult.error) return { ...pageResult, comments: collected.slice(0, 3) };
  }
  return { comments: collected.slice(0, 3), error: lastError };
}

async function fetchDouyinTopCommentsFromVideoTab(videoLink, awemeId, creatorName = "", sourceTabId = 0) {
  const url = normalizeVideoPageUrl(videoLink, awemeId);
  if (!url) return { comments: [], error: "没有视频链接" };

  let tabId = 0;
  try {
    tabId = await openOrUpdateCommentReaderTab(url);
    await waitForTabLoad(tabId, 18000);
    await delay(2600);
    const response = await sendMessageToTabWithRetry(tabId, { type: "douhot:extractVideoComments", awemeId, creatorName }, 10, 900);
    const comments = normalizeDouyinComments(response?.data?.comments || response?.comments || []);
    return { comments };
  } catch (error) {
    return { comments: [], error: error.message || String(error) };
  } finally {
    if (sourceTabId && tabId && sourceTabId !== tabId) {
      chrome.tabs.update(sourceTabId, { active: true }, () => {
        chrome.runtime.lastError;
      });
    }
    scheduleCommentReaderClose();
  }
}

function normalizeVideoPageUrl(videoLink, awemeId) {
  const text = String(videoLink || "").trim();
  try {
    const url = new URL(text || `https://www.douyin.com/video/${encodeURIComponent(awemeId)}`);
    if (!/douyin\.com$/.test(url.hostname) && !url.hostname.endsWith(".douyin.com")) return "";
    if (!/\/(?:share\/)?(?:video|note)\//.test(url.pathname)) {
      return awemeId ? `https://www.douyin.com/video/${encodeURIComponent(awemeId)}` : "";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (error) {
    return awemeId ? `https://www.douyin.com/video/${encodeURIComponent(awemeId)}` : "";
  }
}

async function openOrUpdateCommentReaderTab(url) {
  clearTimeout(commentReaderCloseTimer);
  if (commentReaderTabId) {
    try {
      await chromePromise(chrome.tabs.get, commentReaderTabId);
      await chromePromise(chrome.tabs.update, commentReaderTabId, { url, active: true });
      return commentReaderTabId;
    } catch (error) {
      commentReaderTabId = 0;
    }
  }
  const tab = await chromePromise(chrome.tabs.create, { url, active: true });
  commentReaderTabId = tab.id || 0;
  return commentReaderTabId;
}

function scheduleCommentReaderClose() {
  clearTimeout(commentReaderCloseTimer);
  commentReaderCloseTimer = setTimeout(() => {
    const tabId = commentReaderTabId;
    commentReaderTabId = 0;
    if (tabId) {
      chrome.tabs.remove(tabId, () => {
        chrome.runtime.lastError;
      });
    }
  }, 15000);
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timeoutId = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab?.status === "complete") finish();
    });
  });
}

async function sendMessageToTabWithRetry(tabId, message, retries, intervalMs) {
  let lastError = "";
  for (let index = 0; index < retries; index += 1) {
    try {
      const response = await chromePromise(chrome.tabs.sendMessage, tabId, message);
      if (response?.ok) return response;
      if (response) return response;
    } catch (error) {
      lastError = error.message || String(error);
    }
    await delay(intervalMs);
  }
  throw new Error(lastError || "视频详情页没有返回评论数据");
}

function chromePromise(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDouyinCommentUrls(awemeId) {
  return [
    { sort_type: 2 },
    { sort_type: 0 },
  ].map((extraParams) => {
    const url = new URL("https://www.douyin.com/aweme/v1/web/comment/list/");
    Object.entries({
      ...douyinWebCommonParams(),
      aweme_id: awemeId,
      cursor: 0,
      count: 20,
      item_type: 0,
      insert_ids: "",
      ...extraParams,
    }).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    return url;
  });
}

function douyinWebCommonParams() {
  const nav = typeof navigator === "undefined" ? {} : navigator;
  return {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    pc_client_type: 1,
    version_code: "170400",
    version_name: "17.4.0",
    cookie_enabled: nav.cookieEnabled === undefined ? true : nav.cookieEnabled,
    browser_language: nav.language || "zh-CN",
    browser_platform: nav.platform || "",
    browser_name: "Chrome",
    browser_version: browserVersion(nav.userAgent || ""),
    browser_online: nav.onLine === undefined ? true : nav.onLine,
    engine_name: "Blink",
    engine_version: browserVersion(nav.userAgent || ""),
    os_name: detectOsName(nav.platform || nav.userAgent || ""),
    os_version: "",
  };
}

function browserVersion(userAgent) {
  const match = String(userAgent || "").match(/(?:Chrome|CriOS)\/([\d.]+)/);
  return match ? match[1] : "";
}

function detectOsName(value) {
  const text = String(value || "");
  if (/Mac/i.test(text)) return "Mac OS";
  if (/Win/i.test(text)) return "Windows";
  if (/Android/i.test(text)) return "Android";
  if (/iPhone|iPad|iOS/i.test(text)) return "iOS";
  if (/Linux/i.test(text)) return "Linux";
  return "";
}

function extractDouyinCommentList(data) {
  const direct = firstArray([
    data?.comments,
    data?.comment_list,
    data?.commentList,
    data?.items,
    data?.data?.comments,
    data?.data?.comment_list,
    data?.data?.commentList,
    data?.data?.items,
  ]);
  if (direct?.length) return direct;

  const queue = [data];
  const visited = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      if (value.some(looksLikeDouyinComment)) return value;
      value.forEach((child) => {
        if (child && typeof child === "object") queue.push(child);
      });
      continue;
    }
    Object.values(value).forEach((child) => {
      if (child && typeof child === "object") queue.push(child);
    });
  }
  return [];
}

function looksLikeDouyinComment(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value.text || value.comment_text || value.content || value.reply_comment?.text) &&
      (value.user || value.user_info || value.cid || value.comment_id || value.digg_count !== undefined),
  );
}

// Only classify non-text reactions. Keep short answers, questions, numbers and
// mixed text/emoji intact; do not guess whether a written opinion is useful.
const COMMENT_EMOTE_LABELS = new Set((
  "微笑 撇嘴 色 发呆 得意 流泪 害羞 闭嘴 睡 大哭 尴尬 发怒 调皮 呲牙 惊讶 难过 酷 冷汗 抓狂 吐 偷笑 可爱 白眼 傲慢 饥饿 困 惊恐 流汗 憨笑 大兵 奋斗 咒骂 疑问 嘘 晕 折磨 衰 骷髅 敲打 再见 擦汗 抠鼻 鼓掌 糗大了 坏笑 左哼哼 右哼哼 哈欠 鄙视 委屈 快哭了 阴险 亲亲 吓 可怜 菜刀 西瓜 啤酒 篮球 乒乓 咖啡 饭 猪头 玫瑰 凋谢 示爱 爱心 心碎 蛋糕 闪电 炸弹 刀 足球 瓢虫 便便 月亮 太阳 礼物 拥抱 强 弱 握手 胜利 抱拳 勾引 拳头 差劲 爱你 no ok 爱情 飞吻 跳跳 发抖 怄火 转圈 磕头 回头 跳绳 挥手 激动 街舞 献吻 左太极 右太极 捂脸 笑哭 泪奔 无语 灵机一动 机智 石化 思考 吐血 惊呆 耶 赞 踩 大笑 比心 送心 666 小鼓掌 感谢来看 看 不看 紫薇别走 绝 耳朵 聪明 得到了 前排 皱眉 发红包 红包 抱抱 加油 奥特曼 脱单doge doge doge_金箍 妙啊 嗑瓜子 吃瓜 打call 滑稽 辣眼睛 捂眼 哦呼 无语了 喜极而泣 酸了 傲娇 保佑 嘟嘟 生气 问号 大笑 可爱 惊喜 点赞 支持 脸红 汗 生病 嘴唇 嘚瑟 眨眼 疯狂 惊吓 呆无辜 疼 蓄力 发财 送花 福烟花 烟花 炸弹 亲亲 飞吻 花 虎年大吉 兔年大吉 龙年大吉 蛇年大吉 马年大吉 马到成功 图片 图 图片评论 表情 表情包 动图 贴纸 image picture photo sticker emoji gif animated_emoticon"
).split(/\s+/u));

function hasCommentText(value, extraEmotes = []) {
  if (typeof value !== "string") return false;
  const extras = new Set(extraEmotes.map(label => label.trim().toLowerCase()));
  const text = value
    // Keycaps contain ordinary digits; strip the whole emoji before checking text.
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, "")
    .replace(/\[([^\[\]\r\n]{1,50})\]|【([^【】\r\n]{1,50})】/gu, (token, square, wide) => {
      const label = String(square ?? wide).trim().toLowerCase();
      return COMMENT_EMOTE_LABELS.has(label) || extras.has(token.toLowerCase()) || extras.has(label) ? "" : token;
    })
    .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\p{Default_Ignorable_Code_Point}/gu, "");
  return /[\p{L}\p{N}]/u.test(text);
}

function normalizeDouyinComments(comments) {
  return sortCommentsByLikeCount((Array.isArray(comments) ? comments : [])
    .map(normalizeDouyinComment)
    .filter((comment) => hasCommentText(comment.text)))
    .slice(0, 3);
}

function mergeUniqueDouyinComments(existing, comments) {
  const merged = [];
  const seen = new Set();
  for (const comment of [...(existing || []), ...(comments || [])]) {
    const text = cleanText(comment?.text);
    if (!hasCommentText(text)) continue;
    const key = `${cleanText(comment?.author)}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...comment, text });
  }
  return sortCommentsByLikeCount(merged);
}

function normalizeDouyinComment(comment) {
  return {
    text: cleanText(commentText(firstPresent([comment?.text, comment?.comment_text, comment?.content, comment?.reply_comment?.text]))),
    author: cleanText(firstPresent([comment?.user?.nickname, comment?.user_info?.nickname, comment?.author?.nickname, comment?.author, comment?.user?.unique_id, comment?.user?.short_id, comment?.nickname])),
    likeCount: integerOrNull(firstPresent([comment?.likeCount, comment?.digg_count, comment?.diggCount, comment?.like_count, comment?.statistics?.digg_count])),
  };
}

function commentText(value) {
  if (Array.isArray(value)) return value.map(commentText).filter(Boolean).join("");
  if (value && typeof value === "object") {
    return firstPresent([value.text, value.content, value.string, value.value]) || "";
  }
  return value;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseCreatorIdFromText(input) {
  const source = String(input || "").trim();
  if (!source) return "";
  const candidates = uniqueStrings([source, ...extractUrls(source)]);
  for (const candidate of candidates) {
    const creatorId = parseCreatorIdCandidate(candidate);
    if (creatorId) return creatorId;
  }
  return "";
}

function parseCreatorIdCandidate(input) {
  const source = String(input || "").trim().replace(/[，。；;、]+$/, "");
  if (!source) return "";
  try {
    const url = new URL(source);
    const direct =
      url.searchParams.get("creator_id") ||
      url.searchParams.get("sec_uid") ||
      url.searchParams.get("secUid") ||
      url.searchParams.get("sec_user_id");
    if (direct) return normalizeCreatorId(direct);

    const userMatch = url.pathname.match(/\/(?:user|share\/user)\/([^/?#]+)/);
    if (userMatch) return normalizeCreatorId(decodeURIComponent(userMatch[1]));
  } catch (error) {
    // Share text often contains a URL plus surrounding copy; regex parsing handles that below.
  }

  const creatorMatch = source.match(/[?&]creator_id=([^&#\s]+)/);
  if (creatorMatch) return normalizeCreatorId(decodeURIComponent(creatorMatch[1]));
  const secUidMatch = source.match(/[?&](?:sec_uid|secUid|sec_user_id)=([^&#\s]+)/);
  if (secUidMatch) return normalizeCreatorId(decodeURIComponent(secUidMatch[1]));
  const userMatch = source.match(/\/(?:user|share\/user)\/([^/?#\s]+)/);
  if (userMatch) return normalizeCreatorId(decodeURIComponent(userMatch[1]));

  if (/^[\w.-]{12,}$/.test(source)) return normalizeCreatorId(source);
  return "";
}

function extractCreatorIdFromDouyinHtml(text) {
  const source = String(text || "");
  const patterns = [
    /"sec_uid"\s*:\s*"([^"]+)"/,
    /"secUid"\s*:\s*"([^"]+)"/,
    /"sec_user_id"\s*:\s*"([^"]+)"/,
    /%22sec_uid%22%3A%22([^"%]+)%22/,
    /%22secUid%22%3A%22([^"%]+)%22/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return normalizeCreatorId(decodeHtmlJsonValue(match[1]));
  }
  return "";
}

function extractRedirectUrl(text, baseUrl) {
  const source = String(text || "");
  const match =
    source.match(/location\.(?:href|replace)\s*=\s*["']([^"']+)["']/) ||
    source.match(/location\.replace\(["']([^"']+)["']\)/) ||
    source.match(/<a[^>]+href=["']([^"']+)["']/i);
  if (!match) return "";
  try {
    return new URL(decodeHtmlJsonValue(match[1]), baseUrl).toString();
  } catch (error) {
    return "";
  }
}

function extractFirstUrl(text) {
  const urls = extractUrls(text);
  return urls.find((url) => /(^|\.)douyin\.com$/i.test(safeHostname(url))) || urls[0] || "";
}

function extractUrls(text) {
  return (String(text || "").match(/https?:\/\/[^\s"'<>，。；、]+/g) || []).map(normalizeSharedUrl).filter(Boolean);
}

function normalizeSharedUrl(url) {
  return String(url || "").trim().replace(/[，。；;、,.!?！？)）\]】}]+$/, "");
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "";
  }
}

function normalizeCreatorId(value) {
  const text = decodeHtmlJsonValue(value).trim().replace(/[，。；;、/]+$/, "");
  if (!text || /^(self|me)$/i.test(text)) return "";
  return text;
}

function decodeHtmlJsonValue(value) {
  const text = String(value || "");
  const normalizeEscapes = (source) => source.replace(/\\\//g, "/").replace(/\\u002F/g, "/").replace(/\\u0026/g, "&").replace(/\\u003D/g, "=");
  try {
    return normalizeEscapes(decodeURIComponent(text));
  } catch (error) {
    return normalizeEscapes(text);
  }
}

function firstPresent(values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function firstArray(values) {
  return values.find((value) => Array.isArray(value));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const text = value.replace(/,/g, "").trim();
    const multiplier = text.includes("亿") ? 100000000 : text.includes("万") || /w$/i.test(text) ? 10000 : /k$/i.test(text) ? 1000 : 1;
    const normalized = text.replace(/[^\d.-]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed * multiplier : null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberValue(value) {
  const number = numberOrNull(value);
  return number === null ? -Infinity : number;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number);
}

function sortCommentsByLikeCount(comments) {
  const list = (comments || []).slice();
  const hasLikeCount = list.some((comment) => comment.likeCount !== undefined && comment.likeCount !== null);
  if (!hasLikeCount) return list;
  return list.sort((left, right) => {
    const leftHas = left.likeCount !== undefined && left.likeCount !== null;
    const rightHas = right.likeCount !== undefined && right.likeCount !== null;
    if (leftHas && rightHas) return numberValue(right.likeCount) - numberValue(left.likeCount);
    if (leftHas) return -1;
    if (rightHas) return 1;
    return 0;
  });
}

chrome.alarms.create(MONITOR_RETRY_ALARM, { periodInMinutes: 1 });
chrome.alarms.create(TRANSCRIPTION_ALARM, { periodInMinutes: 1 });
chrome.alarms.create(BASE_TRANSCRIPTION_REQUEST_ALARM, { periodInMinutes: 1 });

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(MONITOR_RETRY_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(TRANSCRIPTION_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(BASE_TRANSCRIPTION_REQUEST_ALARM, { periodInMinutes: 1 });
  void ensureMonitorTab({ active: false }).catch(() => undefined);
  void drainMonitorQueue().catch(() => undefined);
  void processBaseTranscriptionRequests().catch(() => undefined);
  void migrateFailedMediaTranscriptionJobs()
    .then(() => processTranscriptionJobs())
    .catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(MONITOR_RETRY_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(TRANSCRIPTION_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(BASE_TRANSCRIPTION_REQUEST_ALARM, { periodInMinutes: 1 });
  void getMonitorSettings()
    .then((settings) => settings.openOnStartup && ensureMonitorTab({ active: false }))
    .catch(() => undefined);
  void drainMonitorQueue().catch(() => undefined);
  void processBaseTranscriptionRequests().catch(() => undefined);
  void migrateFailedMediaTranscriptionJobs()
    .then(() => processTranscriptionJobs())
    .catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MONITOR_RETRY_ALARM) {
    void ensureMonitorTab({ active: false }).catch(() => undefined);
    void drainMonitorQueue().catch(() => undefined);
    return;
  }
  if (alarm.name === TRANSCRIPTION_ALARM) {
    void migrateFailedMediaTranscriptionJobs()
      .then(() => processTranscriptionJobs())
      .catch(() => undefined);
    return;
  }
  if (alarm.name === BASE_TRANSCRIPTION_REQUEST_ALARM) {
    void processBaseTranscriptionRequests().catch(() => undefined);
  }
});

if (typeof BiliBg !== "undefined") BiliBg.initialize();
