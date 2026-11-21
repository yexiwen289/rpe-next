// Shared AI chart-workflow logic, used by both the visualization panel and the
// dedicated "AI 工具" (AI tools) panel so the two stay in sync.
import { t } from '../i18n.mjs';
import { diagnose } from '../core/chart.mjs';
import { computeChartMetrics, formatMetricsForPrompt } from '../core/chart-metrics.mjs';

function safeDiagnose(chart) {
  try {
    const list = diagnose(chart);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const issue of list) { const severity = issue.severity || 'warning'; counts[severity] = (counts[severity] || 0) + 1; }
    return { ...counts, items: list };
  } catch {
    return { error: 0, warning: 0, info: 0, items: [] };
  }
}

// Compute the flat prompt-ready metrics bundle shared by the agent tool and the UI.
export function computeWorkflowMetrics(chart, tempo) {
  const m = computeChartMetrics(chart, tempo);
  return { ...formatMetricsForPrompt(m, { t }), issues: safeDiagnose(chart) };
}

// Lightweight, offline "AI preview": heuristic bullets from the metrics.
export function generateObservations(m) {
  const out = [];
  const nps = m.duration ? m.totalNotes / m.duration : 0;
  out.push(t('viz.obs.density', { p0: nps.toFixed(2) }) + (nps > 6 ? t('viz.obs.dense') : nps < 1.5 ? t('viz.obs.sparse') : ''));
  if (m.intervalMax) out.push(t('viz.obs.gap', { p0: m.intervalMax.toFixed(2), p1: m.intervalMedian.toFixed(2) }));
  const offbeat = m.offsetBins ? m.offsetBins.reduce((s, v, i) => i !== 0 && i !== 4 ? s + v : s, 0) : 0;
  if (m.totalNotes && offbeat / m.totalNotes > 0.25) out.push(t('viz.obs.sync', { p0: Math.round(offbeat / m.totalNotes * 100) }));
  if (m.alphaTransparent) out.push(t('viz.obs.hidden', { p0: m.alphaTransparent }));
  if (m.fake) out.push(t('viz.obs.fake', { p0: m.fake }));
  if (m.below) out.push(t('viz.obs.below', { p0: m.below }));
  const holdRatio = m.totalNotes ? m.holdCount / m.totalNotes : 0;
  if (holdRatio > 0.3) out.push(t('viz.obs.hold', { p0: Math.round(holdRatio * 100) }));
  if (m.posYCount) out.push(t('viz.obs.posy', { p0: m.posYCount }));
  if (m.colored) out.push(t('viz.obs.colored', { p0: m.colored }));
  const issues = m.issues || { error: 0, warning: 0 };
  if (issues.error || issues.warning) out.push(t('viz.obs.diag', { p0: issues.error, p1: issues.warning }));
  return out;
}

export function buildAgentPrompt(m) {
  const L = [];
  L.push(t('viz.ai.role'));
  L.push('');
  L.push('## ' + t('viz.ai.overview'));
  L.push(`- ${t('viz.summary', { p0: m.totalNotes, p1: m.lineCount, p2: m.duration.toFixed(1), p3: m.bpmMin, p4: m.bpmMax })}`);
  L.push(`- ${t('viz.noteType')}：Tap ${m.typeCounts[1] || 0} / Hold ${m.typeCounts[2] || 0} / Flick ${m.typeCounts[3] || 0} / Drag ${m.typeCounts[4] || 0}`);
  L.push(`- ${t('viz.aboveBelow')}：${t('viz.above')} ${m.above} / ${t('viz.below')} ${m.below}；${t('viz.fake')} ${m.fake}；${t('viz.colored')} ${m.colored}`);
  L.push(`- ${t('viz.speedDist')}（${t('viz.xValue')}→数量）：${m.speedDist || t('viz.none')}`);
  L.push(`- ${t('viz.sizeDist')}：${m.sizeDist || t('viz.none')}`);
  L.push(`- ${t('viz.alphaDist')}（alpha<255 ${t('viz.obs.hidden2')}）：${m.alphaTransparent}`);
  L.push(`- ${t('viz.position')}：[${m.posX[0].toFixed(1)}, ${m.posX[1].toFixed(1)}]；${t('viz.positionY')} ${m.posYCount}`);
  L.push(`- ${t('viz.holdLength')}：${t('viz.notes')} ${m.holdCount}，${t('viz.xDuration')} avg ${m.holdAvg.toFixed(2)}s`);
  if (m.intervalMax) L.push(`- ${t('viz.interval')}（${t('viz.xInterval')}）：max ${m.intervalMax.toFixed(2)}s，median ${m.intervalMedian.toFixed(2)}s，count ${m.intervalCount}`);
  L.push(`- ${t('viz.offsetBeat')}（8 bin，index 0=正拍）：${JSON.stringify(m.offsetBins)}`);
  L.push(`- ${t('viz.perLine')}：${JSON.stringify(m.perLineNotes)}`);
  L.push(`- ${t('viz.perLineEvents')}：${JSON.stringify(m.perLineEvents)}`);
  L.push(`- ${t('viz.groupDist')}：${m.groupText}`);
  L.push(`- ${t('viz.fatherDist')}：${m.fatherText}`);
  L.push(`- ${t('viz.events')}：${m.eventCountsText}`);
  L.push(`- ${t('viz.eventRange')}：${m.eventRangeText}`);
  const d = m.issues || { error: 0, warning: 0, info: 0 };
  L.push(`- ${t('viz.ai.diag')}：error ${d.error} / warning ${d.warning} / info ${d.info}`);
  L.push('');
  L.push('## ' + t('viz.ai.understand'));
  L.push(t('viz.ai.understandBody'));
  L.push('');
  L.push('## ' + t('viz.ai.analyzeTask'));
  L.push(t('viz.ai.followup'));
  return L.join('\n');
}

// Drive the agent with a precomputed metrics bundle for a read-only analysis.
// The agent opens its own panel and streams the result; this never mutates the
// chart by itself. Chart edits belong to「轻量 AI 修改」and the multi-agent team.
export async function runAgentChartWorkflow({ agent, metrics, statusEl } = {}) {
  if (!agent || !agent.dialogues || typeof agent.dialogues.send !== 'function') {
    if (statusEl) statusEl.textContent = t('viz.aiNoAgent');
    return;
  }
  const set = text => { if (statusEl) statusEl.textContent = text; };
  try {
    set(t('viz.aiStage1'));
    const prompt = buildAgentPrompt(metrics);
    set(t('viz.aiStage2'));
    agent.open();
    await agent.dialogues.send(prompt, '');
    set(t('viz.aiStage3'));
  } catch (error) {
    set(t('viz.aiError', { p0: error?.message || String(error) }));
  }
}
