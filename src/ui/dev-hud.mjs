// 极小开发者 HUD：Ctrl+Shift+D 呼出。只读指标，不改变编辑器行为。
import { workerQueueSize, workerStats } from '../platform/analysis-worker.mjs';

export function initDevHud() {
  if (globalThis.__vibephiDevHud) return globalThis.__vibephiDevHud;
  const root = document.createElement('div'); root.className = 'dev-hud'; root.hidden = true;
  root.innerHTML = '<b>ENGINE</b><span data-fps>-- FPS</span><span data-wasm>-- KB WASM</span><span data-queue>-- QUEUE</span>';
  document.body.append(root);
  let visible = false, frames = 0, last = performance.now(), wasmBytes = 0;
  const tick = () => {
    frames++; const now = performance.now();
    if (now - last >= 500) {
      const fps = frames * 1000 / (now - last); frames = 0; last = now;
      if (visible) {
        root.querySelector('[data-fps]').textContent = `${fps.toFixed(0)} FPS`;
        root.querySelector('[data-wasm]').textContent = `${(wasmBytes / 1024).toFixed(0)} KB WASM`;
        root.querySelector('[data-queue]').textContent = `${workerQueueSize()} QUEUE`;
      }
      workerStats().then(stats => { wasmBytes = stats?.wasmBytes ?? wasmBytes; }).catch(() => {});
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.addEventListener('keydown', event => {
    if (!event.ctrlKey || !event.shiftKey || event.code !== 'KeyD') return;
    event.preventDefault(); visible = !visible; root.hidden = !visible;
  }, true);
  globalThis.__vibephiDevHud = root;
  return root;
}
