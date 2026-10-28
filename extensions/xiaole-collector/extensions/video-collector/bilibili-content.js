(() => {
  if (document.getElementById('fish-bili-panel')) return;
  const panel = document.createElement('aside');
  panel.id = 'fish-bili-panel';
  panel.innerHTML = `<style>
    #fish-bili-panel{position:fixed;right:18px;bottom:18px;z-index:2147483600;width:250px;background:#fff;color:#1f2937;border:1px solid #dbeafe;border-radius:12px;padding:14px;box-shadow:0 6px 24px #0002;font:13px/1.5 system-ui;text-align:left;box-sizing:border-box}
    #fish-bili-panel [hidden]{display:none!important} #fish-bili-panel strong{font-size:15px} #fish-bili-panel button{display:block;width:100%;padding:8px;margin-top:7px;border:1px solid #cbd5e1;background:#eff6ff;border-radius:6px;color:#1d4ed8;font:inherit;cursor:pointer}
    #fish-bili-panel button:disabled{opacity:.5;cursor:default} #fish-bili-panel label{display:flex;gap:6px;align-items:center;margin-top:8px;font:inherit}
    #fish-bili-panel small{display:block;color:#64748b;font-size:11px} #fish-bili-status{margin-top:9px;overflow-wrap:anywhere} #fish-bili-panel .error{color:#b91c1c}
    #fish-bili-panel .controls{display:flex;gap:5px} #fish-bili-panel .controls button{flex:1;background:#fff;color:#475569}
    #fish-bili-filter{position:fixed;inset:0;z-index:2147483640;background:#0005;display:grid;place-items:center;font:14px/1.5 system-ui;color:#1f2937}
    #fish-bili-filter form{background:#fff;width:340px;padding:22px;border-radius:12px;box-sizing:border-box} #fish-bili-filter label{display:block;margin:10px 0}
    #fish-bili-filter input,#fish-bili-filter select{box-sizing:border-box;display:block;width:100%;padding:7px;border:1px solid #cbd5e1;border-radius:5px;font:inherit}
    #fish-bili-filter button{padding:8px 14px;margin-right:8px;border:1px solid #cbd5e1;border-radius:5px;cursor:pointer}
  </style><strong>小乐收集 · B站</strong>
  <label><input type="checkbox" id="fish-bili-comments">抓取前3条热评</label>
  <label><input type="checkbox" id="fish-bili-transcribe">本次同步后转逐字稿</label>
  <small>批量转写会按选中视频调用阿里云并产生费用。</small>
  <button data-task="single">同步当前视频</button><button data-task="works">同步UP主作品</button><button data-task="filter">筛选作品同步</button>
  <button data-task="creator">同步UP主信息</button><button data-task="export">导出当前视频 JSON</button>
  <div class="controls"><button id="fish-bili-pause" disabled>暂停</button><button id="fish-bili-stop" disabled>停止</button><button id="fish-bili-minimize">收起</button></div>
  <div id="fish-bili-status" role="status" aria-live="polite">打开视频详情页或UP主空间后使用。</div>`;
  document.body.append(panel);
  const status = panel.querySelector('#fish-bili-status');
  const pause = panel.querySelector('#fish-bili-pause'), stop = panel.querySelector('#fish-bili-stop');
  let activeRun = '', paused = false;
  const send = (message) => new Promise((resolve,reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError || !response?.ok) reject(new Error(chrome.runtime.lastError?.message || response?.error || '操作失败'));
    else resolve(response.data);
  }));
  const report = (text, error = false) => { status.textContent = text; status.classList.toggle('error',error); };
  const mid = () => location.hostname === 'space.bilibili.com' ? location.pathname.match(/^\/(\d+)/)?.[1] || '' : '';
  const control = (action) => send({ type: 'douhot:manualRunControl', payload: { action, runId: activeRun } });
  pause.addEventListener('click', async () => {
    try { await control(paused ? 'resume' : 'pause'); paused = !paused; pause.textContent = paused ? '继续' : '暂停'; report(paused ? '已暂停，点击继续恢复' : '继续采集中…'); }
    catch (error) { report(error.message,true); }
  });
  stop.addEventListener('click', () => { void control('finish').catch(() => {}); report('已停止，尚未提交的作品不会入库'); });
  let minimized = false;
  panel.querySelector('#fish-bili-minimize').addEventListener('click', () => {
    minimized = !minimized;
    for (const node of panel.querySelectorAll('label,small,[data-task],#fish-bili-status')) node.hidden = minimized;
    panel.querySelector('#fish-bili-minimize').textContent = minimized ? '展开' : '收起';
  });

  function filterDialog() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div'); overlay.id = 'fish-bili-filter';
      overlay.innerHTML = `<form><strong>B站作品筛选</strong><label>发布日期从<input name="from" type="date"></label><label>发布日期到<input name="to" type="date"></label>
        <label>最低点赞<input name="minLikes" type="number" min="0" value="0"></label><label>排序<select name="sort"><option value="default">发布时间从新到旧</option><option value="likes">点赞从高到低</option><option value="comments">评论从高到低</option></select></label>
        <label>最多采集条数<input name="limit" type="number" min="0" max="1000" value="100"></label><small>0表示最多1000条；排序会读取最多1000条再排序。</small><p id="fish-bili-filter-error"></p>
        <button type="submit">开始采集</button><button type="button" id="fish-bili-filter-cancel">取消</button></form>`;
      document.body.append(overlay);
      const done = (value) => { overlay.remove(); resolve(value); };
      overlay.querySelector('#fish-bili-filter-cancel').addEventListener('click',() => done(null));
      overlay.querySelector('form').addEventListener('submit',(event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        if (data.from && data.to && data.from > data.to) { overlay.querySelector('#fish-bili-filter-error').textContent = '开始日期不能晚于结束日期'; return; }
        done({ ...data, minLikes: Number(data.minLikes), limit: Number(data.limit) });
      });
    });
  }

  function downloadJson(data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{ type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `bilibili-${data.works?.[0]?.bvid || 'up'}-${Date.now()}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  async function run(task, options = {}) {
    if (activeRun) throw new Error('采集正在进行，请先完成或停止本次任务');
    if (task === 'filter' || options.prompt) {
      const selected = await filterDialog(); if (!selected) return { cancelled: true };
      options = { ...options, ...selected }; task = 'works';
    }
    if (['creator','works'].includes(task) && !mid()) throw new Error('请打开 space.bilibili.com 的UP主空间页');
    if (['single','export'].includes(task) && !BiliCore.videoRef(location.href)) throw new Error('请打开 www.bilibili.com/video/ 的视频详情页');
    activeRun = crypto.randomUUID(); paused = false;
    const runId = activeRun;
    let heartbeat;
    try {
      await control('start');
      heartbeat = setInterval(() => { void control('heartbeat').catch(() => {}); },15000);
      for (const button of panel.querySelectorAll('[data-task]')) button.disabled = true;
      pause.disabled = stop.disabled = false; pause.textContent = '暂停';
      report('正在读取B站数据…');
      const types = { single:'collectSingle', export:'collectSingle', works:'collectWorks', creator:'collectCreator' };
      if (task === 'works') options.loadedLinks = [...new Set(Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.href).filter((url) => BiliCore.videoRef(url)))].slice(0,1000);
      const data = await send({ type:'bilibili:' + types[task], runId, payload:{ mid:mid(), input:location.href, options } });
      let feishuSync;
      if (options.sync !== false && task !== 'export') {
        report(options.transcribe ? '正在获取音轨并同步飞书…' : '正在同步飞书…');
        const response = await send({ type: task === 'creator' ? 'douhot:syncFeishu' : 'douhot:syncWorksFeishu', runId, payload:data });
        feishuSync = response;
      }
      if (options.download || task === 'export') downloadJson(data);
      if (options.copy) await navigator.clipboard.writeText(JSON.stringify(data,null,2)).catch(() => undefined);
      const warnings = data.works?.filter((w) => w.commentLookupError || w.mediaLookupError || w.tagLookupError).length || 0;
      const warningText = warnings ? `；${warnings}条视频的标签/评论/音轨未读到` : '';
      report(feishuSync ? `${task === 'creator' ? 'UP主信息' : (feishuSync.total || data.count) + '条视频'}已同步飞书${feishuSync.transcription ? `，转写排队 ${feishuSync.transcription.queued || 0} 条` : ''}${data.loadedPageFallback ? '（仅当前主页已加载作品；可翻页后继续采集）' : ''}${data.truncated ? '（已达1000条上限）' : ''}${warningText}` : '已导出B站 JSON' + warningText);
      return { ...data, feishuSync };
    } finally {
      clearInterval(heartbeat);
      await control('finish').catch(() => {});
      activeRun = '';
      for (const button of panel.querySelectorAll('[data-task]')) button.disabled = false;
      pause.disabled = stop.disabled = true;
    }
  }
  for (const button of panel.querySelectorAll('[data-task]')) button.addEventListener('click', () => {
    void run(button.dataset.task, { includeComments:panel.querySelector('#fish-bili-comments').checked,
      transcribe:panel.querySelector('#fish-bili-transcribe').checked }).catch((error) => report(error.message,true));
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'bilibili:progress') { if (message.runId === activeRun && !paused) report(message.text); respond({ ok:true }); return false; }
    const map = { 'douhot:run':'creator', 'douhot:runWorks':'works', 'douhot:runSingleWork':'single' };
    let task = map[message.type];
    if (!task) return false;
    if (message.type === 'douhot:run' && BiliCore.videoRef(location.href)) task = 'single';
    const options = { ...message.options };
    if (options.download && options.sync === false && task === 'single') task = 'export';
    run(task,options).then((data) => respond({ ok:true, data })).catch((error) => { report(error.message,true); respond({ ok:false,error:error.message }); });
    return true;
  });
  if (location.hostname === 'message.bilibili.com') {
    for (const node of panel.querySelectorAll('label,small,[data-task],.controls')) node.hidden = true;
    const poll = async () => {
      try {
        await send({ type:'bilibili:pollMonitor' });
        const data = await send({ type:'bilibili:getMonitor' });
        report(data.status.message || '请在插件设置中填写对方UID并开启B站私信监控',data.status.state === 'error');
      } catch (error) { report(error.message,true); }
    };
    void poll(); setInterval(() => void poll(),15000);
  }
})();

