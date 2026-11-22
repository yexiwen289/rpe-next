'use strict';

// 网易云音乐搜索 / 歌曲信息 / 文件下载 —— 全部在 Electron 主进程用 net.fetch 完成，
// 因为渲染进程的 CSP connect-src / img-src 不允许访问外部域名。
const { net: defaultNet } = require('electron');
const { isIP } = require('node:net');

const CHANNEL = 'rpen-netease';
const TIMEOUT_MS = 30000;
const MAX_DOWNLOAD = 32 * 1024 * 1024;

const MUSIC_HEADERS = {
  Referer: 'https://music.163.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Cookie: 'appver=2.0.2; os=pc; osver=Windows%2010',
  Accept: 'application/json, text/plain, */*',
};
const DOWNLOAD_HEADERS = {
  Referer: 'https://music.163.com',
  'User-Agent': MUSIC_HEADERS['User-Agent'],
};

const httpsify = value => (typeof value === 'string' && value ? value.replace(/^http:\/\//i, 'https://') : null);
const text = (value, max = 300) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
// 网易云对未设头像的歌手 / 无封面专辑统一返回这张图，不能当作真实封面使用。
const DEFAULT_COVER_TOKENS = ['6y-UleORITEDbvrOLV0Q8A==', '5639395138885805.jpg'];
const isDefaultCover = value => typeof value === 'string' &&
  DEFAULT_COVER_TOKENS.some(token => value.includes(token));

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function isPrivateHost(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(value);
  if (version === 4) {
    const parts = value.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (version === 6) {
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHost(mapped[1]);
    return value === '::1' || value === '::' || /^(fc|fd|fe[89ab])/.test(value);
  }
  return false; // 普通域名交给白名单判断
}

function isAllowedNeteaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return false;
  if (host === 'music.163.com') return true;
  return host.endsWith('.126.net') || host.endsWith('.netease.net');
}

// 备用音源（GD 音乐台聚合接口）：仅接受 https、非内网地址；且主进程只放行
// 自己刚从备用接口拿到的 URL（fallbackIssued 缓存），渲染进程无法注入任意地址。
const GD_API = 'https://music-api.gdstudio.xyz/api.php';
// 实测该聚合接口当前仅支持 netease 源（kuwo/migu/tenc 等返回 source 不支持），
// 返回的是站内翻唱/重传版本的 music.126.net 320k 直链，可用于 VIP/版权受限歌曲。
const GD_SOURCES = ['netease'];
const GD_SOURCE_NAMES = { netease: '网易云备用库' };

const normalizeName = value => String(value || '').toLowerCase().replace(/[\s·・:：,，.。()（）\-_'"]/g, '');
const artistOverlap = (a, b) => {
  const setA = String(a || '').toLowerCase().split(/[\/、,，&]|feat\.?/i).map(s => normalizeName(s)).filter(Boolean);
  const setB = String(b || '').toLowerCase().split(/[\/、,，&]|feat\.?/i).map(s => normalizeName(s)).filter(Boolean);
  return setA.some(x => setB.some(y => x === y || x.includes(y) || y.includes(x)));
};

function installNetease({ ipcMain, net, origin, window: getWindow } = {}) {
  const fetchNet = net || defaultNet;
  const permitted = event => {
    const webContents = getWindow?.()?.webContents;
    if (!webContents || webContents.isDestroyed?.()) return false;
    const frame = event.senderFrame;
    return event.sender === webContents &&
      Boolean(frame) && frame === event.sender.mainFrame &&
      typeof frame.url === 'string' && frame.url.startsWith(origin + '/');
  };

  // 保持计时器直到 use(response) 完成（含 body 读取），避免大文件下载挂起。
  async function withFetch(url, options, use) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchNet.fetch(url, { ...options, signal: controller.signal });
      return await use(response);
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(Error('请求超时或已取消'), { timeout: true });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseJson(response, maxBytes) {
    const raw = await response.text();
    if (raw.length > maxBytes) throw Error('响应数据过大');
    try { return JSON.parse(raw); } catch { throw Error('接口返回格式无效'); }
  }

  function normalizeSong(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = Number(raw.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const artists = Array.isArray(raw.artists) ? raw.artists : [];
    const artist = artists.map(entry => text(entry?.name)).filter(Boolean).join(' / ') || text(raw.artist?.name) || '未知歌手';
    const album = raw.album && typeof raw.album === 'object' ? raw.album : {};
    // 搜索接口的 album 通常只有 picId、没有 picUrl；artists[].img1v1Url 是统一默认图，
    // 绝不能当封面 fallback。缺封面时留空，由 fetchCoverUrls() 用 /api/song/detail 批量补全。
    const picUrl = httpsify(album.picUrl);
    const image = picUrl && !isDefaultCover(picUrl) ? picUrl : null;
    const albumId = Number(album.id);
    return {
      id,
      name: text(raw.name) || '未知歌曲',
      artist,
      album: text(album.name),
      albumId: Number.isSafeInteger(albumId) && albumId > 0 ? albumId : null,
      image,
      duration: Number(raw.duration) || 0,
    };
  }

  // 搜索结果只有 picId，真实封面需按歌曲 ID 批量查询 /api/song/detail 补全。
  async function fetchCoverUrls(songs) {
    const pending = songs.filter(song => song && !song.image && Number.isSafeInteger(song.id) && song.id > 0);
    if (!pending.length) return;
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      const ids = encodeURIComponent(JSON.stringify(batch.map(song => song.id)));
      try {
        const json = await withFetch('https://music.163.com/api/song/detail?ids=' + ids,
          { headers: MUSIC_HEADERS }, async response => {
            if (!response.ok) return null;
            return parseJson(response, 4 * 1024 * 1024);
          });
        if (json?.code !== 200 || !Array.isArray(json.songs)) continue;
        const byId = new Map(json.songs.map(detail => [Number(detail?.id), detail]));
        for (const song of batch) {
          const detail = byId.get(song.id);
          const picUrl = httpsify(detail?.album?.picUrl);
          if (picUrl && !isDefaultCover(picUrl)) song.image = picUrl;
        }
      } catch { /* 单批失败不影响其它歌曲与整体搜索 */ }
    }
  }

  async function search(payload) {
    const keyword = text(payload?.keyword, 200);
    if (!keyword) throw Error('搜索关键词无效');
    const limit = clampInt(payload.limit, 1, 100, 30);
    const offset = clampInt(payload.offset, 0, 100000, 0);
    const url = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(keyword) +
      '&type=1&offset=' + offset + '&limit=' + limit + '&csrf_token=';
    const json = await withFetch(url, { headers: MUSIC_HEADERS }, async response => {
      if (!response.ok) throw Error('搜索失败（HTTP ' + response.status + '）');
      return parseJson(response, 4 * 1024 * 1024);
    });
    if (json.code !== 200) throw Error(text(json.msg, 100) || '搜索失败');
    const songs = (Array.isArray(json.result?.songs) ? json.result.songs : []).map(normalizeSong).filter(Boolean);
    await fetchCoverUrls(songs);
    return { ok: true, songs };
  }

  async function getUrl(id) {
    const endpoints = [
      'https://music.163.com/api/song/enhance/player/url?id=' + id + '&ids=%5B' + id + '%5D&br=320000&csrf_token=',
      'https://music.163.com/api/song/enhance/player/url/v1?id=' + id + '&ids=%5B' + id + '%5D&level=excellent&csrf_token=',
    ];
    for (const endpoint of endpoints) {
      try {
        const json = await withFetch(endpoint, { headers: MUSIC_HEADERS }, async response => {
          if (!response.ok) return null;
          return parseJson(response, 2 * 1024 * 1024);
        });
        if (!json || json.code !== 200 || !Array.isArray(json.data)) continue;
        const detail = json.data.find(entry => Number(entry?.id) === id) || json.data[0];
        const url = httpsify(detail?.url);
        if (url && isAllowedNeteaseUrl(url)) return url;
      } catch { /* 尝试下一个端点 */ }
    }
    return null;
  }

  async function song(payload) {
    const id = Number(payload?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw Error('歌曲 ID 无效');
    let url = await getUrl(id);
    let source = 'netease';
    let sourceNote = null;
    if (!url) {
      // 官方接口拿不到播放地址（VIP / 版权限制）→ 备用音源按歌名+歌手匹配。
      const fallback = await fallbackUrl(payload?.name, payload?.artist);
      if (!fallback) throw Error('无法获取播放地址（官方接口受限，备用音源也未找到可下载版本）');
      url = fallback.url;
      source = fallback.source;
      sourceNote = `官方音源受限，已改用备用音源（${GD_SOURCE_NAMES[fallback.source] || fallback.source}）`;
    }
    let image = httpsify(payload?.image);
    if (!image || isDefaultCover(image)) {
      try {
        const json = await withFetch('https://music.163.com/api/song/detail?ids=%5B' + id + '%5D',
          { headers: MUSIC_HEADERS }, async response => {
            if (!response.ok) return null;
            return parseJson(response, 2 * 1024 * 1024);
          });
        const picUrl = httpsify(json?.songs?.[0]?.album?.picUrl);
        if (picUrl && !isDefaultCover(picUrl)) image = picUrl;
      } catch { /* 封面补全失败不影响音频与歌词 */ }
    }
    let lyric = null;
    try {
      const json = await withFetch('https://music.163.com/api/song/lyric?id=' + id + '&lv=1&kv=1&tv=-1', { headers: MUSIC_HEADERS }, async response => {
        if (!response.ok) return null;
        return parseJson(response, 4 * 1024 * 1024);
      });
      if (typeof json?.lrc?.lyric === 'string') lyric = json.lrc.lyric.slice(0, 200000);
    } catch { /* 歌词失败不影响主流程 */ }
    return {
      ok: true,
      id,
      name: text(payload?.name) || '',
      artist: text(payload?.artist) || '',
      album: text(payload?.album) || '',
      image: image || null,
      url,
      source,
      ...(sourceNote ? { sourceNote } : {}),
      ...(lyric ? { lyric } : {}),
    };
  }

  // ---------- 备用音源（GD 音乐台聚合接口） ----------
  const fallbackIssued = new Map(); // url -> issuedAt，download 只放行这里登记过的地址
  const FALLBACK_TTL = 10 * 60 * 1000;

  function rememberFallbackUrl(url) {
    const now = Date.now();
    for (const [key, at] of fallbackIssued) if (now - at > FALLBACK_TTL) fallbackIssued.delete(key);
    while (fallbackIssued.size >= 50) fallbackIssued.delete(fallbackIssued.keys().next().value);
    fallbackIssued.set(url, now);
  }

  function gdUrl(source, params) {
    const query = new URLSearchParams({ source, types: params.types, br: '320' });
    if (params.types === 'search') {
      query.set('name', params.name);
      query.set('count', String(params.count ?? 20));
      query.set('pages', '1');
    } else {
      query.set('id', params.id);
      query.set('br', params.br ?? '320');
    }
    return GD_API + '?' + query.toString();
  }

  async function gdJson(source, params) {
    return withFetch(gdUrl(source, params), {
      headers: { Accept: 'application/json', Referer: 'https://music.gdstudio.xyz', 'User-Agent': MUSIC_HEADERS['User-Agent'] },
    }, async response => {
      if (!response.ok) return null;
      return parseJson(response, 2 * 1024 * 1024);
    });
  }

  async function fallbackUrl(name, artist) {
    const songName = text(name, 120);
    if (!songName) return null;
    const keyword = [songName, text(artist, 120)].filter(Boolean).join(' ');
    const wantName = normalizeName(songName);
    for (const source of GD_SOURCES) {
      try {
        const list = await gdJson(source, { types: 'search', name: keyword, count: 20 });
        if (!Array.isArray(list) || !list.length) continue;
        // 优先歌名一致 + 歌手有交集的条目；其次歌名一致；都没有就跳过该源（避免下错歌）。
        const items = list.map(item => ({
          id: String(item?.id ?? ''),
          name: text(item?.name, 200),
          artist: Array.isArray(item?.artist) ? item.artist.join(' / ') : text(item?.artist, 200),
        })).filter(item => item.id && item.name);
        const matched = items.find(item => normalizeName(item.name) === wantName && artistOverlap(item.artist, artist))
          || items.find(item => normalizeName(item.name) === wantName || normalizeName(item.name).includes(wantName) || wantName.includes(normalizeName(item.name)));
        if (!matched) continue;
        const detail = await gdJson(source, { types: 'url', id: matched.id, br: '320' });
        const rawUrl = httpsify(detail?.url);
        if (!rawUrl) continue;
        let parsed;
        try { parsed = new URL(rawUrl); } catch { continue; }
        if (parsed.protocol !== 'https:' || isPrivateHost(parsed.hostname.toLowerCase())) continue;
        rememberFallbackUrl(rawUrl);
        return { url: rawUrl, source, name: matched.name, artist: matched.artist };
      } catch { /* 该源失败，尝试下一个 */ }
    }
    return null;
  }

  async function download(payload, event) {
    const rawUrl = payload?.url;
    const fallbackIssuedAt = typeof rawUrl === 'string' ? fallbackIssued.get(rawUrl) : undefined;
    // 网易白名单地址直接放行；备用音源地址必须由主进程在 TTL 内签发过。
    if (!isAllowedNeteaseUrl(rawUrl) && fallbackIssuedAt === undefined) {
      throw Error('下载链接无效或不安全');
    }
    if (fallbackIssuedAt !== undefined && Date.now() - fallbackIssuedAt > FALLBACK_TTL) {
      throw Error('备用音源下载链接已过期，请重新点歌');
    }
    const name = text(payload?.name, 200) || 'download';
    const token = typeof payload?.token === 'string' ? payload.token.slice(0, 100) : '';
    const emit = (loaded, total) => {
      if (!token || !event?.sender || event.sender.isDestroyed?.()) return;
      event.sender.send('rpen-netease-progress', { token, loaded, total });
    };
    const result = await withFetch(payload.url, { headers: DOWNLOAD_HEADERS }, async response => {
      const finalUrl = response.url || payload.url;
      // 重定向后仍需安全：网易地址保持白名单；备用地址只要求 https 且非内网。
      if (isAllowedNeteaseUrl(finalUrl || payload.url)) { /* 网易白名单 */ }
      else if (fallbackIssued.has(payload.url) && fallbackIssuedAt !== undefined) {
        let parsed;
        try { parsed = new URL(String(finalUrl || payload.url)); } catch { throw Error('下载链接被重定向到无效地址'); }
        if (parsed.protocol !== 'https:' || isPrivateHost(parsed.hostname.toLowerCase())) throw Error('下载链接被重定向到不安全地址');
      }
      else throw Error('下载链接被重定向到不安全地址');
      if (!response.ok) throw Error('下载失败（HTTP ' + response.status + '）');
      const header = response.headers.get('content-type') || '';
      const mime = text(header.split(';')[0], 100) || 'application/octet-stream';
      if (!response.body?.getReader) throw Error('下载失败：无法读取文件内容');
      const lengthHeader = Number(response.headers.get('content-length'));
      const known = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : 0;
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0, lastReport = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_DOWNLOAD) throw Error('文件过大（超过 32MB）');
          chunks.push(value);
          // 每 64KB 或 120ms 上报一次，避免高频 IPC。
          if (total - lastReport >= 65536 || !lastReport) { lastReport = total; emit(total, known || total); }
        }
      } finally {
        reader.releaseLock();
      }
      emit(total, known || total);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { ok: true, name, mime, bytes: Array.from(bytes) };
    });
    return result;
  }

  const actions = { search, song, download };
  ipcMain.handle(CHANNEL, async (event, payload) => {
    if (!permitted(event)) return { ok: false, error: '非法请求来源' };
    const action = payload?.action;
    if (typeof action !== 'string' || !Object.hasOwn(actions, action)) return { ok: false, error: '未知操作' };
    try {
      return await actions[action](payload, event);
    } catch (error) {
      return { ok: false, error: text(error?.message, 200) || '请求失败' };
    }
  });
}

module.exports = { installNetease };
