let biliOptionsLoaded = false;
const biliOptionNodes = {
  enabled: document.getElementById('biliMonitorEnabled'), uid: document.getElementById('biliTalkerUid'),
  selfOnly: document.getElementById('biliSelfOnly'), status: document.getElementById('biliMonitorStatus'),
  save: document.getElementById('saveBiliMonitor'),
};
function readBilibiliOptions() {
  if (!biliOptionsLoaded) throw new Error('请等待B站监控设置读取完成');
  const data = { enabled:biliOptionNodes.enabled.checked, talkerUid:biliOptionNodes.uid.value.trim(), selfOnly:biliOptionNodes.selfOnly.checked };
  if ((data.talkerUid && !/^\d+$/.test(data.talkerUid)) || (data.enabled && !data.talkerUid)) throw new Error('请填写有效的B站对方UID');
  return data;
}
async function saveBilibiliOptions() {
  const response = await sendMessage({ type:'bilibili:saveMonitor', payload:readBilibiliOptions() });
  biliOptionNodes.status.textContent = response.data.enabled ? 'B站监控设置已保存，正在建立历史基线' : 'B站监控设置已保存；监控已关闭';
  return response;
}
async function refreshBilibiliOptions(initial = false) {
  const response = await sendMessage({ type:'bilibili:getMonitor' });
  const { settings, status } = response.data;
  if (initial) {
    biliOptionNodes.enabled.checked = settings.enabled;
    biliOptionNodes.uid.value = settings.talkerUid;
    biliOptionNodes.selfOnly.checked = settings.selfOnly;
    biliOptionsLoaded = true; biliOptionNodes.save.disabled = false;
  }
  biliOptionNodes.status.textContent = status.message || (settings.enabled ? '等待B站监控启动' : 'B站私信监控已关闭');
  biliOptionNodes.status.style.color = status.state === 'error' ? '#b91c1c' : '';
}
async function biliOptionsAction(action) {
  try { await action(); } catch (error) { biliOptionNodes.status.textContent = error.message; biliOptionNodes.status.style.color = '#b91c1c'; }
}
biliOptionNodes.save.addEventListener('click',() => void biliOptionsAction(saveBilibiliOptions));
document.getElementById('refreshBiliMonitor').addEventListener('click',() => void biliOptionsAction(refreshBilibiliOptions));
document.getElementById('openBiliMonitor').addEventListener('click',() => void biliOptionsAction(async () => {
  await saveBilibiliOptions(); await sendMessage({ type:'bilibili:openMonitor' });
}));
void biliOptionsAction(() => refreshBilibiliOptions(true));
