var BiliBg = (() => {
  const SETTINGS = 'bilibiliMonitorV1', STATUS = 'bilibiliMonitorStatusV1', CURSOR = 'bilibiliMonitorCursorV1';
  const defaults = { enabled: false, talkerUid: '', selfOnly: true };
  let wbi = null, headersReady = null, polling = false, monitorGeneration = 0;

  async function ensureHeaders() {
    if (!headersReady) headersReady = chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [41001], addRules: [{ id: 41001, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.bilibili.com/' }] },
        condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['bilibili.com', 'bilivideo.com', 'bilivideo.cn', 'bilivideo.net'], resourceTypes: ['xmlhttprequest'] },
      }],
    }).catch((error) => { headersReady = null; throw new Error('B站访问权限尚未生效，请重新加载扩展：' + error.message); });
    return headersReady;
  }

  async function api(path, params = {}, { signed = false, nav = false, vc = false, run = null } = {}) {
    await manualRunCheckpoint(run);
    await ensureHeaders();
    let query = new URLSearchParams(params).toString();
    if (signed) {
      if (!wbi || Date.now() - wbi.at > 600000) {
        const data = await api('/x/web-interface/nav', {}, { nav: true, run });
        wbi = { ...data.wbi_img, at: Date.now() };
      }
      query = BiliCore.sign(params, wbi.img_url, wbi.sub_url);
    }
    const json = await withTranscriptionMediaTimeout(async (signal) => {
      const response = await fetch(`https://${vc ? 'api.vc' : 'api'}.bilibili.com${path}?${query}`, {
        method: 'GET', credentials: 'include', cache: 'no-store', signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const error = new Error(`B站接口 HTTP ${response.status}，请稍后重试`);
        if ([403,412].includes(response.status)) error.code = 'BILI_API_ERROR';
        throw error;
      }
      return response.json();
    });
    if (Number(json.code) !== 0 && !(nav && Number(json.code) === -101 && json.data?.wbi_img)) {
      const error = new Error(`B站接口 ${json.code}：${json.message || json.msg || '读取失败'}${[-101,-111].includes(Number(json.code)) ? '，请先在 Chrome 登录B站' : ''}`);
      error.code = Number(json.code) === -404 || Number(json.code) === 62002 ? 'BILI_VIDEO_UNAVAILABLE' : 'BILI_API_ERROR';
      throw error;
    }
    return json.data || {};
  }

  async function resolveReference(input) {
    let ref = BiliCore.videoRef(input);
    if (!ref) throw new Error('请提供有效的B站视频链接、BV号或av号');
    if (ref.shortUrl) {
      const finalUrl = await withTranscriptionMediaTimeout(async (signal) => {
        const response = await fetch(ref.shortUrl, { redirect: 'follow', credentials: 'omit', signal });
        await response.body?.cancel().catch(() => undefined);
        return response.url;
      });
      ref = BiliCore.videoRef(finalUrl);
      if (!ref || ref.shortUrl) throw new Error('B站短链接未跳转到可识别的视频');
    }
    return ref;
  }

  async function detail(input, run = null) {
    const ref = await resolveReference(input);
    const data = await api('/x/web-interface/view', ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid }, { run });
    if ((ref.bvid && data.bvid !== ref.bvid) || (ref.aid && String(data.aid) !== ref.aid)) throw new Error('B站返回的视频 ID 不匹配');
    return BiliCore.normalizeWork(data, ref.page);
  }

  async function resolveWorkAudio(input, run = null) {
    const work = await detail(input, run);
    const data = await api('/x/player/playurl', { bvid: work.bvid, cid: work.cid, fnval: 16, fnver: 0, qn: 16 }, { run });
    const sources = BiliCore.audioSources(data);
    return { ...work, mediaUrl: sources[0], mediaFallbackUrl: sources[1] || '', mediaAlternatives: sources.slice(1),
      transcriptionMediaRecoveryRequested: true };
  }

  async function recoverMedia(job) {
    await ensureHeaders();
    const original = job.result?.works?.[0] || {};
    const fresh = await resolveWorkAudio(original.videoLink || job.key);
    const failures = [];
    for (const source of [...new Set([fresh.mediaUrl, ...fresh.mediaAlternatives])].slice(0, 3)) {
      try {
        const downloaded = await downloadTranscriptionMedia(source);
        return { ...downloaded, result: { ...job.result, works: [{ ...original, sourcePlayUri: '',
          mediaUrl: downloaded.mediaUrl, mediaFallbackUrl: '', cid: fresh.cid }] } };
      } catch (error) { failures.push(safeMediaLookupError(error)); }
    }
    throw new Error('B站音轨下载失败：' + failures.join('；'));
  }

  async function comments(work, run) {
    const data = await api('/x/v2/reply', { type: 1, oid: work.aid, sort: 2, pn: 1 }, { run });
    const replies = [...(data.top_replies || []), ...(data.replies || [])];
    const unique = [...new Map(replies.map((reply) => [String(reply.rpid), reply])).values()];
    return unique.filter(reply => hasCommentText(reply.content?.message, Object.keys(reply.content?.emote || {}))).sort((a,b) => Number(b.like || 0) - Number(a.like || 0)).slice(0,3)
      .map((reply, i) => `${i + 1}. ${reply.member?.uname || ''}：${reply.content?.message || ''}（赞 ${reply.like || 0}）`).join('\n');
  }

  async function readTags(work, run) {
    try {
      const data = await api('/x/tag/archive/tags', { bvid: work.bvid }, { run });
      if (!Array.isArray(data)) throw new Error('B站标签接口返回格式异常');
      work.tags = [...new Set(data.map((tag) => String(tag.tag_name || '').trim()).filter(Boolean))];
    } catch (error) {
      if (error.code === 'MANUAL_RUN_ENDED') throw error;
      work.tagLookupError = safeMediaLookupError(error);
    }
  }

  async function collectSingle(input, options = {}, run = null) {
    let work = await detail(input, run);
    await readTags(work, run);
    if (options.includeComments) {
      try { work.hotCommentsText = await comments(work, run); }
      catch (error) { if (error.code === 'MANUAL_RUN_ENDED') throw error; work.commentLookupError = safeMediaLookupError(error); }
    }
    if (options.transcribe) work = await prepareWorkForTranscription(work, Boolean((await getTranscriptionSettings()).apiKey), 0, run);
    return result([work], options);
  }

  function result(works, options = {}, sourceUrl = works[0]?.videoLink) {
    return { sourceUrl, platform: '哔哩哔哩', extractedAt: new Date().toISOString(),
      creatorId: works[0]?.creatorId || '', creatorName: works[0]?.authorName || '',
      transcriptionRequested: options.transcribe === true, count: works.length, works };
  }

  async function collectProfile(mid, options = {}, run = null, progress = () => {}) {
    if (!/^\d+$/.test(String(mid))) throw new Error('请打开B站 UP 主空间页');
    const limit = Number(options.limit || 0);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw new Error('采集数量须为0到1000，0表示最多1000条');
    const works = [], seen = new Set();
    let count = Infinity;
    for (let pn = 1; pn <= 34 && seen.size < count && seen.size < 1000; pn++) {
      await manualRunCheckpoint(run);
      let page;
      try { page = await api('/x/space/wbi/arc/search', { mid, pn, ps: 30, order: 'pubdate' }, { signed: true, run }); }
      catch (error) {
        if (error.code !== 'BILI_API_ERROR' || !options.loadedLinks?.length) throw error;
        // Use only links actually loaded in the current UP page. Each video
        // owner is checked below; this fallback never claims a complete list.
        const links = [...new Set(options.loadedLinks)].filter((link) => BiliCore.videoRef(link)).slice(0,1000);
        for (const link of links) {
          await manualRunCheckpoint(run);
          const work = await detail(link,run);
          if (work.creatorId !== `bilibili:${mid}` || seen.has(work.bvid)) continue;
          seen.add(work.bvid);
          if (options.from && work.publishTimestamp < Date.parse(options.from + 'T00:00:00+08:00')) continue;
          if (options.to && work.publishTimestamp >= Date.parse(options.to + 'T00:00:00+08:00') + 86400000) continue;
          if (Number(work.likeCount || 0) >= Number(options.minLikes || 0)) works.push(work);
          await progress(`正在读取已加载作品 ${seen.size} 条（主页接口受限）`);
          await delay(350);
        }
        options = { ...options, loadedPageFallback:true };
        break;
      }
      const list = page.list?.vlist || [];
      count = Number(page.page?.count || 0);
      if (!list.length) break;
      let newIds = 0;
      for (const item of list) {
        if (seen.size >= 1000) break;
        if (!item.bvid || seen.has(item.bvid)) continue;
        seen.add(item.bvid); newIds++;
        await manualRunCheckpoint(run);
        const publication = Number(item.created) * 1000;
        if (options.from && publication < Date.parse(options.from + 'T00:00:00+08:00')) continue;
        if (options.to && publication >= Date.parse(options.to + 'T00:00:00+08:00') + 86400000) continue;
        const work = await detail(item.bvid, run);
        if (work.creatorId !== `bilibili:${mid}`) throw new Error('B站主页列表中的视频UP主ID不匹配');
        if (Number(work.likeCount || 0) >= Number(options.minLikes || 0)) works.push(work);
        await progress(`已读取 ${seen.size} 条，符合筛选 ${works.length} 条`);
        await delay(350);
        if (limit && works.length >= limit && !['likes','comments'].includes(options.sort)) break;
      }
      if (!newIds || (limit && works.length >= limit && !['likes','comments'].includes(options.sort))) break;
    }
    if (options.sort === 'likes') works.sort((a,b) => Number(b.likeCount || 0) - Number(a.likeCount || 0));
    if (options.sort === 'comments') works.sort((a,b) => Number(b.commentCount || 0) - Number(a.commentCount || 0));
    const selected = limit ? works.slice(0,limit) : works;
    if (!selected.length) throw new Error('没有符合条件的B站视频');
    for (let i = 0; i < selected.length; i++) {
      await manualRunCheckpoint(run);
      await readTags(selected[i], run);
      await delay(350);
      if (options.includeComments) {
        try { selected[i].hotCommentsText = await comments(selected[i], run); }
        catch (error) { if (error.code === 'MANUAL_RUN_ENDED') throw error; selected[i].commentLookupError = safeMediaLookupError(error); }
        await delay(350);
      }
    }
    return { ...result(selected, options, `https://space.bilibili.com/${mid}`),
      scanned: seen.size, availableCount: Number.isFinite(count) ? count : null,
      loadedPageFallback: Boolean(options.loadedPageFallback),
      truncated: seen.size >= 1000 && seen.size < count };
  }

  async function collectCreator(mid, run = null) {
    if (!/^\d+$/.test(String(mid))) throw new Error('请打开B站 UP 主空间页');
    const data = await api('/x/web-interface/card', { mid }, { run });
    const profile = data.card || {};
    if (String(profile.mid) !== String(mid)) throw new Error('B站UP主名片的UID不匹配');
    return { platform: '哔哩哔哩', sourceUrl: `https://space.bilibili.com/${mid}`, creatorId: `bilibili:${mid}`,
      extractedAt: new Date().toISOString(), profile: { name: profile.name, signature: profile.sign, followerCount: data.follower ?? profile.fans, workCount:data.archive_count,
        bilibiliProfileUrl: `https://space.bilibili.com/${mid}`, bilibiliUid: String(mid) } };
  }

  async function getSettings() {
    return { ...defaults, ...(await chrome.storage.local.get({ [SETTINGS]: defaults }))[SETTINGS] };
  }
  async function saveSettings(input) {
    monitorGeneration++;
    const previous = await getSettings();
    const next = { enabled: input.enabled === true, talkerUid: String(input.talkerUid || '').trim(), selfOnly: input.selfOnly !== false };
    if (next.talkerUid && !/^\d+$/.test(next.talkerUid)) throw new Error('B站对方 UID 必须为数字');
    if (next.enabled && !next.talkerUid) throw new Error('请先填写B站目标私信的对方 UID');
    const changed = previous.talkerUid !== next.talkerUid || (!previous.enabled && next.enabled);
    await chrome.storage.local.set({ [SETTINGS]: next, ...(changed ? { [CURSOR]: null } : {}) });
    await status({ state: next.enabled ? 'starting' : 'off', message: next.enabled ? '正在建立B站私信历史基线' : 'B站私信监控已关闭' });
    return next;
  }
  async function status(patch) {
    const data = (await chrome.storage.local.get({ [STATUS]: {} }))[STATUS];
    const next = { ...data, ...patch, updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ [STATUS]: next }); return next;
  }
  async function getStatus() { return (await chrome.storage.local.get({ [STATUS]: {} }))[STATUS]; }
  const seq = (message) => {
    const value = message.msg_seqno;
    if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) throw new Error('B站消息序号无效，已停止以避免漏采');
    return BigInt(value);
  };

  async function pollMonitor() {
    if (polling) return { running: true };
    polling = true;
    const generation = monitorGeneration;
    try {
      const settings = await getSettings();
      if (!settings.enabled || !settings.talkerUid) return { disabled: true };
      const account = await api('/x/web-interface/nav', {}, { nav: true });
      if (!account.isLogin || !account.mid) throw new Error('请先在 Chrome 登录B站，监控只读取当前登录账号的指定私信');
      let cursor = (await chrome.storage.local.get({ [CURSOR]: null }))[CURSOR];
      const identity = `${account.mid}:${settings.talkerUid}`;
      const messages = [];
      let endSeqno = '', reachedCursor = false;
      for (let page = 0; page < 10; page++) {
        const data = await api('/svr_sync/v1/svr_sync/fetch_session_msgs', { talker_id: settings.talkerUid,
          session_type: 1, size: 20, sender_device_id: 1, build: 0, mobi_app: 'web', ...(endSeqno ? { end_seqno: endSeqno } : {}) }, { vc: true, signed: true });
        const batch = data.messages || [];
        messages.push(...batch);
        if (!cursor || cursor.identity !== identity || !batch.length) { reachedCursor = true; break; }
        const min = batch.reduce((n,m) => seq(m) < n ? seq(m) : n, seq(batch[0]));
        if (min <= BigInt(cursor.seqno) || !Number(data.has_more)) { reachedCursor = true; break; }
        const nextEnd = min.toString();
        if (nextEnd === endSeqno) break;
        endSeqno = nextEnd;
      }
      if (!reachedCursor) throw new Error('新增私信超过单次200条或分页无进展，已暂停且保留进度');
      if (!cursor || cursor.identity !== identity) {
        if (generation !== monitorGeneration) return { stopped: true };
        const max = messages.reduce((n,m) => seq(m) > n ? seq(m) : n, 0n);
        await chrome.storage.local.set({ [CURSOR]: { identity, seqno: max.toString() } });
        await status({ state: 'watching', message: 'B站历史基线已建立，只采集此后新增的视频分享' });
        return { baseline: true };
      }
      const unique = [...new Map(messages.map((m) => [seq(m).toString(),m])).values()]
        .filter((m) => seq(m) > BigInt(cursor.seqno)).sort((a,b) => seq(a) < seq(b) ? -1 : 1);
      let queued = 0, skipped = 0;
      for (const message of unique) {
        if (generation !== monitorGeneration) return { stopped: true, queued };
        const latest = await getSettings();
        if (!latest.enabled || latest.talkerUid !== settings.talkerUid || latest.selfOnly !== settings.selfOnly) return { stopped: true, queued };
        if (!settings.selfOnly || String(message.sender_uid) === String(account.mid)) {
          for (const link of BiliCore.linksFromMessage(message)) {
            try {
              const transcription = await getTranscriptionSettings();
              const collected = await collectSingle(link, { transcribe: transcription.enabled });
              if (generation !== monitorGeneration) return { stopped: true, queued };
              collected.sortText = 'B站私信自动监控';
              await enqueueMonitorResult(collected); queued++;
            } catch (error) {
              if (error.code !== 'BILI_VIDEO_UNAVAILABLE') throw error;
              skipped++;
            }
          }
        }
        cursor = { identity, seqno: seq(message).toString() };
        if (generation !== monitorGeneration) return { stopped: true, queued };
        await chrome.storage.local.set({ [CURSOR]: cursor });
      }
      await status({ state: skipped ? 'error' : 'watching', message: `B站私信监控中；本轮入队 ${queued} 条${skipped ? `，失效视频 ${skipped} 条` : ''}` });
      return { queued, skipped };
    } catch (error) { if (generation === monitorGeneration) await status({ state: 'error', message: safeMediaLookupError(error) }); return { error: safeMediaLookupError(error) }; }
    finally { polling = false; }
  }

  async function openMonitor() {
    const settings = await getSettings();
    const url = 'https://message.bilibili.com/#/whisper' + (settings.talkerUid ? '/mid' + settings.talkerUid : '');
    const tabs = await chrome.tabs.query({ url: ['https://message.bilibili.com/*'] });
    if (tabs[0]?.id) { await chrome.tabs.update(tabs[0].id, { url, active: true }); return { tabId: tabs[0].id }; }
    return chrome.tabs.create({ url, active: true });
  }

  async function handle(message, sender, run) {
    switch (message.type) {
      case 'bilibili:getMonitor': return { settings: await getSettings(), status: await getStatus() };
      case 'bilibili:saveMonitor': return saveSettings(message.payload || {});
      case 'bilibili:openMonitor': return openMonitor();
      case 'bilibili:pollMonitor': return pollMonitor();
      case 'bilibili:collectSingle': return collectSingle(message.payload?.input, message.payload?.options, run);
      case 'bilibili:collectWorks': return collectProfile(message.payload?.mid, message.payload?.options, run, async (text) => {
        if (sender.tab?.id) await chrome.tabs.sendMessage(sender.tab.id, { type: 'bilibili:progress', runId: message.runId, text }).catch(() => undefined);
      });
      case 'bilibili:collectCreator': return collectCreator(message.payload?.mid, run);
      default: throw new Error('未知B站操作');
    }
  }
  function initialize() {
    chrome.alarms.create('bilibiliMonitorPollV1', { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'bilibiliMonitorPollV1') void pollMonitor(); });
    void ensureHeaders().catch(() => undefined);
  }
  return { api, detail, resolveWorkAudio, recoverMedia, collectSingle, collectProfile, collectCreator,
    ensureHeaders, getSettings, saveSettings, getStatus, pollMonitor, openMonitor, handle, initialize };
})();
