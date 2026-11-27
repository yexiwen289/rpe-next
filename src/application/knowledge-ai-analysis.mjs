// AI 深度解包分析：让 AI 真正「阅读」谱面数据，总结制谱手法并提炼成知识库经验。
//
// 与 knowledge-ingest.mjs 的规则分析互补：规则分析只做统计结论（密度、可行性、
// 机制组合），而这里把谱面切片成 AI 可读的「分析底稿」——全局统计 + 分段音符样本 +
// 判定线事件特征 + 噪域布局——交给模型以谱面分析师的角色理解设计意图，输出结构化
// 经验条目（Markdown 知识库格式）。任何一步失败都会降级回规则分析，保证流程可用。

import { beatValue } from '../core/beat.mjs';
import { TempoMap } from '../core/tempo.mjs';
import { computeChartMetrics } from '../core/chart-metrics.mjs';
import { analyzeHumanLimits } from '../core/human-limits.mjs';
import { analyzeChartExperience, unpackChartPackage } from './knowledge-ingest.mjs';

const NOTE_NAMES = { 1: 'Tap', 2: 'Hold', 3: 'Flick', 4: 'Drag' };
const SEGMENTS = 12;           // 整曲切片段数
const SAMPLES_PER_SEGMENT = 40; // 每段最多抽样多少音符交给模型
const MAX_ENTRIES = 14;        // AI 最多产出多少条经验
const MAX_BODY = 1200;         // 单条正文长度上限（字符）

const round1 = value => Math.round(value * 10) / 10;
const round2 = value => Math.round(value * 100) / 100;
// beatValue 对脏数据会抛错；底稿构建不允许因为单个坏字段中断。
const safeBeat = value => {
  try { return beatValue(value); } catch { return NaN; }
};

export const AI_ANALYST_SYSTEM = [
  '你是 Phigros 谱面分析师。用户会给你一份从谱面工程中提取的「分析底稿」：全局统计、按时间分段的音符样本（秒 | 拍 | 类型 | X坐标 | 判定线 | 层）、判定线运动事件摘要与噪域布局。',
  '你的任务不是复述数字，而是像资深制谱人一样阅读这些数据，总结出制谱者的设计手法与经验规律，供写谱 AI 以后复用。',
  '请关注：结构叙事（段落如何推进）、采音与密度编排（哪里密、哪里留白、为什么）、音符形态（交互/纵连/双押/夹逼/位移接）、判定线运用（平移/旋转/镜像/多线配合）、噪域使用、亮点手法与潜在问题。',
  '输出要求：只输出 JSON，格式 {"entries":[{"section":"谱面经验","title":"…","body":"…"}]}。',
  `section 一般用「谱面经验」或你归纳的主题分类；条目 3~${MAX_ENTRIES} 条；每条 body 用 1~6 行短句写成可执行的规律（例如「副歌段用 1/4 拍交互 + 每 8 拍一次双押强调重拍」），不要出现表格；不要引用具体谱面名以外的原始数据字段。`,
].join('\n');

/** 把谱面切片成 AI 可读的分析底稿（纯文本，数千字符级别）。 */
export function buildChartBrief(chart, name = '未命名谱面') {
  if (!chart?.BPMList?.length || !Array.isArray(chart.judgeLineList)) throw Error('不是有效的谱面对象');
  const tempo = new TempoMap(chart.BPMList);
  const metrics = computeChartMetrics(chart, tempo);
  const limits = analyzeHumanLimits(chart, tempo);
  const meta = chart.META ?? {};
  const parts = [];

  // —— 全局 ——
  parts.push(`# 谱面分析底稿：${name}`);
  parts.push(`曲名 ${meta.song || '未知'}｜BPM ${metrics.bpmMin}–${metrics.bpmMax}｜时长 ${round1(metrics.duration)}s｜判定线 ${metrics.lineCount} 条｜音符 ${metrics.totalNotes}｜长按 ${metrics.holdCount ?? 0}｜噪域 ${chart.blockAreaList?.length ?? 0} 处`);
  parts.push(`类型分布 ${JSON.stringify(metrics.typeCounts ?? {})}；平均密度 ${round2(metrics.totalNotes / Math.max(1, metrics.duration))} 键/秒；峰值密度 ${limits.stats?.peakPerSecond ?? '?'} 键/秒；最小间隔 ${limits.stats?.minGapMs ?? '?'}ms；同时长条峰值 ${limits.stats?.peakHold ?? '?'}`);
  parts.push(`人类极限结论：${limits.verdictText}${limits.violations.length ? `；违规：${limits.violations.map(item => item.message).join('；')}` : ''}`);

  // —— 分段音符样本 ——
  const notes = [];
  chart.judgeLineList.forEach((line, lineIndex) => {
    for (const note of line.notes ?? []) {
      if (Number(note.isFake ?? 0) === 1) continue;
      const beat = safeBeat(note.startTime);
      if (!Number.isFinite(beat)) continue;
      const seconds = tempo.seconds(beat, Number(line.bpmfactor ?? 1) || 1);
      const holdEnd = Number(note.type) === 2 ? safeBeat(note.endTime) : NaN;
      notes.push({ seconds, beat, type: Number(note.type) || 1, x: Number(note.positionX) || 0, line: lineIndex,
        above: Number(note.above ?? 1) === 1 ? '上' : '下', holdEnd: Number.isFinite(holdEnd) ? tempo.seconds(holdEnd, Number(line.bpmfactor ?? 1) || 1) : null });
    }
  });
  notes.sort((a, b) => a.seconds - b.seconds);
  const duration = Math.max(1, metrics.duration);
  const segmentLength = duration / SEGMENTS;
  parts.push(`# 分段音符样本（每段最多 ${SAMPLES_PER_SEGMENT} 个采样，格式：秒|拍|类型|X|线|层）`);
  for (let index = 0; index < SEGMENTS; index++) {
    const from = index * segmentLength, to = from + segmentLength;
    const inside = notes.filter(note => note.seconds >= from && note.seconds < to);
    if (!inside.length) { parts.push(`## 段 ${index + 1}（${round1(from)}–${round1(to)}s）：空段（留白/间奏）`); continue; }
    const step = Math.max(1, Math.ceil(inside.length / SAMPLES_PER_SEGMENT));
    const samples = inside.filter((_, position) => position % step === 0).slice(0, SAMPLES_PER_SEGMENT)
      .map(note => `${round2(note.seconds)}s|${round2(note.beat)}|${NOTE_NAMES[note.type] ?? note.type}${note.holdEnd != null ? `(至${round2(note.holdEnd)}s)` : ''}|${note.x}|L${note.line}|${note.above}`);
    const gaps = [];
    let pairs = 0;
    for (let position = 1; position < inside.length; position++) {
      const delta = inside[position].seconds - inside[position - 1].seconds;
      gaps.push(delta);
      if (delta < 0.016) pairs++;
    }
    parts.push(`## 段 ${index + 1}（${round1(from)}–${round1(to)}s）：${inside.length} 音符（平均 ${round2(inside.length / Math.max(0.01, segmentLength))} 键/秒，最小间隔 ${gaps.length ? round1(Math.min(...gaps) * 1000) : '-'}ms，双押次数约 ${pairs}）\n${samples.join('\n')}`);
  }

  // —— 判定线事件特征 ——
  parts.push('# 判定线运动事件摘要');
  chart.judgeLineList.forEach((line, lineIndex) => {
    const rows = [];
    for (const type of ['moveXEvents', 'moveYEvents', 'rotateEvents']) {
      const events = (line.eventLayers ?? []).flatMap(layer => layer?.[type] ?? []);
      if (!events.length) continue;
      const values = events.flatMap(event => [Number(event.start), Number(event.end)]).filter(Number.isFinite);
      if (!values.length) continue;
      const span = round1(Math.max(...values) - Math.min(...values));
      rows.push(`${type.replace('Events', '')}：${events.length} 关键帧，值域 ${round1(Math.min(...values))}~${round1(Math.max(...values))}（幅度 ${span}）`);
    }
    if (rows.length) parts.push(`L${lineIndex}「${line.Name ?? ''}」：${rows.join('；')}`);
  });

  // —— 噪域 ——
  if (chart.blockAreaList?.length) {
    parts.push('# 噪域布局（起拍–止拍 | 拍值）');
    for (const area of chart.blockAreaList) {
      const appear = safeBeat(area.appearTime ?? area.startTime);
      const disappear = safeBeat(area.disappearTime ?? area.endTime);
      if (!Number.isFinite(appear)) continue;
      parts.push(`${round1(tempo.seconds(appear))}s（拍 ${round1(appear)}）– ${Number.isFinite(disappear) ? `${round1(tempo.seconds(disappear))}s（拍 ${round1(disappear)}）` : '进行中'}`);
    }
  }
  return parts.join('\n\n');
}

/** 从模型输出中容错提取经验条目 JSON。 */
export function parseAiEntries(text) {
  if (typeof text !== 'string' || !text.trim()) throw Error('AI 未返回内容');
  const attempt = raw => {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.entries)) return value.entries;
      if (value && typeof value === 'object' && (value.title || value.body)) return [value];
    } catch { /* 继续尝试下一个候选 */ }
    return null;
  };
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const candidates = [stripped];
  const objectStart = stripped.indexOf('{'), objectEnd = stripped.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) candidates.push(stripped.slice(objectStart, objectEnd + 1));
  const arrayStart = stripped.indexOf('['), arrayEnd = stripped.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) candidates.push(stripped.slice(arrayStart, arrayEnd + 1));
  let list = null;
  for (const candidate of candidates) { list = attempt(candidate); if (list) break; }
  if (!Array.isArray(list) || !list.length) throw Error('AI 输出中没有可用的经验条目');
  const clean = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title ?? '').trim().slice(0, 80);
    const body = String(entry.body ?? '').trim().slice(0, MAX_BODY);
    if (!title || !body) continue;
    clean.push({ section: (String(entry.section ?? '').trim() || '谱面经验').slice(0, 40), title, body });
    if (clean.length >= MAX_ENTRIES) break;
  }
  if (!clean.length) throw Error('AI 输出的条目缺少标题或正文');
  return clean;
}

/**
 * 让 AI 分析谱面并产出经验条目。失败抛错，由调用方降级。
 * @param {object} opts
 * @param {object} opts.chart 已解析谱面对象
 * @param {string} opts.name 谱面名
 * @param {object} opts.provider 支持 complete() 的供应商
 * @param {object} opts.config 模型配置（provider/model/key/maxTokens）
 * @param {AbortSignal} [opts.signal]
 * @param {(message: string) => void} [opts.onProgress]
 */
export async function runAiChartAnalysis({ chart, name, provider, config, signal, onProgress } = {}) {
  if (!chart) throw Error('缺少谱面对象');
  if (typeof provider?.complete !== 'function') throw Error('模型不支持对话');
  onProgress?.('正在构建谱面分析底稿…');
  const full = buildChartBrief(chart, name);
  const brief = full.length > 95000 ? full.slice(0, 95000) : full;
  onProgress?.('AI 正在阅读谱面…');
  const response = await provider.complete({
    config: { ...config, thinking: false, maxTokens: Math.min(8192, config?.maxTokens || 4096) },
    system: AI_ANALYST_SYSTEM,
    messages: [{ role: 'user', content: `${brief}\n\n请以上述数据为依据，输出经验条目 JSON。` }],
    tools: [],
    signal,
  });
  const text = String(response?.content ?? '').trim();
  if (!text) throw Error('AI 未返回分析结果');
  onProgress?.('正在整理经验条目…');
  const entries = parseAiEntries(text);
  // 数据底稿条目（结构/密度/可行性）作为附录保留，保证统计事实不丢失。
  const baseline = analyzeChartExperience(chart, name);
  const stats = { ...baseline.stats, mode: 'ai' };
  return { entries: [...entries, ...baseline.entries.map(entry => ({ ...entry, title: `${entry.title}（数据附录）` }))], stats, source: `${name}（AI 深度分析）`, usage: response.usage };
}

/** AI 可用则深度分析，失败降级规则分析；返回统一 result（mode: ai|rules）。 */
export async function analyzeChartExperienceWithAI(chart, name, ai, { signal, onProgress } = {}) {
  if (ai?.provider && ai?.config?.key?.trim()) {
    try {
      const result = await runAiChartAnalysis({ chart, name, provider: ai.provider, config: ai.config, signal, onProgress });
      return { ...result, mode: 'ai' };
    } catch (error) {
      if (signal?.aborted) throw error;
      onProgress?.(`AI 分析失败（${error?.message ?? error}），降级为规则分析`);
    }
  }
  const fallback = analyzeChartExperience(chart, name);
  return { ...fallback, mode: 'rules' };
}

/** 工程包 AI 版入口：解包 → AI 深度分析（失败降级规则分析）。 */
export async function ingestChartPackageAI(name, bytes, ai, { signal, onProgress } = {}) {
  const { chart, name: clean } = await unpackChartPackage(name, bytes);
  return analyzeChartExperienceWithAI(chart, clean, ai, { signal, onProgress });
}

/** 谱面库 AI 版入口：取项目谱面 → AI 深度分析（失败降级规则分析）。 */
export function ingestLibraryProjectAI(project, ai, { signal, onProgress } = {}) {
  if (!project?.chart) throw Error('谱面库项目不含谱面');
  const name = String(project.chartName ?? project.name ?? '谱面库谱面').replace(/\.(pez|json)$/i, '');
  return analyzeChartExperienceWithAI(project.chart, name, ai, { signal, onProgress });
}
