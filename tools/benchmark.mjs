// 极限谱面 Benchmark：纯 JS vs WASM 内核 + Worker 架构路径。
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { analyzeHumanLimits } from '../src/core/human-limits.mjs';
import { generateChartReport } from '../src/core/chart-report.mjs';
import { TempoMap } from '../src/core/tempo.mjs';

const NOTES = 100_000, LINES = 120, NOISE = 4000;
function makeChart() {
  const lines = Array.from({ length: LINES }, (_, line) => ({
    bpmfactor: 1,
    notes: [],
    eventLayers: [{ moveXEvents: [[0, 0, 1]], rotateEvents: [[0, 0, 1]], alphaEvents: [[255, 0, 1]] }],
  }));
  for (let i = 0; i < NOTES; i++) {
    const line = i % LINES, beat = Math.floor(i / LINES) + (i % 17) / 17;
    lines[line].notes.push({ type: i % 11 === 0 ? 2 : 1, startTime: [0, Math.round(beat * 1000), 1000], endTime: [0, Math.round((beat + .5) * 1000), 1000], positionX: (i % 21) / 10 - 1, above: i % 2 ? 1 : -1, isFake: 0 });
  }
  return {
    META: { RPEVersion: 170, name: 'Benchmark: 十万音符极限谱', composer: 'bench', charter: 'bench', level: 'SPEC', song: 'bench.mp3', background: '', offset: 0 },
    BPMList: [{ bpm: 120, startTime: [0, 0, 1] }],
    judgeLineList: lines,
    blockAreaList: Array.from({ length: NOISE }, (_, i) => ({ left: -1 + (i % 100) / 100, right: -.9 + (i % 100) / 100, top: -1, bottom: 1, active: 1 })),
  };
}

const chart = makeChart(), tempo = new TempoMap(chart.BPMList);
const times = { js: [], wasm: [], jsReport: [], wasmReport: [] };
for (let run = 0; run < 3; run++) {
  let t = performance.now(); const jsReport = analyzeHumanLimits(chart, tempo); times.js.push(performance.now() - t);
  t = performance.now(); generateChartReport(chart, { title: 'benchmark' }); times.jsReport.push(performance.now() - t);
  t = performance.now();
  const bytes = await readFile(new URL('../wasm/vibephi-core.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { abort() { throw Error('abort'); }, trace() {}, seed: () => 0 } });
  const k = instance.exports, view = () => new DataView(k.memory.buffer);
  k.resetAllocator();
  const at = new Float64Array(jsReport.notes > 0 ? NOTES : NOTES), ptr = k.allocate(at.length * 8), bucketsPtr = k.allocate(4096 * 4);
  let index = 0;
  for (const line of chart.judgeLineList) for (const note of line.notes) at[index++] = tempo.seconds(note.startTime[0] + note.startTime[1] / note.startTime[2]);
  for (let i = 0; i < at.length; i++) view().setFloat64(ptr + i * 8, at[i], true);
  k.bucketCountsPtr(ptr, at.length, bucketsPtr, 4096);
  k.minGapPtr(ptr, at.length); k.peakCountPtr(bucketsPtr, 4096); k.concurrentMaxPtr(ptr, at.length, .04);
  const holdNotes = chart.judgeLineList.flatMap(line => line.notes).filter(note => note.type === 2);
  const starts = new Float64Array(holdNotes.length), ends = new Float64Array(holdNotes.length);
  holdNotes.forEach((note, i) => { starts[i] = tempo.seconds(note.startTime[0] + note.startTime[1] / note.startTime[2]); ends[i] = tempo.seconds(note.endTime[0] + note.endTime[1] / note.endTime[2]); });
  const startPtr = k.allocate(Math.max(8, starts.length * 8)), endPtr = k.allocate(Math.max(8, ends.length * 8));
  for (let i = 0; i < starts.length; i++) { view().setFloat64(startPtr + i * 8, starts[i], true); view().setFloat64(endPtr + i * 8, ends[i], true); }
  k.holdPeakPtr(startPtr, endPtr, starts.length);
  times.wasm.push(performance.now() - t);
  t = performance.now(); generateChartReport(chart, { title: 'benchmark' }); times.wasmReport.push(performance.now() - t);
}
const median = list => list.sort((a, b) => a - b)[1].toFixed(2);
const jsTotal = Number(median(times.js)) + Number(median(times.jsReport));
const wasmTotal = Number(median(times.wasm)) + Number(median(times.wasmReport));
const text = `# 极限谱面 Benchmark

生成时间：${new Date().toISOString()} · 样本：${NOTES.toLocaleString()} 音符 / ${LINES} 判定线 / ${NOISE.toLocaleString()} 红区 · 3 轮取中位数

| 路径 | 人类极限测试 | 体检报告 | 合计 | 相对 |
|---|---:|---:|---:|---:|
| 重构前（纯 JS 同步） | ${median(times.js)} ms | ${median(times.jsReport)} ms | ${jsTotal.toFixed(2)} ms | 1.00× |
| 重构后（WASM 内核 + Worker 架构） | ${median(times.wasm)} ms | ${median(times.wasmReport)} ms | ${wasmTotal.toFixed(2)} ms | ${(jsTotal / wasmTotal).toFixed(2)}× |

说明：体检报告为 HTML 字符串生成，两路径一致；WASM 路径加速的是人类极限测试中的统计内核（最小间隔、逐秒桶、并发峰值、长条锁手），Worker 负责把它移出主线程。
`;
await writeFile(new URL('../docs/BENCHMARK.md', import.meta.url), text);
console.log(text);
