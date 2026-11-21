import { t } from '../i18n.mjs';

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
// 标题里的编号前缀（如 "2.1 基础排列"）在检索时属于噪声，剥离后更易命中。
const NUMBER_PREFIX = /^[（(]?\d+(?:[.．]\d+)*[)）]?\s*[、.．:：]?\s*/;

// 知识库条目的主题标签：AI 用自然语言检索时，命中这些词即视为相关。
const TOPIC_ALIASES = Object.freeze({
  纵连: ['jack', 'stream', 'trill', '连打'],
  交互: ['interaction', '交替', '底鼓', '军鼓'],
  双押: ['chord', '押'],
  拆谱: ['splitting', '分轨', '轨道'],
  轴交互: ['axis', '旋转', '垂直'],
  倒打: ['reverse', '逆向', '翻转'],
  噪域: ['noise', '禁地'],
  缓动: ['easing', '贝塞尔', 'bezier'],
  快慢刀: ['speed', 'rubber', '流速', '变速'],
  多线: ['multi', '副线', '表演线', '镜像'],
  采音: ['分层', 'sampling', '重音', '音符选择'],
  物量: ['note', '密度', 'nps', '音符量'],
  密度: ['nps', '波浪', 'curve'],
  定数: ['level', '难度', '评级'],
  手序: ['hand', '拇指', '手指', '冲突'],
  休息段: ['break', '副歌', 'chorus', '前奏', '尾杀', 'outro'],
  初见杀: ['surprise', '陷阱', '欺诈'],
  物量欺诈: ['drag', '填充'],
  视觉垃圾: ['上隐', '表演线', '遮挡'],
  判定线: ['judge', '坐标', 'movex', 'movey', 'rotate'],
  噪域实现: ['负值', 'alpha', '透明'],
  hold: ['长条', '长按', '尾'],
  tap: ['蓝键', '点击'],
  drag: ['黄键', '滑动'],
  flick: ['红键', '快滑'],
  玩家反馈: ['粪谱', '读谱不能', '茶包', '赛豹', '脑裂', '手癖', '上隐', '刁民'],
  主导层: ['采音哲学', '舍音', '最突出', '堆叠式', '音采满'],
  舍音: ['舍弃', '放弃', '第一层', '第二层', '视觉暗示', '假音符'],
  可控域: ['控制什么', '不可控', '资源包', 'click.ogg', '打击音效'],
  打击感: ['反馈', '确认感', '黄键海', '手序引导', '预期管理'],
  伪音符: ['isfake', '假音符', '视觉密度', '操作密度', '虚假期待'],
  可读性: ['可读性预算', '认知带宽', '视觉信息源', '视觉预告', '表演边界'],
  着色器: ['shader', 'extra.json', '色差', '故障', '模糊'],
  间隔变化: ['手感曲线', '密度变化', '空拍', '压迫感'],
  视觉信息: ['注意力', '视线', '锚点', '主视野'],
  范本: ['混沌入口', 'message', 'desultory', '逐段拆解', 'cb'],
  反例: ['负面样本', '反例', '堆料', '卡手', '卡死', '过载', '误导'],
  检测项: ['自检', '检测', 'n1', 'n2', '阈值', '触发警告', '修改方向'],
  密度窗口: ['nps窗口', '16拍窗口', '高原形', '呼吸段', '物量控制'],
  中央过载: ['拇指', '搅在一起', 'x坐标分布', '两侧展开'],
  引导: ['起手', '预告', '引导音符', '指向', '视觉引导'],
});

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 合并多份知识库文档：基线在前，增量在后。
 * 同名条目以增量覆盖基线（增量是后来学到的，应优先）。
 * 返回 { sections, entries, sources }。
 */
export function mergeKnowledgeDocuments(documents) {
  const sections = [], entries = [], sources = [];
  // 基线内部不做去重：不同父级下可能有同名子条目（如「关键机制细节」），
  // 只在增量与已有条目冲突时按 key 覆盖（增量是后来学到的，优先）。
  const index = new Map();
  const keyOf = entry => entry.code ? `code:${entry.code}`
    : `${entry.section ?? ''}::${entry.parent ?? ''}::${entry.title}`;
  for (const document of documents ?? []) {
    if (!document) continue;
    sources.push(document.source ?? '');
    for (const entry of document.entries ?? []) {
      const key = keyOf(entry);
      const existing = index.get(key);
      if (existing !== undefined) { entries[existing] = { ...entries[existing], ...entry }; continue; }
      index.set(key, entries.length);
      entries.push(entry);
    }
    for (const section of document.sections ?? []) {
      if (!sections.some(item => item.title === section.title)) sections.push(section);
    }
  }
  return { sections, entries, sources };
}

/**
 * 把知识库 Markdown 解析成可检索条目。
 * 一级/二级标题为「章节」；三级标题为「条目」；条目内以行首粗体小节名
 * （形如 "**纵连的工程细节**："）开头的内容拆为独立子条目，父级指向该条目。
 */
export function parseKnowledgeDocument(text) {
  if (typeof text !== 'string' || !text.trim()) return { sections: [], entries: [] };
  const lines = text.split(/\r\n?|\n/);
  const sections = [], entries = [];
  let section = null, entry = null, parent = null;
  const closeEntry = () => { if (entry) { entry.body = entry.body.join('\n').trim(); entries.push(entry); entry = null; } };
  const closeSection = () => { if (section) { section.body = section.body.join('\n').trim(); sections.push(section); section = null; } };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; if (entry) entry.body.push(line); else if (section) section.body.push(line); continue; }
    if (inFence) { if (entry) entry.body.push(line); else if (section) section.body.push(line); continue; }
    const match = HEADING.exec(line);
    if (match) {
      const level = match[1].length, raw = match[2].trim();
      const title = raw.replace(NUMBER_PREFIX, '').trim() || raw;
      if (level <= 2) { closeEntry(); closeSection(); parent = null; section = { level, title: raw, body: [] }; continue; }
      if (level === 3) { closeEntry(); if (!section) section = { level: 2, title: '', body: [] }; parent = title; entry = { section: section.title, title, level, body: [] }; continue; }
      closeEntry();
      if (!section) section = { level: 2, title: '', body: [] };
      entry = { section: section.title, title, level, parent, body: [] };
      continue;
    }
    // 编号表格行（如 | N1 | 连续高密度窗口 | 阈值 | ...）-> 拆为独立检测项条目
    const row = /^\|\s*([A-Z]{1,3}\d{1,2})\s*\|\s*([^|]{2,40}?)\s*\|/.exec(line);
    if (row && entry) {
      const code = row[1], label = row[2].trim();
      const owner = entry;
      closeEntry();
      entry = { section: owner.section, title: `${code} ${label}`, level: owner.level >= 4 ? owner.level : 4, parent: owner.title, body: [line], code };
      continue;
    }
    // 行首粗体小节名 -> 拆为独立子条目
    const sub = /^\*\*([^*\n]{2,28})\*\*(?:[（(][^）)\n]{0,24}[）)])?[：:]?/.exec(line);
    if (sub && entry) {
      const subTitle = sub[1].trim();
      if (subTitle) {
        const owner = entry;
        closeEntry();
        entry = { section: owner.section, title: subTitle, level: owner.level >= 4 ? owner.level : 4, parent: owner.title, body: [line] };
        continue;
      }
    }
    if (entry) entry.body.push(line); else if (section) section.body.push(line);
  }
  closeEntry(); closeSection();
  return { sections: sections.filter(item => item.title), entries };
}

const entryHaystack = entry => `${entry.title} ${entry.section} ${entry.body}`.toLowerCase();

/**
 * 检索知识库条目。
 * query 为空时返回全部条目概览（目录），便于 AI 自行选择。
 */
export function searchKnowledge(document, query, limit = 10) {
  const { sections, entries } = document ?? {};
  if (!Array.isArray(entries)) return { query: query ?? '', total: 0, entries: [], sections: [] };
  const text = (query ?? '').trim().toLowerCase();
  if (!text) {
    return {
      query: '',
      total: entries.length,
      sections: sections.filter(section => entries.some(entry => entry.section === section.title)).map(section => ({ title: section.title, entries: entries.filter(entry => entry.section === section.title).map(entry => entry.title) })),
      entries: entries.slice(0, limit).map(entry => ({ section: entry.section, title: entry.title })),
    };
  }
  const terms = new Set();
  for (const [topic, aliases] of Object.entries(TOPIC_ALIASES)) {
    if (text.includes(topic.toLowerCase()) || aliases.some(alias => text.includes(alias))) { terms.add(topic.toLowerCase()); for (const alias of aliases) terms.add(alias.toLowerCase()); }
  }
  for (const token of text.split(/[\s,，。、；;:/]+/)) if (token.length >= 2) terms.add(token);
  const scored = [];
  // 章节本身也是可检索条目（如「AI 制谱决策清单」），其正文含全部子条目。
  const candidates = [...entries, ...(sections ?? []).filter(item => item.title).map(item => ({ section: '', title: item.title, level: item.level, body: item.body }))];
  for (const entry of candidates) {
    const haystack = entryHaystack(entry);
    const title = entry.title.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!term) continue;
      if (title.includes(term)) score += 10;
      else if (entry.code && entry.code.toLowerCase() === term) score += 12;
      else if (haystack.includes(term)) score += 3;
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((left, right) => right.score - left.score || left.entry.title.length - right.entry.title.length);
  return {
    query,
    total: scored.length,
    entries: scored.slice(0, limit).map(({ entry, score }) => ({ section: entry.section, title: entry.title, score, content: entry.body })),
  };
}

export const KNOWLEDGE_DOCUMENT_PATH = 'protocols/CHART-DESIGN-KNOWLEDGE.zh-CN.md';
// AI 自主维护的增量知识库：存在谱面工作区，随谱面走，不污染应用安装目录。
export const KNOWLEDGE_LOCAL_PATH = 'knowledge.local.md';

/**
 * 向增量知识库追加一条条目，返回新的文档文本。
 * 保持解析器可识别：章节用 "## "，条目用 "### "。
 */
export function appendKnowledgeEntry(text, entry) {
  const title = String(entry?.title ?? '').trim();
  const body = String(entry?.body ?? '').trim();
  if (!title || !body) throw Error('知识条目需要 title 与 body');
  const section = String(entry?.section ?? '').trim() || '本地补充';
  const lines = (text ?? '').split(/\r\n?|\n/);
  // 找到目标章节；不存在则在文档末尾新建
  let index = lines.findIndex(line => line.startsWith('## ') && line.slice(3).trim() === section);
  const block = ['', '### ' + title, '', body, ''];
  if (index < 0) {
    return [...lines, '', '## ' + section, '', ...block].join('\n').replace(/\n+$/, '') + '\n';
  }
  let end = lines.length;
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    if (lines[cursor].startsWith('## ')) { end = cursor; break; }
  }
  return [...lines.slice(0, end), ...block, ...lines.slice(end)].join('\n').replace(/\n+$/, '') + '\n';
}

export const KNOWLEDGE_CATEGORIES = Object.freeze([
  { id: 'basics', name: t('agent-knowledge.s4b1e0c7'), topics: ['判定线坐标', '四种音符', '判定区间与手感'] },
  { id: 'patterns', name: t('agent-knowledge.s8c2f1a4'), topics: ['纵连', '交互', '双押', '阶梯', '拆谱', '轴交互', '倒打', '瀑布', '噪域'] },
  { id: 'visuals', name: t('agent-knowledge.s2d3b8e1'), topics: ['缓动曲线', '快慢刀', '多线与镜像', 'Controls 音符级表演'] },
  { id: 'structure', name: t('agent-knowledge.s6e4f9a3'), topics: ['段落类型', 'NPS 与密度曲线', '采音分层', '打击感的数据层面设计'] },
  { id: 'philosophy', name: t('agent-knowledge.s2e6a3d4'), topics: ['堆叠式写谱法的局限', '主导层原则', '舍音四级层级', '采音一致性', '可控域与不可控域'] },
  { id: 'engineering', name: t('agent-knowledge.s1a7d5c8'), topics: ['事件连续性', '手指物理与手序', '数据对齐与流速', '事件层结构'] },
  { id: 'difficulty', name: t('agent-knowledge.s9f3b2d6'), topics: ['难度五要素', '定数与游玩预期', '心理陷阱与伦理边界'] },
  { id: 'community', name: t('agent-knowledge.s3c5e7b9'), topics: ['谱面质量黑话', '玩家操作状态', '通用术语'] },
  { id: 'readability', name: t('agent-knowledge.s5b8d1f6'), topics: ['可读性预算概念', '预算分配三原则', '着色器代价', '快慢刀边界', '多线可读性管理'] },
  { id: 'exemplars', name: t('agent-knowledge.s4c7a2e9'), topics: ['混沌入口轴交互', '卡手耦合失败', 'Message 噪域演出', 'Desultory Signals 底力管理', '正面范本三规则'] },
  { id: 'antipatterns', name: t('agent-knowledge.s8d3b6f1'), topics: ['堆料型反例', '排键型反例', '采音型反例', '机制型反例', '定数型反例', 'N1-N12 检测清单'] },
  { id: 'checklist', name: t('agent-knowledge.s7d2a4e8'), topics: ['AI 制谱决策清单', '工程参数速查'] },
]);
