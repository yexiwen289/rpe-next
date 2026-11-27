// 计算 Worker：音频分析 / BPM 细化 / 谱面统计全部在后台线程执行。
import { analyzeAgentAudio } from '../core/agent-audio.mjs';
import { analyseAudioBuffer } from '../core/audio-analysis-core.mjs';
import { analyzeHumanLimits } from '../core/human-limits.mjs';
import { detectSections } from '../core/section-detect.mjs';
import { generateChartReport } from '../core/chart-report.mjs';
import { TempoMap } from '../core/tempo.mjs';

let kernels = null;
async function wasm() {
  if (kernels) return kernels;
  const url = new URL('../../wasm/vibephi-core.wasm', import.meta.url);
  const bytes = await (await fetch(url)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { abort() { throw Error('WASM abort'); }, trace() {}, seed() { return 0; } },
  });
  kernels = { ...instance.exports, view: () => new DataView(instance.exports.memory.buffer) };
  return kernels;
}

function audioBuffer(channels, sampleRate, length, duration) {
  return {
    sampleRate, numberOfChannels: channels.length, length, duration,
    getChannelData: index => channels[index],
  };
}

async function refine(seconds, strength, coarse) {
  const k = await wasm(), rate = 200, n = seconds.length;
  k.resetAllocator();
  const atPtr = k.allocate(Math.max(8, n * 8)), strengthPtr = k.allocate(Math.max(4, n * 4));
  const end = n ? seconds[n - 1] : 0, length = Math.ceil((end + 1) * rate);
  const trainPtr = k.allocate(length * 4);
  for (let i = 0; i < n; i++) { k.view().setFloat64(atPtr + i * 8, seconds[i], true); k.view().setFloat32(strengthPtr + i * 4, strength[i], true); }
  k.buildImpulseTrainPtr(atPtr, strengthPtr, n, rate, trainPtr);
  let best = coarse, bestScore = -1;
  for (let bpm = coarse * .94; bpm <= coarse * 1.06; bpm += .02) {
    const score = k.autocorrScorePtr(trainPtr, length, 60 / bpm * rate);
    if (score > bestScore) { bestScore = score; best = bpm; }
  }
  return { bpm: best, score: bestScore };
}

self.onmessage = async event => {
  const { id, type, payload } = event.data ?? {};
  try {
    let result;
    if (type === 'audio') {
      const channels = payload.channels.map(array => new Float32Array(array));
      result = await analyzeAgentAudio(audioBuffer(channels, payload.sampleRate, payload.length, payload.duration), payload.options);
    } else if (type === 'wasm-info') {
      result = { wasmBytes: kernels?.memory?.buffer?.byteLength ?? 0 };
    } else if (type === 'stats') {
      const k = await wasm(), at = new Float64Array(payload.at ?? []);
      k.resetAllocator();
      const atPtr = k.allocate(Math.max(8, at.length * 8));
      const size = at.length ? Math.min(4096, Math.ceil(at[at.length - 1]) + 1) : 1;
      const bucketPtr = k.allocate(size * 4);
      for (let i = 0; i < at.length; i++) k.view().setFloat64(atPtr + i * 8, at[i], true);
      for (let i = 0; i < size; i++) k.view().setUint32(bucketPtr + i * 4, 0, true);
      k.bucketCountsPtr(atPtr, at.length, bucketPtr, size);
      const buckets = Array.from({ length: size }, (_, i) => k.view().getUint32(bucketPtr + i * 4, true));
      result = { minGap: k.minGapPtr(atPtr, at.length), buckets, peak: k.peakCountPtr(bucketPtr, size) };
    } else if (type === 'refine') {
      result = await refine(new Float64Array(payload.seconds), new Float32Array(payload.strength), payload.coarse);
    } else if (type === 'waveform') {
      const channels = payload.channels.map(array => new Float32Array(array));
      result = analyseAudioBuffer(audioBuffer(channels, payload.sampleRate, payload.length, payload.duration), payload.options);
    } else if (type === 'limits') {
      result = analyzeHumanLimits(payload.chart, new TempoMap(payload.chart.BPMList));
    } else if (type === 'sections') {
      result = detectSections(new Float64Array(payload.samples), payload.options);
    } else if (type === 'report') {
      result = generateChartReport(payload.chart, payload.options);
    } else throw Error('未知任务类型：' + type);
    const transfer = result?.waveform?.buffer ? [result.waveform.buffer] : [];
    if (result?.spectrum?.buffer) transfer.push(result.spectrum.buffer);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message ?? String(error) });
  }
};
