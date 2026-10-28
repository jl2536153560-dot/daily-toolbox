(() => {
  const toggle = document.getElementById('bili-popup-toggle'), status = document.getElementById('bili-popup-status');
  let settings;
  async function refresh() {
    const response = await sendRuntimeMessage({ type:'bilibili:getMonitor' });
    settings = response.data.settings;
    toggle.disabled = false; toggle.textContent = settings.enabled ? '关闭B站监控' : '开启B站监控';
    status.textContent = response.data.status.message || (settings.enabled ? 'B站监控开启' : 'B站监控关闭');
  }
  async function action(fn) { try { await fn(); } catch (error) { status.textContent = error.message; } }
  toggle.addEventListener('click', () => void action(async () => {
    if (!settings.talkerUid) { chrome.runtime.openOptionsPage(); status.textContent = '请先在设置中填写B站对方UID'; return; }
    await sendRuntimeMessage({ type:'bilibili:saveMonitor', payload:{ ...settings, enabled:!settings.enabled } });
    await refresh();
  }));
  document.getElementById('bili-popup-open').addEventListener('click', () => void action(() => sendRuntimeMessage({ type:'bilibili:openMonitor' })));
  void action(refresh);
})();
