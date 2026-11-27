// 主线程代理：把重计算交给 Worker，环境不支持时抛出错误由调用方降级。
let worker = null, nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw Error('Worker 不可用');
  worker = new Worker(new URL('../workers/analysis.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = event => {
    const { id, ok, result, error } = event.data ?? {};
    const resolve = pending.get(id); if (!resolve) return;
    pending.delete(id);
    ok ? resolve(result) : Promise.reject(Error(error));
  };
  worker.onerror = error => { for (const resolve of pending.values()) resolve(Promise.reject(error)); pending.clear(); };
  return worker;
}

function call(type, payload, transfer = []) {
  const instance = ensureWorker(), id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    instance.postMessage({ id, type, payload }, transfer);
  }).catch(error => { pending.delete(id); throw error; });
}

export async function analyzeAudioInWorker(buffer, options) {
  const channels = [], transfer = [];
  for (let index = 0; index < buffer.numberOfChannels; index++) {
    const copy = buffer.getChannelData(index).slice();
    channels.push(copy.buffer); transfer.push(copy.buffer);
  }
  return call('audio', { channels, sampleRate: buffer.sampleRate, length: buffer.length, duration: buffer.duration, options }, transfer);
}

export function refineBpmInWorker(peaks, coarse) {
  const seconds = Float64Array.from(peaks, peak => peak.seconds);
  const strength = Float32Array.from(peaks, peak => peak.strength);
  return call('refine', { seconds, strength, coarse }, [seconds.buffer, strength.buffer]);
}
