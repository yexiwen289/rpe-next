// 知识库摄取：任意纯文本 / chart.json / .pez 工程包 / 谱面库项目 → 可检索经验条目。
import { readZip, inspectZip } from '../platform/archive.mjs';
import { decodeLegacy } from '../platform/legacy-text.mjs';
import { parseDocument } from '../core/formats.mjs';
import { isChartDocumentFile } from '../core/chart-backups.mjs';
import { TempoMap } from '../core/tempo.mjs';
import { computeChartMetrics } from '../core/chart-metrics.mjs';
import { analyzeHumanLimits } from '../core/human-limits.mjs';
import { parseKnowledgeDocument, appendKnowledgeEntry } from '../core/agent-knowledge.mjs';

const textDecoder = () => new TextDecoder('utf-8', { fatal: false });

function asText(bytes) {
  const text = textDecoder().decode(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  return text.replace(/^\uFEFF/, '');
}

/** 从谱面对象提炼设计经验，返回可写入知识库的条目。 */
export function analyzeChartExperience(chart, name = '未命名谱面') {
  if (!chart?.BPMList?.length || !Array.isArray(chart.judgeLineList)) throw Error('不是有效的谱面对象');
  const tempo = new TempoMap(chart.BPMList);
  const metrics = computeChartMetrics(chart, tempo);
  const limits = analyzeHumanLimits(chart, tempo);
  const lines = chart.judgeLineList.length;
  const notes = metrics.totalNotes;
  const density = metrics.duration ? (notes / metrics.duration).toFixed(2) : '0';
  const bpm = `${metrics.bpmMin}–${metrics.bpmMax}`;
  const areas = chart.blockAreaList?.length ?? 0;
  const holds = metrics.holdCount;
  const patterns = [];
  if (areas > 0) patterns.push('噪域/红区');
  if (lines > 1) patterns.push('多线');
  if (holds > notes * .15) patterns.push('锁手长条');
  if (metrics.posX?.[1] - metrics.posX?.[0] > 1.6) patterns.push('宽屏位移');
  if (limits.stats?.verticalJudgement?.enabled) patterns.push('垂判');
  const entries = [
    { section: '谱面经验', title: `${name} · 结构`, body: [`来源谱面「${name}」：${lines} 条判定线、${notes} 个音符、时长 ${metrics.duration.toFixed(1)}s、BPM ${bpm}。`, `机制组合：${patterns.length ? patterns.join(' + ') : '常规单线'}。`] },
    { section: '谱面经验', title: `${name} · 密度`, body: [`平均 ${density} 键/秒；峰值 ${limits.stats.peakPerSecond} 键/秒；最小间隔 ${limits.stats.minGapMs}ms。`, `长按 ${holds} 个；同时长条峰值 ${limits.stats.peakHold}。`] },
    { section: '谱面经验', title: `${name} · 可行性`, body: [`人类极限结论：${limits.verdictText}。`, limits.violations.length ? `问题：${limits.violations.map(item => item.message).join('；')}。` : '未发现明显超出双手极限的配置。'] },
  ];
  return { entries, stats: { notes, lines, duration: metrics.duration, verdict: limits.verdict }, source: name };
}

export function entriesToMarkdown(entries) {
  let text = '';
  let currentSection = '';
  for (const entry of entries) {
    if (entry.section !== currentSection) { currentSection = entry.section ?? ''; text += `\n## ${currentSection}\n`; }
    text = appendKnowledgeEntry(text, { section: currentSection, title: entry.title, body: Array.isArray(entry.body) ? entry.body.join('\n') : String(entry.body ?? '') });
  }
  return text.trim() + '\n';
}

/** 任意纯文本文件：Markdown 走原生解析，其他格式走纯文本兜底。 */
export function ingestPlainText(name, bytes) {
  const text = asText(bytes);
  const parsed = parseKnowledgeDocument(text);
  const entries = parsed.entries.length ? parsed.entries : parseKnowledgeDocument(text).entries;
  return { entries: entries.map(entry => ({ section: entry.section || '文本资料', title: entry.title, body: entry.body })), source: name };
}

/** chart.json 或 .pez/.zip 工程包：解包、定位谱面、分析。 */
export async function ingestChartPackage(name, bytes) {
  const data = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let files = new Map();
  if (/\.(pez|zip)$/i.test(name)) {
    const info = inspectZip(data);
    if (info.count > 20000 || info.declaredBytes > 1024 ** 3 || info.largestFile > 512 * 1024 ** 2) throw Error('工程包过大，拒绝解包');
    files = await readZip(data, { maxFiles: 20000, maxBytes: 1024 ** 3, maxFileBytes: 512 * 1024 ** 2 });
  } else files.set(name, new Uint8Array(data));
  const chartFile = [...files].find(([path]) => isChartDocumentFile(path));
  if (!chartFile) throw Error('工程包中未找到谱面文件');
  const chart = parseDocument(decodeLegacy(chartFile[1]));
  const result = analyzeChartExperience(chart, name.replace(/\.(pez|zip|json)$/i, ''));
  return { ...result, packageFiles: files.size, chartFile: chartFile[0] };
}

/** 谱面库项目：直接取 project.chart 分析。 */
export function ingestLibraryProject(project) {
  if (!project?.chart) throw Error('谱面库项目不含谱面');
  return analyzeChartExperience(project.chart, String(project.chartName ?? project.name ?? '谱面库谱面').replace(/\.(pez|json)$/i, ''));
}
