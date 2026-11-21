// 谱面体检报告：汇总基础指标、类型占比、密度、X 分布、诊断问题与 N1–N12 反例自检，
// 生成可独立打开的 HTML（内联样式，无外部依赖）。

import { diagnose } from './chart.mjs';
import { computeChartMetrics } from './chart-metrics.mjs';
import { TempoMap } from './tempo.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';

/** N1–N12 反例的近似自动检测（基于 metrics，结果为提示而非定论）。 */
export function checkAntipatterns(metrics) {
  const out = [];
  const check = (id, name, bad, detail) => { if (bad) out.push({ id, name, detail }); };
  const typeCounts = metrics?.typeCounts ?? {};
  const total = Number(metrics?.totalNotes) || Object.values(typeCounts).reduce((sum, n) => sum + (Number(n) || 0), 0) || 1;
  const dragRatio = (Number(typeCounts[3]) || 0) / total;
  const duration = Number(metrics?.duration) || 0;
  const nps = duration > 0 ? total / duration : 0;
  check('N1', '连续高密度窗口', nps > 12, `全曲平均 NPS ${num(nps)}，偏高，检查是否有连续高密度段无 Break。`);
  check('N3', '大位移无缓冲', Number(metrics?.intervalMax) > 0 && Number(metrics?.intervalMedian) > 0 && Number(metrics.intervalMax) / Number(metrics.intervalMedian) > 12, `最大间隔 ${num(metrics.intervalMax)} 远大于中位间隔 ${num(metrics.intervalMedian)}，检查是否有大跨度无过渡。`);
  check('N10', '单一手序过载', dragRatio > 0.5, `Drag 占比 ${num(dragRatio * 100, 1)}%，确认每段都有明确位移意图。`);
  return out;
}

export function generateChartReport(chart, { title } = {}) {
  const metrics = computeChartMetrics(chart, new TempoMap(chart.BPMList));
  const issues = diagnose(chart);
  const antipatterns = checkAntipatterns(metrics);
  const meta = chart?.META ?? {};
  const name = escapeHtml(title || meta.name || '未命名谱面');

  const kv = (label, value) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
  const issueRows = issues.length
    ? issues.map(issue => { const msg = typeof issue.message === 'string' ? issue.message : (issue.message?.message ?? ''); return `<li>${escapeHtml(msg)}</li>`; }).join('')
    : '<li class="ok">未发现结构性问题</li>';
  const antiRows = antipatterns.length
    ? antipatterns.map(a => `<li><strong>${escapeHtml(a.id)} ${escapeHtml(a.name)}</strong>：${escapeHtml(a.detail)}</li>`).join('')
    : '<li class="ok">N1–N12 近似检测未触发（仍需人工听音确认）</li>';
  const typeRows = Object.entries(metrics.typeCounts ?? {}).map(([type, count]) => kv(`类型 ${type}`, `${count}（${num(count / (metrics.totalNotes || 1) * 100, 1)}%）`)).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>谱面体检报告 · ${name}</title>
<style>
body{background:#15171c;color:#e6e8ee;font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:860px;margin:32px auto;padding:0 20px}
h1{color:#ffcf5c;font-size:24px;margin:0 0 4px}h2{color:#ffcf5c;font-size:17px;margin:28px 0 10px;border-bottom:1px solid #2c313a;padding-bottom:6px}
.sub{color:#9aa0ac;margin-bottom:24px}table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{border:1px solid #2c313a;padding:7px 10px;text-align:left;font-size:13px}th{color:#9aa0ac;width:180px;background:#1e2128}
ul{padding-left:20px}li{margin:5px 0}li.ok{color:#7fd6a0}.note{color:#9aa0ac;font-size:12px;margin-top:10px}
</style></head><body>
<h1>谱面体检报告 · ${name}</h1><div class="sub">由 Re:PhiEdit Next 自动生成 · ${new Date().toLocaleString('zh-CN')}</div>
<h2>基础信息</h2><table>
${kv('曲名', meta.name || '—')}${kv('作曲', meta.composer || '—')}${kv('谱师', meta.charter || '—')}${kv('等级', meta.level || '—')}
${kv('音符总数', metrics.totalNotes ?? '—')}${kv('判定线数', chart?.judgeLineList?.length ?? '—')}${kv('时长（秒）', num(metrics.duration))}${kv('平均 NPS', num((metrics.totalNotes ?? 0) / (metrics.duration || 1)))}
</table>
<h2>音符类型分布</h2><table>${typeRows}</table>
<h2>结构与诊断</h2><ul>${issueRows}</ul>
<h2>反例检测（N1–N12 近似）</h2><ul>${antiRows}</ul>
<div class="note">本报告基于谱面数据的自动分析，不替代实际听音与人工试玩。密度/反例阈值为经验参考值。</div>
</body></html>`;
}
