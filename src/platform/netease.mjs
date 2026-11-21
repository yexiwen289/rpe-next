// 网易云音乐桥接层：桌面端走 preload 注入的 window.rpenNetease.call；
// 网页端受 CSP 限制，不做网络降级，直接给出明确提示。
const WEB_UNSUPPORTED = '网页端不支持，请用桌面端';

export function neteaseAvailable() {
  return typeof globalThis.rpenNetease?.call === 'function';
}

export async function neteaseCall(action, payload = {}, { onProgress } = {}) {
  if (!neteaseAvailable()) throw new Error(WEB_UNSUPPORTED);
  let dispose;
  if (typeof onProgress === 'function' && typeof globalThis.rpenNetease.onProgress === 'function') {
    const token = crypto.randomUUID();
    dispose = globalThis.rpenNetease.onProgress(value => { if (value?.token === token) onProgress(value); });
    payload = { ...payload, token };
  }
  let response;
  try {
    response = await globalThis.rpenNetease.call(action, payload);
  } finally {
    dispose?.();
  }
  if (!response || response.ok !== true) {
    throw new Error(response?.error || `网易云音乐请求失败（${action}）`);
  }
  const result = { ...response };
  delete result.ok;
  // IPC 结构化克隆后 bytes 为 number[]，还原成 Uint8Array 供 Blob / 文件写入使用。
  if (Array.isArray(result.bytes)) result.bytes = Uint8Array.from(result.bytes);
  return result;
}
