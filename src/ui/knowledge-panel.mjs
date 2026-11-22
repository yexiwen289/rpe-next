import { AgentSourceReader } from '../platform/agent-source.mjs';
import { renderAgentMarkdown } from './agent-markdown.mjs';

// 本地增量知识库：与 agent-editor / chart_knowledge_write 使用同一个路径。
const LOCAL_PATH = 'knowledge.local.md';
const CORE_BASELINE = 'protocols/CHART-DESIGN-KNOWLEDGE.zh-CN.md';

// bundle 里实际包含 6 份协议（见 AGENT_SOURCE_DOCUMENTS），AUDIO-SEPARATION 是第 7 份。
// 这里保留完整的 7 份清单；不在 bundle 中的文档会被标记为「不可用（只读）」。
const PRESET_DOCUMENTS = Object.freeze([
  { path: CORE_BASELINE, name: '制谱设计知识库（核心）' },
  { path: 'protocols/AI-AGENT-PROTOCOL.zh-CN.md', name: 'AI 代理协作协议' },
  { path: 'protocols/AUDIO-SEPARATION.zh-CN.md', name: '音频分离协议' },
  { path: 'protocols/CHART-VERSION-CONTROL.zh-CN.md', name: '谱面版本控制协议' },
  { path: 'protocols/EDITOR-SKIN-PROTOCOL.zh-CN.md', name: '编辑器皮肤协议' },
  { path: 'protocols/GLOBAL-EVENTS-PROTOCOL.zh-CN.md', name: '全局事件协议' },
  { path: 'protocols/MOD-PROTOCOL.zh-CN.md', name: 'MOD 协议' },
]);

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const displayName = path => String(path).split('/').pop().replace(/\.md$/i, '')
  .replace(/-zh-CN$/i, '').replace(/-PROTOCOL$/i, ' 协议').replace(/-/g, ' ');

// 基线协议不可直接改写：保存到工作区的同名本地副本。
const overridePath = path => path.startsWith('protocols/') && path.endsWith('.md')
  ? path.slice(0, -3) + '.local.md' : null;

/**
 * 在已渲染的 Markdown DOM 中高亮搜索词（纯文本匹配，不改动源码）。
 */
function highlightMatches(root, term) {
  if (!term) return 0;
  const needle = term.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.nodeValue && node.nodeValue.toLowerCase().includes(needle)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  let count = 0;
  for (const node of targets) {
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let from = 0, index;
    while ((index = text.toLowerCase().indexOf(needle, from)) !== -1) {
      if (index > from) fragment.append(document.createTextNode(text.slice(from, index)));
      const mark = element('mark', 'kb-hit', text.slice(index, index + term.length));
      fragment.append(mark);
      from = index + term.length;
      count++;
    }
    if (from < text.length) fragment.append(document.createTextNode(text.slice(from)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return count;
}

/**
 * 挂载知识库查看/编辑面板。
 * @param {object} options
 * @param {HTMLElement} options.host 面板容器
 * @param {import('../platform/agent-workspace.mjs').AgentWorkspace} [options.workspace] 工作区实例（桌面写磁盘 / 网页写 IndexedDB）
 * @param {(message: string, level?: 'success'|'warning'|'error') => void} [options.notify] 提示函数
 * @returns {{ element: HTMLElement, destroy(): void, refresh(): Promise<void>, setVisible(visible: boolean): void }}
 */
export function mountKnowledgePanel({ host, workspace, notify } = {}) {
  if (!host || typeof host.append !== 'function') throw Error('知识库面板需要一个 DOM 容器（host）');
  const canWrite = Boolean(workspace && typeof workspace.call === 'function');
  const say = (message, level = 'info') => {
    if (typeof notify !== 'function') return;
    try { notify(message, level); } catch { /* 提示失败不应影响面板 */ }
  };

  // ---------- DOM 骨架 ----------
  const root = element('div', 'kb-panel');
  const sidebar = element('div', 'kb-sidebar');
  sidebar.append(element('div', 'kb-sidebar-title', '知识库文档'));
  const list = element('div', 'kb-list');
  const sidebarHint = element('p', 'kb-hint',
    canWrite ? '基线协议来自内置知识资源，只读；修改会写入工作区本地副本。' : '工作区不可用：仅可查看基线文档，保存已禁用。');
  sidebar.append(list, sidebarHint);

  const main = element('div', 'kb-main');
  const toolbar = element('div', 'kb-toolbar');
  const search = element('input', 'kb-search');
  search.type = 'search';
  search.placeholder = '在当前文档中搜索（逐行匹配）';
  const searchCount = element('span', 'kb-search-count');
  const tabPreview = element('button', 'kb-tab', '预览');
  const tabEdit = element('button', 'kb-tab', '编辑');
  const reload = element('button', 'kb-reload', '重新加载');
  const save = element('button', 'kb-save', '保存');
  const saveNote = element('span', 'kb-save-note');
  const close = element('button', 'kb-close', '关闭');
  for (const button of [tabPreview, tabEdit, reload, save, close]) button.type = 'button';
  save.disabled = !canWrite;
  toolbar.append(search, searchCount, tabPreview, tabEdit, reload, save, saveNote, close);

  const notice = element('div', 'kb-notice');
  const preview = element('div', 'kb-preview');
  const editor = element('textarea', 'kb-editor');
  editor.spellcheck = false;
  const hits = element('div', 'kb-hits');
  main.append(toolbar, notice, preview, editor, hits);
  root.append(sidebar, main);
  host.append(root);

  // ---------- 状态 ----------
  let destroyed = false, loadToken = 0, saving = false;
  let sourceIndex = null, sourceError = '';
  let docs = [], selectedPath = null, savedText = null, currentText = '', mode = 'preview';

  const currentDoc = () => docs.find(item => item.path === selectedPath) ?? null;

  function setNotice(message, level = 'info') {
    notice.textContent = message || '';
    notice.className = 'kb-notice' + (message ? ` kb-notice-${level}` : '');
  }

  function updateSaveState() {
    const dirty = currentText !== savedText;
    const doc = currentDoc();
    save.disabled = !canWrite || saving || !doc;
    save.classList.toggle('kb-dirty', dirty);
    if (!canWrite) saveNote.textContent = '工作区不可用：无法保存';
    else if (!doc) saveNote.textContent = '';
    else if (doc.kind === 'local') saveNote.textContent = '直接写入本地增量知识库' + (dirty ? '（有未保存修改）' : '');
    else saveNote.textContent = '保存到本地副本，不改动原始协议文件' + (dirty ? '（有未保存修改）' : '');
  }

  function renderDocList() {
    list.replaceChildren();
    for (const doc of docs) {
      const item = element('div', 'kb-item');
      item.dataset.path = doc.path;
      item.tabIndex = 0;
      const badge = doc.kind === 'local' ? '本地'
        : !doc.available ? '不可用'
          : doc.hasOverride ? '本地副本' : '基线';
      item.append(element('span', 'kb-item-name', doc.name), element('span', 'kb-item-badge', badge));
      if (doc.path === selectedPath) item.classList.add('active');
      if (!doc.available) item.classList.add('kb-item-unavailable');
      item.addEventListener('click', () => { void selectDoc(doc.path); });
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void selectDoc(doc.path); }
      });
      list.append(item);
    }
  }

  function renderPreview() {
    preview.replaceChildren();
    if (!currentText) { preview.textContent = '（空文档）'; return; }
    renderAgentMarkdown(preview, currentText);
    highlightMatches(preview, search.value.trim());
  }

  function updateHits() {
    hits.replaceChildren();
    const term = search.value.trim();
    if (!term) { searchCount.textContent = ''; return; }
    const needle = term.toLowerCase();
    let total = 0;
    currentText.split(/\r\n?|\n/).forEach((line, index) => {
      if (!line.toLowerCase().includes(needle)) return;
      total++;
      if (total > 60) return;
      const row = element('div', 'kb-hit-line');
      row.append(element('span', 'kb-hit-line-no', String(index + 1)), element('span', 'kb-hit-line-text', line.slice(0, 240)));
      hits.append(row);
    });
    searchCount.textContent = `命中 ${total} 行`;
  }

  function setMode(next) {
    mode = next;
    const editing = next === 'edit';
    preview.hidden = editing;
    preview.style.display = editing ? 'none' : '';
    editor.hidden = !editing;
    editor.style.display = editing ? '' : 'none';
    tabPreview.classList.toggle('active', !editing);
    tabEdit.classList.toggle('active', editing);
    if (editing) { editor.value = currentText; editor.focus(); }
    else { currentText = editor.value; renderPreview(); updateHits(); }
    updateSaveState();
  }

  // ---------- 读取 ----------
  async function loadSource() {
    sourceIndex = null;
    sourceError = '';
    try { sourceIndex = await new AgentSourceReader().load(); }
    catch (error) { sourceError = error?.message ?? String(error); }
  }

  function buildDocuments() {
    const paths = new Set(Array.isArray(sourceIndex?.paths) ? sourceIndex.paths : []);
    const docs = [{ path: LOCAL_PATH, name: '本地增量知识库（工作区）', kind: 'local', available: canWrite, overridePath: null }];
    for (const preset of PRESET_DOCUMENTS) {
      docs.push({ ...preset, kind: 'baseline', available: paths.has(preset.path), overridePath: overridePath(preset.path) });
    }
    for (const path of [...paths].filter(item => item.startsWith('protocols/') && item.endsWith('.md')
      && !PRESET_DOCUMENTS.some(preset => preset.path === item)).sort()) {
      docs.push({ path, name: displayName(path), kind: 'baseline', available: true, overridePath: overridePath(path) });
    }
    return docs;
  }

  async function readWorkspaceText(path) {
    if (!canWrite) return '';
    const stat = await workspace.call('stat', { path });
    if (!stat || stat.kind !== 'file') return '';
    let text = '', offset = 0;
    for (let page = 0; page < 256; page++) {
      const chunk = await workspace.call('read', { path, format: 'text', offset, limit: 20000 });
      text += chunk?.text ?? '';
      if (chunk?.eof || chunk?.nextOffset == null || chunk.nextOffset <= offset) break;
      offset = chunk.nextOffset;
    }
    return text;
  }

  async function readDocument(doc) {
    if (doc.kind === 'local') {
      if (!canWrite) throw Error('工作区不可用，无法读取本地增量知识库。');
      const text = await readWorkspaceText(doc.path);
      return { text, source: text ? '已从本地工作区读取增量知识库' : '本地增量知识库为空（尚未保存）' };
    }
    if (!sourceIndex || !doc.available) throw Error('该基线文档不在内置知识资源中，无法查看内容。');
    const override = await readWorkspaceText(doc.overridePath);
    doc.hasOverride = Boolean(override);
    if (override) return { text: override, source: '已加载本地副本（覆盖原始协议，原始文件未改动）' };
    return { text: sourceIndex.readText(doc.path), source: '已加载内置基线文档（只读）' };
  }

  async function selectDoc(path, force = false) {
    const doc = docs.find(item => item.path === path);
    if (!doc || destroyed) return;
    if (path === selectedPath && !force && savedText !== null) return;
    if (mode === 'edit' && currentText !== savedText && path !== selectedPath) say('已切换文档，未保存的修改已丢弃。', 'warning');
    selectedPath = path;
    savedText = null;
    currentText = '';
    editor.value = '';
    renderDocList();
    setMode('preview');
    setNotice('正在加载文档…');
    const token = ++loadToken;
    try {
      const result = await readDocument(doc);
      if (token !== loadToken || destroyed) return;
      savedText = result.text;
      currentText = result.text;
      editor.value = result.text;
      renderPreview(); updateHits(); updateSaveState();
      setNotice(result.source, doc.kind === 'local' || doc.hasOverride ? 'success' : 'info');
    } catch (error) {
      if (token !== loadToken || destroyed) return;
      savedText = null; currentText = ''; editor.value = '';
      preview.replaceChildren(); hits.replaceChildren(); searchCount.textContent = '';
      const message = error?.message ?? String(error);
      setNotice('加载失败：' + message, 'error');
      say('知识库文档加载失败：' + message, 'error');
      updateSaveState();
    }
  }

  // ---------- 保存 ----------
  async function saveCurrent() {
    const doc = currentDoc();
    if (!doc || saving || destroyed) return;
    if (!canWrite) { setNotice('工作区不可用，无法保存。', 'error'); say('工作区不可用，无法保存。', 'error'); return; }
    if (mode === 'edit') currentText = editor.value;
    const target = doc.kind === 'local' ? doc.path : doc.overridePath;
    saving = true;
    updateSaveState();
    setNotice('正在保存…');
    try {
      await workspace.call('write', { path: target, text: currentText, overwrite: true });
      if (destroyed) return;
      savedText = currentText;
      doc.hasOverride = true;
      renderDocList(); renderPreview(); updateSaveState();
      const message = doc.kind === 'local' ? `已保存：${target}` : `已保存到本地副本，不改动原始协议文件：${target}`;
      setNotice(message, 'success');
      say(message, 'success');
    } catch (error) {
      if (destroyed) return;
      const message = error?.message ?? String(error);
      setNotice('保存失败：' + message, 'error');
      say('保存失败：' + message, 'error');
    } finally {
      saving = false;
      updateSaveState();
    }
  }

  // ---------- 事件 ----------
  tabPreview.addEventListener('click', () => setMode('preview'));
  tabEdit.addEventListener('click', () => setMode('edit'));
  reload.addEventListener('click', () => { void selectDoc(selectedPath, true); });
  save.addEventListener('click', () => { void saveCurrent(); });
  editor.addEventListener('input', () => { currentText = editor.value; updateSaveState(); });
  search.addEventListener('input', () => { renderPreview(); updateHits(); });

  // ---------- 初始化 / 对外接口 ----------
  async function refresh() {
    if (destroyed) return;
    await loadSource();
    if (destroyed) return;
    docs = buildDocuments();
    if (sourceError) {
      sidebarHint.textContent = '内置知识资源加载失败：基线文档只读且暂不可查看；仅本地增量知识库可编辑。';
    } else if (!canWrite) {
      sidebarHint.textContent = '工作区不可用：仅可查看基线文档，保存已禁用。';
    }
    const preferred = docs.some(item => item.path === CORE_BASELINE) ? CORE_BASELINE : LOCAL_PATH;
    selectedPath = null;
    await selectDoc(preferred, true);
  }

  setMode('preview');
  void refresh();

  const setVisible = visible => {
    root.hidden = !visible;
    if (visible && !selectedPath && !destroyed) void refresh();
    // 打开时监听外部点击 / Esc；关闭后移除，不影响编辑器其它快捷键
    if (visible) {
      document.addEventListener('mousedown', onOutsideClick, true);
      document.addEventListener('keydown', onEscape, true);
    } else {
      document.removeEventListener('mousedown', onOutsideClick, true);
      document.removeEventListener('keydown', onEscape, true);
    }
  };
  const onOutsideClick = event => {
    if (!(event.target instanceof Node)) return;
    if (!root.contains(event.target)) setVisible(false);
  };
  const onEscape = event => {
    if (event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    setVisible(false);
  };
  close.addEventListener('click', () => setVisible(false));

  return {
    element: root,
    destroy() { destroyed = true; setVisible(false); root.remove(); },
    refresh,
    setVisible,
  };
}
