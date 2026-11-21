// 网易云音乐搜索面板。仅负责 DOM 与交互，所有网络请求委托给 platform/netease.mjs。
// 说明：不 import i18n，中文文案硬编码；样式类名统一 netease-* 前缀，CSS 由外部提供。
import { neteaseCall, neteaseAvailable } from '../platform/netease.mjs';

const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
  '<rect width="48" height="48" fill="#2b2b33"/>' +
  '<text x="24" y="33" font-size="26" text-anchor="middle" fill="#8a8a94">♪</text></svg>'
);

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function safeFileName(value, fallback, extension) {
  const base = String(value || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 120) || fallback;
  return base + extension;
}

export function mountNeteaseSearch({ host, onPick } = {}) {
  const container = typeof host === 'string' ? document.querySelector(host) : host;
  if (!container || typeof container.appendChild !== 'function') throw new Error('netease-search：缺少挂载容器');

  let disposed = false;
  let searchSeq = 0;
  let picking = false;
  const coverCache = new Map(); // image url -> Promise<{bytes, objectUrl} | null>

  const root = make('div', 'netease-search');
  const bar = make('div', 'netease-search-bar');
  const input = make('input', 'netease-search-input');
  input.type = 'search';
  input.placeholder = '搜索网易云音乐…';
  const button = make('button', 'netease-search-button', '搜索');
  button.type = 'button';
  bar.append(input, button);
  const status = make('div', 'netease-status', neteaseAvailable() ? '' : '网页端不支持，请用桌面端');
  const results = make('div', 'netease-results');
  root.append(bar, status, results);
  container.appendChild(root);

  const setStatus = message => { if (!disposed) status.textContent = message || ''; };
  const setBusy = busy => { if (!disposed) button.disabled = busy; };

  function loadCover(url) {
    if (!url || typeof url !== 'string') return Promise.resolve(null);
    if (!coverCache.has(url)) {
      coverCache.set(url, (async () => {
        const data = await neteaseCall('download', { url, name: 'cover.jpg' });
        if (!data.bytes?.byteLength) return null;
        const mime = typeof data.mime === 'string' && data.mime.startsWith('image/') ? data.mime : 'image/jpeg';
        const blob = new Blob([data.bytes], { type: mime });
        return { bytes: data.bytes, objectUrl: URL.createObjectURL(blob) };
      })().catch(() => null));
    }
    return coverCache.get(url);
  }

  async function doSearch() {
    const keyword = input.value.trim();
    if (!keyword) { setStatus('请输入搜索关键词'); return; }
    const seq = ++searchSeq;
    setBusy(true);
    results.replaceChildren();
    setStatus('搜索中…');
    try {
      const { songs } = await neteaseCall('search', { keyword, limit: 20, offset: 0 });
      if (disposed || seq !== searchSeq) return;
      const list = Array.isArray(songs) ? songs : [];
      for (const item of list) results.appendChild(renderItem(item));
      setStatus(list.length ? `找到 ${list.length} 首歌曲` : '未找到相关歌曲');
    } catch (error) {
      if (disposed || seq !== searchSeq) return;
      setStatus('搜索失败：' + (error?.message || '未知错误'));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  function renderItem(song) {
    const item = make('div', 'netease-item');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;

    const cover = make('img', 'netease-item-cover');
    cover.alt = '';
    cover.src = PLACEHOLDER;
    item.appendChild(cover);
    if (song.image) {
      // 列表缩略图用网易云 ?param=100y100（约 8KB），点歌时才下载原图作封面。
      const thumb = song.image + (song.image.includes('?') ? '&' : '?') + 'param=100y100';
      loadCover(thumb).then(entry => {
        if (!disposed && entry && cover.isConnected) cover.src = entry.objectUrl;
      });
    }

    const info = make('div', 'netease-item-info');
    info.appendChild(make('div', 'netease-item-name', song.name || '未知歌曲'));
    const meta = make('div', 'netease-item-meta');
    meta.appendChild(make('span', 'netease-item-artist', song.artist || '未知歌手'));
    if (song.album) meta.appendChild(make('span', 'netease-item-album', song.album));
    meta.appendChild(make('span', 'netease-item-duration', formatDuration(song.duration)));
    info.appendChild(meta);
    item.appendChild(info);

    const choose = () => { if (!picking) pickSong(song); };
    item.addEventListener('click', choose);
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
    });
    return item;
  }

  async function pickSong(song) {
    picking = true;
    setBusy(true);
    setStatus('正在获取歌曲信息…');
    try {
      const info = await neteaseCall('song', song);
      if (disposed) return;
      setStatus('正在下载音频…');
      const songName = info.name || song.name || 'song';
      const artist = info.artist || song.artist || '';
      const audioName = safeFileName(artist ? `${artist} - ${songName}` : songName, 'song', '.mp3');
      const audio = await neteaseCall('download', { url: info.url, name: audioName });
      if (disposed) return;

      let coverBytes = null;
      let coverName = 'cover.jpg';
      if (song.image) {
        const entry = await loadCover(song.image);
        if (!disposed) {
          coverBytes = entry?.bytes ?? null;
          coverName = safeFileName(
            song.albumId ? `${song.albumId}-cover` : `${song.id}-cover`,
            'cover', '.jpg'
          );
        }
      }
      if (disposed) return;

      onPick?.({
        song: { ...song, ...info },
        audioBytes: audio.bytes,
        coverBytes,
        coverName,
        audioName: audio.name || audioName,
      });
      setStatus(`已选择：${songName}`);
    } catch (error) {
      setStatus('下载失败：' + (error?.message || '未知错误'));
    } finally {
      picking = false;
      if (!disposed) setBusy(false);
    }
  }

  button.addEventListener('click', doSearch);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); doSearch(); } });

  return function dispose() {
    if (disposed) return;
    disposed = true;
    searchSeq++;
    for (const promise of coverCache.values()) {
      promise.then(entry => { if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl); }).catch(() => {});
    }
    coverCache.clear();
    root.remove();
  };
}
