// 可视化 UI 编辑：拖拽按钮重排、逐按钮改色/尺寸、拖侧栏宽度。全部本地保存，无配置文件。
const KEY = 'vibephi-ui-designer-v1';
const CONTAINERS = ['header nav', '.transport', '.agent-config-cards'];

const load = () => {
  try { return { order: {}, styles: {}, layout: {}, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; }
  catch { return { order: {}, styles: {}, layout: {} }; }
};
let state = load();
let toolbar = null, selected = null, active = false;
const save = () => localStorage.setItem(KEY, JSON.stringify(state));

function keyFor(node) {
  if (node.dataset.uiKey) return node.dataset.uiKey;
  const parent = node.parentElement;
  const label = (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24) || node.title || node.id || node.tagName;
  const key = `${parent?.className || parent?.tagName || 'root'}::${label}`;
  node.dataset.uiKey = key;
  return key;
}

function targets() {
  return CONTAINERS.flatMap(selector => [...document.querySelectorAll(selector)]).flatMap(container => [...container.querySelectorAll(':scope > button')]);
}

export function applyUiDesign() {
  state = load();
  for (const [selector, ids] of Object.entries(state.order ?? {})) {
    const container = document.querySelector(selector); if (!container) continue;
    const nodes = new Map([...container.querySelectorAll(':scope > button')].map(node => [keyFor(node), node]));
    for (const id of ids) { const node = nodes.get(id); if (node) container.append(node); }
  }
  for (const [id, style] of Object.entries(state.styles ?? {})) {
    const node = document.querySelector(`[data-ui-key="${CSS.escape(id)}"]`) ?? (id.startsWith('#') ? document.querySelector(id) : null);
    if (!node || !style) continue;
    if (style.background) node.style.background = style.background;
    if (style.color) node.style.color = style.color;
    if (style.border) node.style.borderColor = style.border;
    if (style.scale) node.style.transform = `scale(${style.scale})`;
    if (style.hidden) node.hidden = true;
  }
  const root = document.documentElement;
  for (const [name, value] of Object.entries(state.layout ?? {})) if (value) root.style.setProperty(`--${name}`, value);
}

function select(node) {
  if (selected) selected.classList.remove('ui-design-selected');
  selected = node;
  if (!node) return;
  node.classList.add('ui-design-selected');
  const style = state.styles[keyFor(node)] ?? {};
  toolbar.querySelector('.ui-design-color').value = style.background ?? getComputedStyle(node).backgroundColor;
  toolbar.querySelector('.ui-design-text').value = style.color ?? getComputedStyle(node).color;
  toolbar.querySelector('.ui-design-scale').value = String(style.scale ?? 1);
}

function ensureToolbar() {
  if (toolbar) return toolbar;
  toolbar = document.createElement('div'); toolbar.className = 'ui-design-toolbar'; toolbar.hidden = true;
  toolbar.innerHTML = `<strong>UI 编辑模式</strong>
    <label>背景 <input class="ui-design-color" type="color"></label>
    <label>文字 <input class="ui-design-text" type="color"></label>
    <label>大小 <input class="ui-design-scale" type="range" min="0.8" max="1.6" step="0.05" value="1"></label>
    <label>左栏宽 <input class="ui-design-drawer-left" type="range" min="220" max="520" step="10" value="360"></label>
    <label>右栏宽 <input class="ui-design-drawer-right" type="range" min="220" max="520" step="10" value="360"></label>
    <button type="button" data-action="hide">隐藏选中</button>
    <button type="button" data-action="reset-one">重置选中</button>
    <button type="button" data-action="unhide">显示已隐藏按钮</button>
    <button type="button" data-action="unhide">显示已隐藏按钮</button>
    <button type="button" data-action="reset-all">恢复默认</button>
    <button type="button" data-action="exit">完成</button>`;
  document.body.append(toolbar);
  toolbar.querySelector('.ui-design-color').addEventListener('input', event => updateSelected({ background: event.target.value }));
  toolbar.querySelector('.ui-design-text').addEventListener('input', event => updateSelected({ color: event.target.value }));
  toolbar.querySelector('.ui-design-scale').addEventListener('input', event => updateSelected({ scale: Number(event.target.value) }));
  toolbar.querySelector('.ui-design-drawer-left').addEventListener('input', event => { state.layout['drawer-left-width'] = event.target.value + 'px'; document.documentElement.style.setProperty('--drawer-left-width', state.layout['drawer-left-width']); save(); });
  toolbar.querySelector('.ui-design-drawer-right').addEventListener('input', event => { state.layout['drawer-right-width'] = event.target.value + 'px'; document.documentElement.style.setProperty('--drawer-right-width', state.layout['drawer-right-width']); save(); });
  toolbar.onclick = event => {
    const action = event.target.dataset?.action; if (!action) return;
    if (action === 'exit') return toggle(false);
    if (action === 'hide') { if (selected) { selected.hidden = true; updateSelected({ hidden: true }); } return; }
    if (action === 'reset-one') { if (selected) { const style = state.styles[keyFor(selected)]; if (style) { for (const prop of ['background', 'color', 'border', 'scale']) selected.style.removeProperty(prop === 'scale' ? 'transform' : prop); selected.hidden = false; delete state.styles[keyFor(selected)]; save(); select(selected); } } return; }
    if (action === 'unhide') { for (const [id, style] of Object.entries(state.styles)) if (style.hidden) { delete style.hidden; const node = document.querySelector(`[data-ui-key="${CSS.escape(id)}"]`); if (node) node.hidden = false; } save(); return; }
    if (action === 'unhide') { for (const [id, style] of Object.entries(state.styles)) if (style.hidden) { delete style.hidden; const node = document.querySelector(`[data-ui-key="${CSS.escape(id)}"]`); if (node) node.hidden = false; } save(); return; }
    if (action === 'reset-all') { state = { order: {}, styles: {}, layout: {} }; save(); location.reload(); }
  };
  return toolbar;
}

function updateSelected(patch) {
  if (!selected) return;
  const id = keyFor(selected);
  state.styles[id] = { ...(state.styles[id] ?? {}), ...patch };
  if (patch.background) selected.style.background = patch.background;
  if (patch.color) selected.style.color = patch.color;
  if (patch.scale !== undefined) selected.style.transform = `scale(${patch.scale})`;
  save();
}

function onDesignClick(event) {
  if (!active) return;
  const node = event.target.closest('button');
  if (!node || !targets().includes(node)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  select(node);
}

function onDragStart(event) {
  if (!active) return;
  const node = event.target.closest('button'); if (!node || !targets().includes(node)) return;
  event.dataTransfer.setData('text/plain', keyFor(node));
  event.dataTransfer.effectAllowed = 'move';
  select(node);
}
function onDragOver(event) {
  if (!active) return;
  const node = event.target.closest('button'); if (!node || !targets().includes(node)) return;
  event.preventDefault();
}
function onDrop(event) {
  if (!active) return;
  const source = event.dataTransfer.getData('text/plain'); if (!source) return;
  const target = event.target.closest('button'); if (!target || !targets().includes(target)) return;
  event.preventDefault();
  const from = document.querySelector(`[data-ui-key="${CSS.escape(source)}"]`);
  if (!from || from === target) return;
  const rect = target.getBoundingClientRect();
  target.parentElement.insertBefore(from, event.clientX < rect.left + rect.width / 2 ? target : target.nextSibling);
  persistOrder();
}
function persistOrder() {
  for (const selector of CONTAINERS) {
    const container = document.querySelector(selector); if (!container) continue;
    state.order[selector] = [...container.querySelectorAll(':scope > button')].map(keyFor);
  }
  save();
}

export function toggle(force) {
  active = force === undefined ? !active : Boolean(force);
  document.body.classList.toggle('ui-design-mode', active);
  const bar = ensureToolbar(); bar.hidden = !active;
  for (const node of targets()) node.draggable = active;
  if (active) {
    promptSelect(); select(null);
  } else {
    for (const node of targets()) node.classList.remove('ui-design-selected');
  }
}

function promptSelect() {
  const bar = ensureToolbar();
  if (!bar.querySelector('.ui-design-hint')) {
    const hint = document.createElement('small'); hint.className = 'ui-design-hint'; hint.textContent = '拖动按钮重排 · 点击按钮改样式'; bar.append(hint);
  }
}

export function initUiDesigner() {
  for (const node of targets()) keyFor(node);
  applyUiDesign();
  document.addEventListener('click', onDesignClick, true);
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
}
