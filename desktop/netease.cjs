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
    const url = await getUrl(id);
    if (!url) throw Error('无法获取播放地址（可能为版权或 VIP 限制）');
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
      ...(lyric ? { lyric } : {}),
    };
  }

  async function download(payload) {
    if (!isAllowedNeteaseUrl(payload?.url)) throw Error('下载链接无效或不安全');
    const name = text(payload?.name, 200) || 'download';
    const result = await withFetch(payload.url, { headers: DOWNLOAD_HEADERS }, async response => {
      if (!isAllowedNeteaseUrl(response.url || payload.url)) throw Error('下载链接被重定向到不安全地址');
      if (!response.ok) throw Error('下载失败（HTTP ' + response.status + '）');
      const header = response.headers.get('content-type') || '';
      const mime = text(header.split(';')[0], 100) || 'application/octet-stream';
      if (!response.body?.getReader) throw Error('下载失败：无法读取文件内容');
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_DOWNLOAD) throw Error('文件过大（超过 32MB）');
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
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
      return await actions[action](payload);
    } catch (error) {
      return { ok: false, error: text(error?.message, 200) || '请求失败' };
    }
  });
}

module.exports = { installNetease };
