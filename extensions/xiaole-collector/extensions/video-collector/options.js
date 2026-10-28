const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");

const fields = {
  collectorName: document.getElementById("collectorName"),
  authMode: document.getElementById("authMode"),
  personalBaseToken: document.getElementById("personalBaseToken"),
  appId: document.getElementById("appId"),
  appSecret: document.getElementById("appSecret"),
  appToken: document.getElementById("appToken"),
  tableId: document.getElementById("tableId"),
  baseUrl: document.getElementById("baseUrl"),
  autoCreateFields: document.getElementById("autoCreateFields"),
  upsertByCreatorId: document.getElementById("upsertByCreatorId"),
  transcriptionEnabled: document.getElementById("transcriptionEnabled"),
  aliyunApiKey: document.getElementById("aliyunApiKey"),
  transcriptionModel: document.getElementById("transcriptionModel"),
  monitorEnabled: document.getElementById("monitorEnabled"),
  targetConversation: document.getElementById("targetConversation"),
  selfSenderName: document.getElementById("selfSenderName"),
  openOnStartup: document.getElementById("openOnStartup"),
};
const monitorStatusNode = document.getElementById("monitorStatus");
const transcriptionModelHintNode = document.getElementById("transcriptionModelHint");
const transcriptionModelStatusNode = document.getElementById("transcriptionModelStatus");
const saveTranscriptionNode = document.getElementById("saveTranscription");
let transcriptionModels = [];
let transcriptionSettingsLoaded = false;

document.getElementById("retryAccountTranscription").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const status = document.getElementById("transcriptionRetryStatus");
  button.disabled = true;
  try {
    status.textContent = "正在恢复转写任务…";
    const response = await sendMessage({ type: "douhot:retryAccountBlockedTranscriptions" });
    status.textContent = response.data.queued
      ? `已恢复 ${response.data.queued} 条任务。请保持 Chrome 运行，完成后自动回写飞书。`
      : "没有可重试的欠费失败任务；正在转写和已完成的任务不会重复提交。";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

loadSettings();
fields.authMode.addEventListener("change", updateAuthModeVisibility);
fields.transcriptionModel.addEventListener("change", () => {
  updateTranscriptionModelHint();
  transcriptionModelStatusNode.textContent = "模型选择已更改，点击「保存转写设置」生效。";
});

saveTranscriptionNode.addEventListener("click", async () => {
  saveTranscriptionNode.disabled = true;
  try {
    const response = await sendMessage({ type: "douhot:saveTranscriptionSettings", payload: readTranscriptionSettings() });
    showSavedTranscriptionModel(response.data.model);
    setStatus("转写设置已保存。");
  } catch (error) {
    transcriptionModelStatusNode.textContent = error.message;
    setStatus(error.message, true);
  } finally {
    saveTranscriptionNode.disabled = !transcriptionSettingsLoaded;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const transcription = readTranscriptionSettings();
    const biliSettings = readBilibiliOptions();
    await Promise.all([
      sendMessage({ type: "douhot:saveSettings", payload: readSettings() }),
      sendMessage({ type: "douhot:saveMonitorSettings", payload: readMonitorSettings() }),
      sendMessage({ type: "douhot:saveTranscriptionSettings", payload: transcription }),
      sendMessage({ type: "bilibili:saveMonitor", payload: biliSettings }),
    ]);
    showSavedTranscriptionModel(transcription.model);
    setStatus("收集人、飞书、监控与逐字稿设置已保存。");
    await refreshMonitorStatus();
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.getElementById("test").addEventListener("click", async () => {
  try {
    setStatus("正在测试连接...");
    await sendMessage({ type: "douhot:saveSettings", payload: readSettings() });
    const response = await sendMessage({ type: "douhot:testFeishu", payload: readSettings() });
    setStatus(`连接成功，已检查 ${response.data.fieldCount} 个字段，记录也可以正常读取。`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.getElementById("parseUrl").addEventListener("click", () => {
  const parsed = parseBaseUrl(fields.baseUrl.value);
  if (!parsed.appToken && !parsed.tableId) {
    setStatus("没有从 URL 里识别出 app_token 或 table_id。", true);
    return;
  }
  if (parsed.appToken) fields.appToken.value = parsed.appToken;
  if (parsed.tableId) fields.tableId.value = parsed.tableId;
  if (parsed.wikiToken && !parsed.appToken) {
    setStatus(`已填入 table_id。这个是 wiki 链接，wiki token ${parsed.wikiToken} 还需要解析成真实 base_token。`, true);
    return;
  }
  setStatus("已从 URL 填入。");
});

document.getElementById("openMonitor").addEventListener("click", async () => {
  try {
    await sendMessage({ type: "douhot:saveMonitorSettings", payload: readMonitorSettings() });
    await sendMessage({ type: "douhot:openMonitor" });
    setMonitorStatus("监控页已打开，正在建立历史基线。", false);
  } catch (error) {
    setMonitorStatus(error.message, true);
  }
});

document.getElementById("refreshMonitorStatus").addEventListener("click", refreshMonitorStatus);

async function loadSettings() {
  try {
    const response = await sendMessage({ type: "douhot:getSettings" });
    const settings = response.data || {};
    fields.collectorName.value = settings.collectorName || "";
    fields.authMode.value = settings.authMode || "personalBaseToken";
    fields.personalBaseToken.value = settings.personalBaseToken || "";
    fields.appId.value = settings.appId || "";
    fields.appSecret.value = settings.appSecret || "";
    fields.appToken.value = settings.appToken || "";
    fields.tableId.value = settings.tableId || "";
    fields.autoCreateFields.checked = settings.autoCreateFields !== false;
    fields.upsertByCreatorId.checked = settings.upsertByCreatorId !== false;
    updateAuthModeVisibility();
    const transcriptionResponse = await sendMessage({ type: "douhot:getTranscriptionSettings" });
    const transcription = transcriptionResponse.data || {};
    fields.transcriptionEnabled.checked = transcription.enabled === true;
    fields.aliyunApiKey.value = transcription.apiKey || "";
    transcriptionModels = transcriptionResponse.models || [];
    const modelGroups = new Map();
    for (const model of transcriptionModels) {
      const groupName = model.group || "语音模型";
      if (!modelGroups.has(groupName)) {
        const group = document.createElement("optgroup");
        group.label = groupName;
        modelGroups.set(groupName, group);
      }
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      modelGroups.get(groupName).append(option);
    }
    fields.transcriptionModel.replaceChildren(...modelGroups.values());
    fields.transcriptionModel.value = transcription.model || "paraformer-v2";
    if (!transcriptionModels.some((model) => model.id === fields.transcriptionModel.value)) {
      throw new Error("转写模型列表读取失败，请重新加载扩展后刷新设置页。");
    }
    transcriptionSettingsLoaded = true;
    fields.transcriptionModel.disabled = false;
    saveTranscriptionNode.disabled = false;
    updateTranscriptionModelHint();
    showSavedTranscriptionModel(fields.transcriptionModel.value);
    const monitorResponse = await sendMessage({ type: "douhot:getMonitorSettings" });
    const monitor = monitorResponse.data || {};
    fields.monitorEnabled.checked = monitor.enabled === true;
    fields.targetConversation.value = monitor.targetConversation || "";
    fields.selfSenderName.value = monitor.selfSenderName || "";
    fields.openOnStartup.checked = monitor.openOnStartup === true;
    await refreshMonitorStatus();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function readTranscriptionSettings() {
  if (!transcriptionSettingsLoaded) throw new Error("请等待转写设置读取完成后再保存。");
  return {
    enabled: fields.transcriptionEnabled.checked,
    apiKey: fields.aliyunApiKey.value.trim(),
    model: fields.transcriptionModel.value,
  };
}

function updateTranscriptionModelHint() {
  const model = transcriptionModels.find((item) => item.id === fields.transcriptionModel.value);
  transcriptionModelHintNode.textContent = model ? `${model.id} · ${model.description}` : "请选择转写模型。";
}

function showSavedTranscriptionModel(model) {
  transcriptionModelStatusNode.textContent = `当前已保存的模型：${model}。后续提交的任务使用此模型。`;
}

function readMonitorSettings() {
  return {
    enabled: fields.monitorEnabled.checked,
    targetConversation: fields.targetConversation.value.trim(),
    selfSenderName: fields.selfSenderName.value.trim(),
    openOnStartup: fields.openOnStartup.checked,
  };
}

async function refreshMonitorStatus() {
  try {
    const response = await sendMessage({ type: "douhot:getMonitorStatus" });
    const status = response.data || {};
    const parts = [status.message || "等待监控启动"];
    if (status.lastSuccessAt) parts.push(`最近成功：${formatLocalTime(status.lastSuccessAt)}`);
    if (Number(status.pendingCount) > 0) parts.push(`待重试：${status.pendingCount} 条`);
    setMonitorStatus(parts.join("｜"), status.state === "error");
  } catch (error) {
    setMonitorStatus(error.message, true);
  }
}

function setMonitorStatus(message, isError = false) {
  monitorStatusNode.textContent = message;
  monitorStatusNode.classList.toggle("error", isError);
}

function formatLocalTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleString("zh-CN", { hour12: false });
}

function readSettings() {
  return {
    enabled: true,
    collectorName: fields.collectorName.value.trim(),
    authMode: fields.authMode.value,
    personalBaseToken: fields.personalBaseToken.value.trim(),
    appId: fields.appId.value.trim(),
    appSecret: fields.appSecret.value.trim(),
    appToken: fields.appToken.value.trim(),
    tableId: fields.tableId.value.trim(),
    autoCreateFields: fields.autoCreateFields.checked,
    upsertByCreatorId: fields.upsertByCreatorId.checked,
  };
}

function updateAuthModeVisibility() {
  const isOpenApi = fields.authMode.value === "openApi";
  document.getElementById("personal-token-section").hidden = fields.authMode.value !== "personalBaseToken";
  document.getElementById("open-api-section").hidden = !isOpenApi;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "操作失败"));
        return;
      }
      resolve(response);
    });
  });
}

function parseBaseUrl(input) {
  const source = String(input || "").trim();
  const result = { appToken: "", tableId: "", wikiToken: "" };
  if (!source) return result;
  try {
    const url = new URL(source);
    const baseMatch = url.pathname.match(/\/base\/([^/?#]+)/);
    if (baseMatch) result.appToken = decodeURIComponent(baseMatch[1]);
    const wikiMatch = url.pathname.match(/\/wiki\/([^/?#]+)/);
    if (wikiMatch) result.wikiToken = decodeURIComponent(wikiMatch[1]);
    result.tableId = url.searchParams.get("table") || url.searchParams.get("table_id") || "";
  } catch (error) {
    const baseMatch = source.match(/\/base\/([^/?#]+)/);
    if (baseMatch) result.appToken = decodeURIComponent(baseMatch[1]);
    const wikiMatch = source.match(/\/wiki\/([^/?#]+)/);
    if (wikiMatch) result.wikiToken = decodeURIComponent(wikiMatch[1]);
    const tableMatch = source.match(/[?&](?:table|table_id)=([^&#]+)/);
    if (tableMatch) result.tableId = decodeURIComponent(tableMatch[1]);
  }
  return result;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle("error", isError);
}

