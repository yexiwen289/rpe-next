// 多模型评审团：同一任务并发发给多个模型（各出方案文本，不带工具、不写谱面），
// 再用当前谱面的 diagnose + 近似反例数给方案打分，交由用户决定采纳哪个。

import { diagnose } from '../core/chart.mjs';
import { computeChartMetrics } from '../core/chart-metrics.mjs';
import { TempoMap } from '../core/tempo.mjs';

const SYSTEM = '你是 Phigros 制谱评审。根据给出的谱面摘要和用户要求，提出具体、可执行的谱面优化方案。'
  + '只输出方案文本（分点说明改哪里、怎么改、为什么），不要调用工具、不要输出 JSON、不要写谱面。'
  + '遵守：噪域是区域判定遮挡且绝对不能遮挡判定线；采音只表现最突出声音；密度服从波浪模型。';

const summarize = chart => {
  const metrics = computeChartMetrics(chart, new TempoMap(chart.BPMList));
  return {
    name: chart?.META?.name ?? '',
    bpm: `${metrics.bpmMin}–${metrics.bpmMax}`,
    notes: metrics.totalNotes,
    duration: Math.round(metrics.duration),
    lines: metrics.lineCount,
    typeCounts: metrics.typeCounts,
    issues: diagnose(chart).length,
  };
};

/** 评分：问题少、反例少、建议具体（字数适中）的方案优先。 */
function scoreProposal(text, baselineIssues) {
  const length = text.trim().length;
  const specificity = Math.min(30, (text.match(/\d+/g)?.length ?? 0) * 3);
  const structured = /[1-9]\.|[-•]|\n/.test(text) ? 12 : 0;
  const penalty = length < 80 ? 25 : length > 8000 ? 10 : 0;
  return Math.max(0, 100 - baselineIssues * 2 - penalty + specificity + structured);
}

/**
 * @param {object} opts
 * @param {Array<{id:string,name:string,config:object,provider:object}>} opts.jurors 评审模型
 * @param {object} opts.chart 当前谱面（只读）
 * @param {string} opts.task 用户任务描述
 * @param {AbortSignal} opts.signal
 */
export async function runModelJury({ jurors = [], chart, task, signal } = {}) {
  if (!jurors.length) throw new Error('至少选择一个评审模型');
  if (!chart) throw new Error('请先打开谱面');
  const summary = summarize(chart);
  const user = `谱面摘要：${JSON.stringify(summary)}\n用户要求：${String(task || '优化这张谱面').slice(0, 4000)}`;
  const results = await Promise.allSettled(jurors.map(async juror => {
    const { provider, config } = juror;
    if (typeof provider?.complete !== 'function') throw new Error(`${juror.name}: 模型不支持对话`);
    const reply = await provider.complete({
      config: { ...config, thinking: false, maxTokens: Math.min(4096, config.maxTokens || 2048) },
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
      tools: [],
      signal,
    });
    const text = String(reply?.content ?? '').trim();
    if (!text) throw new Error(`${juror.name}: 未返回方案`);
    return { id: juror.id, name: juror.name, model: config.model, text, score: scoreProposal(text, summary.issues), usage: reply.usage };
  }));
  const proposals = results.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : { id: jurors[index].id, name: jurors[index].name, model: jurors[index].config.model, text: '', error: String(result.reason?.message ?? result.reason), score: 0 });
  proposals.sort((a, b) => b.score - a.score);
  return { task: String(task || ''), summary, proposals, winner: proposals.find(p => !p.error)?.id ?? null };
}
