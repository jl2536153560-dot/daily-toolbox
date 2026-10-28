/* Shared parsing and request signing. No browser state or network access. */
var BiliCore = (() => {
  function videoRef(value) {
    const text = String(value || '').trim();
    if (/^BV[0-9A-Za-z]{10}$/.test(text)) return { bvid: text, page: 1 };
    if (/^av\d+$/i.test(text)) return { aid: text.slice(2), page: 1 };
    try {
      const url = new URL(text.startsWith('//') ? 'https:' + text : text);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      if (url.hostname === 'b23.tv') return { shortUrl: 'https://' + url.host + url.pathname };
      if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return null;
      const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:\/|$)/);
      if (!match) return null;
      const page = Number(url.searchParams.get('p') || 1);
      if (!Number.isSafeInteger(page) || page < 1) return null;
      return { ...videoRef(match[1]), page };
    } catch (_) { return null; }
  }

  function linksFromMessage(message) {
    let content = message.content;
    if (typeof content === 'string') { try { content = JSON.parse(content); } catch (_) {} }
    const links = [];
    // Current B站 web client: SHARE_V2/source=5 and VIDEO_CARD/rid.
    if (Number(message.msg_type) === 7 && Number(content?.source) === 5 && /^\d+$/.test(String(content.id))) links.push(`https://www.bilibili.com/video/av${content.id}/`);
    if (Number(message.msg_type) === 11 && /^\d+$/.test(String(content?.rid))) links.push(`https://www.bilibili.com/video/av${content.rid}/`);
    const walk = (value, depth = 0) => {
      if (depth > 5) return;
      if (typeof value === 'string') {
        for (const url of value.match(/https?:\/\/[^\s<>"'，。]+/g) || []) {
          const clean = url.replace(/[)\]）]+$/, '');
          if (videoRef(clean)) links.push(clean);
        }
        if (/^BV[0-9A-Za-z]{10}$/.test(value)) links.push(`https://www.bilibili.com/video/${value}/`);
      } else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, depth + 1));
    };
    walk(content);
    return [...new Set(links)];
  }

  function canonicalLink(bvid, page = 1) {
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('B站没有返回有效 BV 号');
    return `https://www.bilibili.com/video/${bvid}/${page > 1 ? '?p=' + page : ''}`;
  }

  function normalizeWork(data, page = 1) {
    const part = data.pages?.find((p) => Number(p.page) === page);
    if (!part?.cid) throw new Error('B站分P不存在或没有可用 CID');
    const stat = data.stat || {};
    return {
      platform: '哔哩哔哩', id: data.bvid, bvid: data.bvid, aid: String(data.aid), cid: String(part.cid), page,
      creatorId: `bilibili:${data.owner?.mid}`, authorName: data.owner?.name || '',
      title: page > 1 ? `${data.title} / P${page} ${part.part || ''}`.trim() : data.title,
      videoLink: canonicalLink(data.bvid, page), coverUrl: String(data.pic || '').replace(/^http:/, 'https:'),
      likeCount: stat.like, commentCount: stat.reply, collectCount: stat.favorite, shareCount: stat.share,
      playCount: stat.view, danmakuCount: stat.danmaku, coinCount: stat.coin,
      durationSeconds: Number(part.duration || data.duration || 0), publishTimestamp: Number(data.pubdate) * 1000,
      tags: [], mediaUrl: '',
    };
  }

  function audioSources(data) {
    const tracks = (data.dash?.audio || []).filter((track) => track.baseUrl || track.base_url)
      .sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0));
    const track = tracks.find((t) => /mp4a/i.test(t.codecs || '')) || tracks[0];
    if (track) return [track.baseUrl || track.base_url, ...(track.backupUrl || track.backup_url || [])]
      .map((s) => String(s).replace(/^http:/, 'https:')).filter((s) => /^https:\/\//.test(s));
    if (data.durl?.length === 1) return [data.durl[0].url, ...(data.durl[0].backup_url || [])].map((s) => String(s).replace(/^http:/, 'https:'));
    throw new Error('B站未提供可用音轨；请确认该视频可在当前账号完整播放');
  }

  function md5(text) {
    const input = new TextEncoder().encode(text);
    const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
    padded.set(input); padded[input.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (input.length * 8) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(input.length / 0x20000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
    for (let offset = 0; offset < padded.length; offset += 64) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, index;
        if (i < 16) { f = (b & c) | (~b & d); index = i; }
        else if (i < 32) { f = (d & b) | (~d & c); index = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; index = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); index = (7 * i) % 16; }
        const sum = (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) + view.getInt32(offset + index * 4, true)) | 0;
        const shift = shifts[Math.floor(i / 16) * 4 + i % 4];
        [a, b, c, d] = [d, (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0, b, c];
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    return [a0,b0,c0,d0].map((word) => [0,8,16,24].map((n) => ((word >>> n) & 255).toString(16).padStart(2,'0')).join('')).join('');
  }

  function sign(params, imgUrl, subUrl, timestamp = Math.round(Date.now() / 1000)) {
    const fileKey = (url) => new URL(url).pathname.split('/').pop().split('.')[0];
    const key = fileKey(imgUrl) + fileKey(subUrl);
    const order = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
    const mix = order.map((i) => key[i] || '').join('').slice(0,32);
    if (mix.length !== 32) throw new Error('B站签名参数读取失败');
    const values = { ...params, wts: timestamp };
    const query = Object.keys(values).sort().filter((k) => values[k] != null).map((k) =>
      `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g,''))}`).join('&');
    return `${query}&w_rid=${md5(query + mix)}`;
  }
  return { videoRef, canonicalLink, linksFromMessage, normalizeWork, audioSources, md5, sign };
})();
