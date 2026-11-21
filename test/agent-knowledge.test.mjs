import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKnowledgeDocument, searchKnowledge, mergeKnowledgeDocuments, appendKnowledgeEntry, KNOWLEDGE_DOCUMENT_PATH, KNOWLEDGE_LOCAL_PATH, KNOWLEDGE_CATEGORIES } from '../src/core/agent-knowledge.mjs';
import { AgentSourceIndex, isAgentSourcePath } from '../src/core/agent-source.mjs';
import { createAgentSourceBundle } from '../desktop/agent-source.mjs';
import { AgentCommands } from '../src/core/agent-commands.mjs';
import { createAgentEditorCommands } from '../src/application/agent-editor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('制谱知识库文档被源码收集并允许路径访问', async () => {
  const bundle = await createAgentSourceBundle(root);
  assert.ok(bundle.files.some(entry => entry.path === KNOWLEDGE_DOCUMENT_PATH), KNOWLEDGE_DOCUMENT_PATH);
  assert.ok(isAgentSourcePath(KNOWLEDGE_DOCUMENT_PATH));
  const index = new AgentSourceIndex(bundle);
  const text = index.readText(KNOWLEDGE_DOCUMENT_PATH);
  assert.ok(text.length > 5000);
  assert.throws(() => index.readText('chart.json'));
});

test('知识库解析出章节与条目，且保留标题层级与正文', async () => {
  const text = await readFile(join(root, KNOWLEDGE_DOCUMENT_PATH), 'utf8');
  const document = parseKnowledgeDocument(text);
  assert.ok(document.sections.length >= 13, '章节数');
  assert.ok(document.entries.length >= 160, '条目数');
  const title = document.entries.map(entry => entry.title);
  assert.ok(title.some(item => item.includes('纵连')));
  assert.ok(title.some(item => item.includes('采音分层')), title.filter(item => item.includes('采音')).join('/'));
  assert.ok(document.sections.some(item => item.title.includes('AI 制谱决策清单')));
  for (const entry of document.entries) assert.ok(entry.section, entry.title);
});

test('知识库检索命中相关条目，空查询返回目录', async () => {
  const text = await readFile(join(root, KNOWLEDGE_DOCUMENT_PATH), 'utf8');
  const document = parseKnowledgeDocument(text);

  const jack = searchKnowledge(document, '纵连');
  assert.ok(jack.total > 0);
  assert.ok(jack.entries.some(entry => entry.title.includes('纵连')), jack.entries.map(entry => entry.title).join('/'));
  assert.ok(jack.entries.some(entry => entry.content.includes('物理逻辑') || entry.content.includes('单手')));

  const noise = searchKnowledge(document, '噪域');
  assert.ok(noise.entries.some(entry => entry.title.includes('噪域')));

  const layering = searchKnowledge(document, '采音分层');
  assert.ok(layering.entries.some(entry => entry.title.includes('采音分层')));

  const slang = searchKnowledge(document, '读谱不能');
  assert.ok(slang.entries.some(entry => entry.title.includes('黑话') || entry.title.includes('术语') || entry.title.includes('评价')), slang.entries.map(entry => entry.title).join('/'));
  assert.ok(slang.entries.some(entry => entry.content.includes('读谱不能')), '正文含目标术语');

  const checklist = searchKnowledge(document, '物量');
  assert.ok(checklist.total > 0);

  for (const [query, expect] of [['主导层', '主导层'], ['舍音', '舍音'], ['可读性预算', '可读性预算'], ['伪音符', '伪音符'], ['打击感', '打击感']]) {
    const result = searchKnowledge(document, query, 5);
    assert.ok(result.entries.some(entry => entry.title.includes(expect)), query + ' -> ' + result.entries.map(entry => entry.title).join('/'));
  }

  // N1-N12 检测项应拆为独立条目，编号与名称都能命中
  const codes = document.entries.filter(entry => entry.code).map(entry => entry.code);
  for (const code of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12']) assert.ok(codes.includes(code), code);
  const byCode = searchKnowledge(document, 'N3', 3);
  assert.ok(byCode.entries[0].title.startsWith('N3'), byCode.entries[0].title);
  assert.ok(byCode.entries[0].title.includes('大位移无缓冲'), byCode.entries[0].title);
  const byLabel = searchKnowledge(document, '中央区域过载', 3);
  assert.ok(byLabel.entries.some(entry => entry.title.includes('中央区域过载')), byLabel.entries.map(entry => entry.title).join('/'));
  const anti = searchKnowledge(document, '反例', 5);
  assert.ok(anti.total > 0);
  const exemplar = searchKnowledge(document, '混沌入口', 5);
  assert.ok(exemplar.entries.some(entry => entry.title.includes('混沌入口')), exemplar.entries.map(entry => entry.title).join('/'));

  const empty = searchKnowledge(document, '');
  assert.equal(empty.query, '');
  assert.ok(empty.sections.length >= 8);
  assert.ok(empty.sections[0].entries.length > 0);
});

test('知识库分类索引覆盖全部主题域', () => {
  assert.ok(KNOWLEDGE_CATEGORIES.length >= 12);
  const ids = KNOWLEDGE_CATEGORIES.map(category => category.id);
  for (const id of ['basics', 'patterns', 'visuals', 'structure', 'philosophy', 'engineering', 'difficulty', 'community', 'readability', 'exemplars', 'antipatterns', 'checklist']) assert.ok(ids.includes(id), id);
  for (const category of KNOWLEDGE_CATEGORIES) {
    assert.ok(category.name, category.id);
    assert.ok(category.topics.length > 0, category.id);
  }
});

test('chart_knowledge 作为只读命令注册并按中文概念词返回知识条目', async () => {
  const bundle = await createAgentSourceBundle(root);
  const commands = new AgentCommands();
  const source = { query: async () => ({}), readText: path => {
    const entry = bundle.files.find(item => item.path === path);
    if (!entry) throw Error('索引缺失');
    return entry.text;
  } };
  createAgentEditorCommands(commands, {}, { source });
  const tool = commands.tools().find(item => item.function.name === 'chart_knowledge');
  assert.ok(tool, '工具已注册');
  assert.equal(tool.function.description.includes('知识库'), true, '描述说明用途');
  assert.equal(tool.function.parameters.properties.query.maxLength, 200);

  for (const permission of ['ask', 'dangerous', 'full']) {
    const result = await commands.execute('chart_knowledge', { query: '采音分层' }, { permission, approve: () => assert.fail('知识库查询不应审批') });
    assert.ok(result.result.total > 0);
    assert.ok(result.result.entries.some(entry => entry.title.includes('采音分层')), result.result.entries.map(entry => entry.title).join('/'));
    assert.ok(result.result.categories.length >= 12);
  }

  const directory = await commands.execute('chart_knowledge', {}, { permission: 'full' });
  assert.ok(directory.result.sections.length >= 12);
  assert.ok(directory.result.sections[0].entries.length > 0);
});

test('增量知识库可写入并与基线合并检索，增量优先', async () => {
  const text = await readFile(join(root, KNOWLEDGE_DOCUMENT_PATH), 'utf8');
  const base = parseKnowledgeDocument(text);
  let local = appendKnowledgeEntry('', { title: '玩家反馈：尾杀打飞', body: '密度收束型尾杀常导致最后一下精度下降。', section: '实战补充' });
  local = appendKnowledgeEntry(local, { title: 'RPEVersion 150 的旋转行为', body: 'RPEVersion < 163 时子线不继承父线旋转。', section: '实战补充' });
  const localDocument = parseKnowledgeDocument(local);
  assert.equal(localDocument.entries.length, 2);

  const merged = mergeKnowledgeDocuments([
    { ...base, source: KNOWLEDGE_DOCUMENT_PATH },
    { ...localDocument, source: KNOWLEDGE_LOCAL_PATH },
  ]);
  assert.equal(merged.entries.length, base.entries.length + 2, '基线条目不丢失');
  assert.equal(merged.sources.length, 2);
  const hit = searchKnowledge(merged, '尾杀打飞', 5);
  assert.ok(hit.entries.some(entry => entry.title.includes('尾杀打飞')), '增量条目可检索');
  const version = searchKnowledge(merged, 'RPEVersion', 5);
  assert.ok(version.entries.some(entry => entry.title.includes('RPEVersion 150')), '增量条目可检索');
});

test('chart_knowledge_write 双端写入增量并经 chart_knowledge 合并可见', async () => {
  const bundle = await createAgentSourceBundle(root);
  const commands = new AgentCommands();
  const source = { query: async () => ({}), readText: path => {
    const entry = bundle.files.find(item => item.path === path);
    if (!entry) throw Error('索引缺失');
    return entry.text;
  } };
  const files = new Map();
  const workspace = { call: async (action, args) => {
    if (action === 'stat') return files.has(args.path) ? { kind: 'file', bytes: files.get(args.path).length, hash: 'h' } : null;
    if (action === 'read') { const text = files.get(args.path); if (text === undefined) throw Error('not found'); return { text }; }
    if (action === 'write') { files.set(args.path, args.text); return { kind: 'file', bytes: args.text.length, hash: 'h' }; }
    throw Error('unsupported ' + action);
  } };
  createAgentEditorCommands(commands, {}, { source, workspace });

  const writeTool = commands.tools().find(item => item.function.name === 'chart_knowledge_write');
  assert.ok(writeTool, '写入工具已注册');
  assert.ok(writeTool.function.description.includes('knowledge.local.md'), '描述说明双端落盘');

  for (const permission of ['ask', 'dangerous', 'full']) {
    const result = await commands.execute('chart_knowledge_write', { title: '尾杀打飞', body: '密度收束型尾杀常导致最后一下精度下降。', section: '实战补充' }, { permission, approve: () => ({}) });
    assert.equal(result.result.path, KNOWLEDGE_LOCAL_PATH);
    assert.ok(files.has(KNOWLEDGE_LOCAL_PATH), '增量已写入工作区');
  }

  const read = await commands.execute('chart_knowledge', { query: '尾杀打飞' }, { permission: 'full' });
  assert.ok(read.result.entries.some(entry => entry.title.includes('尾杀打飞')), 'read 合并本地增量后可见');

  // 第二次追加不应覆盖第一次
  await commands.execute('chart_knowledge_write', { title: 'RPEVersion 150 的旋转行为', body: 'RPEVersion < 163 时子线不继承父线旋转。', section: '实战补充' }, { permission: 'full', approve: () => ({}) });
  const again = await commands.execute('chart_knowledge', { query: 'RPEVersion' }, { permission: 'full' });
  assert.ok(again.result.entries.some(entry => entry.title.includes('RPEVersion 150')), '多次追加均保留');
});

test('chart_knowledge_write 在无工作区时明确报错', async () => {
  const bundle = await createAgentSourceBundle(root);
  const commands = new AgentCommands();
  const source = { query: async () => ({}), readText: path => bundle.files.find(item => item.path === path)?.text ?? (() => { throw Error('索引缺失'); })() };
  createAgentEditorCommands(commands, {}, { source });
  await assert.rejects(() => commands.execute('chart_knowledge_write', { title: 'x', body: 'y' }, { permission: 'full', approve: () => ({}) }), /知识库/);
});

test('agent_tools 用自然语言查询也能发现知识库读写命令', async () => {
  const bundle = await createAgentSourceBundle(root);
  const commands = new AgentCommands();
  const source = { query: async () => ({}), readText: path => {
    const entry = bundle.files.find(item => item.path === path);
    if (!entry) throw Error('索引缺失');
    return entry.text;
  } };
  createAgentEditorCommands(commands, {}, { source });

  const result = await commands.execute('agent_tools', { query: 'knowledge base memory store', limit: 20 }, { permission: 'full' });
  const names = result.result.commands.map(item => item.name);
  assert.ok(names.includes('chart_knowledge'), '读命令被发现: ' + names.join(','));
  assert.ok(names.includes('chart_knowledge_write'), '写命令被发现: ' + names.join(','));

  // 中文关键词也应命中
  const zh = await commands.execute('agent_tools', { query: '知识库 读写', limit: 20 }, { permission: 'full' });
  const zhNames = zh.result.commands.map(item => item.name);
  assert.ok(zhNames.includes('chart_knowledge'));
  assert.ok(zhNames.includes('chart_knowledge_write'));

  // 分词匹配：单个关键词即可命中
  const kw = await commands.execute('agent_tools', { query: 'memory', limit: 20 }, { permission: 'full' });
  assert.ok(kw.result.commands.map(item => item.name).includes('chart_knowledge'));
});

test('增量条目与基线同名时覆盖而非重复', async () => {
  const text = await readFile(join(root, KNOWLEDGE_DOCUMENT_PATH), 'utf8');
  const base = parseKnowledgeDocument(text);
  const override = appendKnowledgeEntry('', { title: '段落类型', body: '覆盖后的正文。', section: '四、谱面结构与情绪流' });
  const merged = mergeKnowledgeDocuments([
    { ...base, source: KNOWLEDGE_DOCUMENT_PATH },
    { ...parseKnowledgeDocument(override), source: KNOWLEDGE_LOCAL_PATH },
  ]);
  assert.equal(merged.entries.length, base.entries.length, '同名不新增条目');
  const target = merged.entries.find(entry => entry.title === '段落类型');
  assert.ok(target.body.includes('覆盖后的正文'), '内容被增量覆盖');
});
