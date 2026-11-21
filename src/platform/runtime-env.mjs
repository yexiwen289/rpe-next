// 运行时环境变量读取。密钥类配置只从本地 .env / 进程环境注入，源码中不留明文。
// 桌面端：preload 暴露 window.rpenRuntimeEnv（由主进程从 process.env 读取）。
// 网页端：dev server 在 index.html 注入 <meta name="rpe-env" data-key="...">。
// 两者都没有时返回空串，用户可在设置界面自行填写。

const CACHE = new Map();

function fromMeta(name) {
  if (typeof document === 'undefined') return undefined;
  const meta = document.querySelector(`meta[name="rpe-env"][data-key="${name}"]`);
  return meta?.getAttribute('content') ?? undefined;
}

export function runtimeEnv(name) {
  if (CACHE.has(name)) return CACHE.get(name);
  let value;
  try { value = globalThis.rpenRuntimeEnv?.[name]; } catch { /* 忽略 */ }
  if (typeof value !== 'string') value = fromMeta(name);
  const result = typeof value === 'string' ? value : '';
  CACHE.set(name, result);
  return result;
}
