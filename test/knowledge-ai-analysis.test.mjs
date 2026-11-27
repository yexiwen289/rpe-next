// AI 深度解包分析测试：底稿构建 / 输出解析 / AI 分析与规则降级 / 工程包与谱面库入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, createEvent, createLine } from '../src/core/chart.mjs';
import { buildChartBrief, parseAiEntries, runAiChartAnalysis, analyzeChartExperienceWithAI, ingestChartPackageAI, ingestLibraryProjectAI, AI_ANALYST_SYSTEM } from '../src/application/knowledge-ai-analysis.mjs';
import { createNoiseArea, createNoiseEvent } from '../src/core/noise-areas.mjs';

/** 构造一张带多线、位移事件、噪域的样例谱面。 */
function sampleChart() {
  const chart = createChart();
  chart.META.song = '测试曲';
  const lineA = chart.judgeLineList[0];
  lineA.Name = '主导线';
  for (let index = 0; index < 32; index++) lineA.notes.push(createNote(index % 4 === 0 ? 2 : 1, index * 0.5, index % 2 ? 0.2 : -0.2, index * 0.5 + 1));
  const lineB = createLine('位移线');
  lineB.eventLayers[0].moveXEvents.push({ ...createEvent(-0.6, 0.6, 0, 64), easingType: 1 });
  for (let index = 0; index < 16; index++) lineB.notes.push(createNote(4, index + 2, 0.5));
  chart.judgeLineList.push(lineB);
  const area = createNoiseArea(8, 16);
  area.events?.push?.(createNoiseEvent(0, 0, 8, 16));
  chart.blockAreaList.push(area);
  return chart;
}

const mockProvider = reply => {
  const provider = { name: 'mock', complete: async ({ messages, system }) => {
    if (!messages?.length) throw Error('无消息');
    provider.lastSystem = system; provider.lastPrompt = messages[0].content;
    const value = typeof reply === 'function' ? await reply() : reply;
    return { content: value };
  } };
  return provider;
};
const aiBundle = reply => ({ provider: mockProvider(reply), config: { provider: 'mock', model: 'mock-1', key: 'test-key', maxTokens: 4096 } });
const aiReply = JSON.stringify({ entries: [
  { section: '谱面经验', title: '交互与双押交替', body: '主歌段用 0.5 拍间隔的交互推进，每 4 拍插入一次双押强调重拍。' },
  { section: '谱面经验', title: '位移线采样', body: '副线以宽幅 moveX 平移配合 Drag 流，制造跟随感。' },
] });

test('分析底稿包含全局统计、分段样本、事件摘要与噪域', () => {
  const brief = buildChartBrief(sampleChart(), '样例谱');
  assert.ok(brief.includes('谱面分析底稿：样例谱'));
  assert.ok(brief.includes('人类极限结论'));
  assert.ok(brief.includes('段 1（'), '包含分段');
  assert.ok(brief.includes('|Tap') || brief.includes('|Hold'), '包含音符样本');
  assert.ok(brief.includes('moveX'), '包含位移事件摘要');
  assert.ok(brief.includes('噪域布局'), '包含噪域布局');
  assert.ok(brief.length < 100000, '底稿规模可控');
});

test('AI 输出解析：容忍围栏、前后杂文与数组形式，过滤缺字段条目', () => {
  const fenced = '```json\n' + aiReply + '\n```';
  assert.equal(parseAiEntries(fenced).length, 2);
  assert.equal(parseAiEntries('以下是分析结果：\n' + aiReply + '\n完毕').length, 2);
  assert.equal(parseAiEntries(JSON.stringify([{ title: '只有标题', body: '正文', section: '谱面经验' }, { title: '' }, { body: '无标题' }])).length, 1);
  assert.equal(parseAiEntries(JSON.stringify([{ section: '谱面经验', title: '数组形式', body: '正文' }])).length, 1);
  assert.throws(() => parseAiEntries('不是 JSON'), /条目/);
  assert.throws(() => parseAiEntries('{"entries":[]}'), /条目/);
});

test('AI 分析成功：条目含 AI 结论与数据附录，统计带 mode=ai', async () => {
  const ai = aiBundle(aiReply);
  const result = await runAiChartAnalysis({ chart: sampleChart(), name: '样例谱', provider: ai.provider, config: ai.config });
  assert.ok(result.entries.some(entry => entry.title === '交互与双押交替'));
  assert.ok(result.entries.some(entry => entry.title.includes('数据附录')), '保留统计底稿条目');
  assert.equal(result.stats.mode, 'ai');
  assert.ok(result.source.includes('AI 深度分析'));
  assert.ok(ai.provider.lastSystem.includes('谱面分析师'), '系统提示词为分析师角色');
  assert.ok(ai.provider.lastPrompt.includes('分段音符样本'), '提示词携带底稿');
});

test('AI 不可用或失败时降级规则分析', async () => {
  const noAi = await analyzeChartExperienceWithAI(sampleChart(), '样例谱', null);
  assert.equal(noAi.mode, 'rules');
  assert.ok(noAi.entries.length >= 3);
  const failing = await analyzeChartExperienceWithAI(sampleChart(), '样例谱', { provider: mockProvider(async () => { throw Error('网络错误'); }), config: { provider: 'mock', key: 'k', model: 'm' } });
  assert.equal(failing.mode, 'rules');
  const badJson = await analyzeChartExperienceWithAI(sampleChart(), '样例谱', aiBundle('完全不是 JSON'));
  assert.equal(badJson.mode, 'rules');
});

test('工程包 AI 入口：chart.json 字节流 → AI 深度分析', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(sampleChart()));
  const result = await ingestChartPackageAI('样例谱.json', bytes, aiBundle(aiReply));
  assert.equal(result.mode, 'ai');
  assert.ok(result.entries.length > 2);
});

test('谱面库 AI 入口：项目对象 → AI 深度分析；无 AI 时降级', async () => {
  const result = await ingestLibraryProjectAI({ chart: sampleChart(), chartName: '库谱面.pez' }, aiBundle(aiReply));
  assert.equal(result.mode, 'ai');
  assert.ok(result.source.includes('库谱面'));
  const fallback = await ingestLibraryProjectAI({ chart: sampleChart() }, null);
  assert.equal(fallback.mode, 'rules');
});

test('系统提示词要求只输出 JSON 且限制条目规模', () => {
  assert.ok(AI_ANALYST_SYSTEM.includes('{"entries"'));
  assert.ok(AI_ANALYST_SYSTEM.includes('不要复述') || AI_ANALYST_SYSTEM.includes('不是复述'));
});
