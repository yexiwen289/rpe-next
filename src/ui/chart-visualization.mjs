import { t } from '../i18n.mjs';
import { NOTE_NAMES } from '../core/chart.mjs';
import { computeChartMetrics, METRIC_PALETTE } from '../core/chart-metrics.mjs';
import { computeWorkflowMetrics, generateObservations, runAgentChartWorkflow } from './agent-chart-workflow.mjs';

const TYPE_ORDER = [1, 2, 3, 4];

let activeCharts = [];
let lastArgs = null;
let resizeHandler = null;
let lastComputed = null;
let lastChart = null;
let lastAgent = null;

function theme() {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  return {
    text: body.color || '#f0f0f0',
    muted: root.getPropertyValue('--muted').trim() || '#aaaaaa',
    axis: root.getPropertyValue('--line').trim() || '#515151',
    accent: root.getPropertyValue('--accent').trim() || '#ffdc70',
    grid: 'rgba(255,255,255,0.08)',
  };
}

function setupCanvas(canvas) {
  const dpr = globalThis.devicePixelRatio || 1;
  const width = canvas.clientWidth || (canvas.parentElement ? canvas.parentElement.clientWidth : 300) || 300;
  const height = canvas.clientHeight || 150;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function drawBars(canvas, items) {
  const { context, width, height } = setupCanvas(canvas);
  const c = theme();
  const padL = 8, padR = 8, padT = 18, padB = 26;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const max = Math.max(1, ...items.map(item => item.value));
  context.strokeStyle = c.axis; context.lineWidth = 1;
  context.beginPath(); context.moveTo(padL, padT + plotH + 0.5); context.lineTo(padL + plotW, padT + plotH + 0.5); context.stroke();
  const slot = plotW / Math.max(1, items.length);
  const barWidth = Math.min(46, slot * 0.62);
  context.font = '11px RPE, sans-serif';
  items.forEach((item, index) => {
    const x = padL + slot * index + (slot - barWidth) / 2;
    const h = (item.value / max) * plotH;
    context.fillStyle = item.color; context.globalAlpha = 0.85;
    context.fillRect(x, padT + plotH - h, barWidth, Math.max(1, h));
    context.globalAlpha = 1;
    context.fillStyle = c.text; context.textAlign = 'center'; context.textBaseline = 'bottom';
    context.fillText(String(item.value), x + barWidth / 2, padT + plotH - h - 2);
    context.fillStyle = c.muted; context.textBaseline = 'top';
    const label = item.label.length > 8 ? item.label.slice(0, 7) + '…' : item.label;
    context.fillText(label, x + barWidth / 2, padT + plotH + 4);
  });
}

function drawHistogram(canvas, bins, color) {
  const { context, width, height } = setupCanvas(canvas);
  const c = theme();
  const padL = 8, padR = 8, padT = 10, padB = 16;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const max = Math.max(1, ...bins);
  const logarithm = Math.log1p(max);
  const barWidth = plotW / Math.max(1, bins.length);
  for (let index = 0; index < bins.length; index++) {
    if (!bins[index]) continue;
    const value = Math.log1p(bins[index]) / logarithm;
    const h = value * plotH;
    context.fillStyle = color; context.globalAlpha = 0.3 + 0.7 * value;
    context.fillRect(padL + index * barWidth, padT + plotH - h, Math.max(1, barWidth), Math.max(1, h));
  }
  context.globalAlpha = 1;
  context.strokeStyle = c.axis; context.lineWidth = 1;
  context.beginPath(); context.moveTo(padL, padT + plotH + 0.5); context.lineTo(padL + plotW, padT + plotH + 0.5); context.stroke();
}

function drawStep(canvas, points) {
  const { context, width, height } = setupCanvas(canvas);
  const c = theme();
  const padL = 8, padR = 8, padT = 12, padB = 16;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  if (!points.length) return;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(0, ...xs), maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const yRange = (maxY - minY) || 1;
  const xOf = x => padL + (maxX - minX ? (x - minX) / (maxX - minX) : 0) * plotW;
  const yOf = y => padT + plotH - (y - minY) / yRange * plotH;
  context.strokeStyle = c.axis; context.fillStyle = c.muted; context.font = '10px RPE, sans-serif';
  context.textAlign = 'left'; context.textBaseline = 'middle';
  for (const y of [minY, (minY + maxY) / 2, maxY]) {
    const yy = yOf(y);
    context.globalAlpha = 0.5; context.beginPath(); context.moveTo(padL, yy); context.lineTo(padL + plotW, yy); context.stroke();
    context.globalAlpha = 1; context.fillText(String(Math.round(y)), padL + 2, yy - 6);
  }
  context.strokeStyle = c.accent; context.lineWidth = 2; context.beginPath();
  let previousY = yOf(points[0].y);
  points.forEach((point, index) => {
    const x = xOf(point.x), y = yOf(point.y);
    if (index === 0) context.moveTo(x, previousY);
    else context.lineTo(x, previousY);
    context.lineTo(x, y);
    previousY = y;
  });
  context.stroke();
  context.fillStyle = c.accent;
  for (const point of points) { context.beginPath(); context.arc(xOf(point.x), yOf(point.y), 2.5, 0, Math.PI * 2); context.fill(); }
}

function drawProportion(canvas, segments) {
  const { context, width, height } = setupCanvas(canvas);
  const c = theme();
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  const barH = Math.min(30, height - 24);
  const y = (height - barH) / 2 + 4;
  context.fillStyle = c.axis; context.globalAlpha = 0.25; context.fillRect(8, y, width - 16, barH); context.globalAlpha = 1;
  let x = 8;
  for (const segment of segments) {
    if (!segment.value) continue;
    const segW = segment.value / total * (width - 16);
    context.fillStyle = segment.color; context.globalAlpha = 0.85; context.fillRect(x, y, Math.max(1, segW), barH); context.globalAlpha = 1;
    if (segW > 46) {
      context.fillStyle = c.text; context.font = '11px RPE, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(`${segment.label} ${segment.value}`, x + segW / 2, y + barH / 2);
    }
    x += segW;
  }
}

function drawStackedArea(canvas, series) {
  const { context, width, height } = setupCanvas(canvas);
  const c = theme();
  const n = series.length ? series[0].values.length : 0;
  if (!n) return;
  const padL = 8, padR = 8, padT = 8, padB = 16;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const totals = new Array(n).fill(0);
  for (const s of series) for (let i = 0; i < n; i++) totals[i] += s.values[i];
  const maxTotal = Math.max(1, ...totals);
  const xOf = i => padL + (n > 1 ? i / (n - 1) : 0) * plotW;
  const yOf = v => padT + plotH - v / maxTotal * plotH;
  const lower = new Array(n).fill(0);
  for (const s of series) {
    context.beginPath();
    for (let i = 0; i < n; i++) { const x = xOf(i), y = yOf(lower[i] + s.values[i]); i === 0 ? context.moveTo(x, y) : context.lineTo(x, y); }
    for (let i = n - 1; i >= 0; i--) { const x = xOf(i), y = yOf(lower[i]); context.lineTo(x, y); }
    context.closePath();
    context.fillStyle = s.color; context.globalAlpha = 0.55; context.fill(); context.globalAlpha = 1;
    for (let i = 0; i < n; i++) lower[i] += s.values[i];
  }
  context.strokeStyle = c.axis; context.lineWidth = 1; context.beginPath(); context.moveTo(padL, yOf(0)); context.lineTo(padL + plotW, yOf(0)); context.stroke();
  context.fillStyle = c.muted; context.font = '10px RPE, sans-serif'; context.textBaseline = 'bottom';
  context.textAlign = 'left'; context.fillText('0', padL + 2, yOf(0) - 2);
  context.textAlign = 'right'; context.fillText(String(maxTotal), padL + plotW - 2, yOf(maxTotal) - 2);
}

function drawEventTimeline(canvas, rows, duration) {
  const { context, width, height } = setupCanvas(canvas);
  const c = theme();
  if (!rows.length) return;
  const padL = 60, padR = 8, padT = 6, padB = 6;
  const plotW = width - padL - padR;
  const laneH = (height - padT - padB) / rows.length;
  context.font = '10px RPE, sans-serif';
  rows.forEach((row, index) => {
    const cy = padT + laneH * index + laneH / 2;
    context.fillStyle = c.muted; context.textAlign = 'right'; context.textBaseline = 'middle';
    context.fillText(row.label, padL - 6, cy);
    context.strokeStyle = c.axis; context.globalAlpha = 0.4; context.beginPath(); context.moveTo(padL, cy); context.lineTo(padL + plotW, cy); context.stroke(); context.globalAlpha = 1;
    context.fillStyle = row.color;
    for (const time of row.times) { const x = padL + (duration ? time / duration : 0) * plotW; context.beginPath(); context.arc(x, cy, 2.5, 0, Math.PI * 2); context.fill(); }
  });
}

function drawRangeBars(canvas, items) {
  const { context, width, height } = setupCanvas(canvas);
  const c = theme();
  if (!items.length) return;
  const padL = 60, padR = 8, padT = 6, padB = 14;
  const plotW = width - padL - padR;
  const minV = Math.min(...items.map(i => i.min));
  const maxV = Math.max(...items.map(i => i.max));
  const range = (maxV - minV) || 1;
  const xOf = v => padL + ((v - minV) / range) * plotW;
  const laneH = (height - padT - padB) / items.length;
  context.font = '10px RPE, sans-serif';
  items.forEach((item, index) => {
    const cy = padT + laneH * index + laneH / 2;
    context.fillStyle = c.muted; context.textAlign = 'right'; context.textBaseline = 'middle';
    context.fillText(item.label, padL - 6, cy);
    const x1 = xOf(item.min), x2 = xOf(item.max);
    context.strokeStyle = item.color; context.lineWidth = 3; context.lineCap = 'round';
    context.beginPath(); context.moveTo(x1, cy); context.lineTo(x2, cy); context.stroke();
    context.fillStyle = item.color;
    context.beginPath(); context.arc(x1, cy, 3, 0, Math.PI * 2); context.fill();
    context.beginPath(); context.arc(x2, cy, 3, 0, Math.PI * 2); context.fill();
  });
  context.fillStyle = c.muted; context.textBaseline = 'bottom';
  context.textAlign = 'left'; context.fillText(String(minV), padL, height - 2);
  context.textAlign = 'right'; context.fillText(String(maxV), padL + plotW, height - 2);
}

function redrawAll() {
  for (const entry of activeCharts) if (entry.canvas.isConnected && entry.canvas.clientWidth) entry.draw(entry.canvas);
}

// safeDiagnose / computeWorkflowMetrics / generateObservations / buildAgentPrompt /
// runAgentChartWorkflow now live in ./agent-chart-workflow.mjs and are shared with the
// dedicated "AI 工具" panel so the two stay in sync.

function openLightbox(title, caption, draw) {
  const overlay = document.createElement('div');
  overlay.className = 'viz-lightbox';
  const box = document.createElement('div');
  box.className = 'viz-lightbox-box';
  const head = document.createElement('div');
  head.className = 'viz-lightbox-head';
  const h = document.createElement('h3'); h.textContent = title; head.append(h);
  const close = document.createElement('button');
  close.className = 'viz-lightbox-close'; close.textContent = '×';
  close.setAttribute('aria-label', t('viz.close'));
  head.append(close);
  const canvas = document.createElement('canvas');
  canvas.className = 'viz-lightbox-canvas';
  const cap = document.createElement('p');
  cap.className = 'hint';
  cap.textContent = caption || '';
  box.append(head, canvas, cap);
  overlay.append(box);
  document.body.append(overlay);
  const dismiss = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = event => { if (event.key === 'Escape') dismiss(); };
  overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => { try { draw(canvas); } catch { /* ignore */ } });
}

export function renderChartVisualization(host, args) {
  lastArgs = args;
  host.replaceChildren();
  activeCharts = [];
  if (!args) return;
  const { chart, tempo } = args;
  const lines = chart?.judgeLineList ?? [];
  if (!lines.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('viz.empty');
    host.append(empty);
    return;
  }

  // --- Compute every aggregate once (shared with the agent's chart_insights tool) ---
  const m = computeChartMetrics(chart, tempo);
  lastChart = chart;
  lastAgent = args?.agent ?? null;
  lastComputed = computeWorkflowMetrics(chart, tempo);

  // --- Summary toolbar ---
  const toolbar = document.createElement('div');
  toolbar.className = 'viz-toolbar';
  const summary = document.createElement('span');
  summary.className = 'hint';
  summary.textContent = t('viz.summary', { p0: m.totalNotes, p1: m.lineCount, p2: m.duration.toFixed(1), p3: m.bpmMin, p4: m.bpmMax });
  toolbar.append(summary);
  const statusEl = document.createElement('span');
  statusEl.className = 'viz-status';
  toolbar.append(statusEl);
  const refresh = document.createElement('button');
  refresh.textContent = t('viz.refresh');
  refresh.onclick = () => { if (lastArgs) renderChartVisualization(host, lastArgs); };
  toolbar.append(refresh);
  if (lastAgent) {
    const analyzeBtn = document.createElement('button');
    analyzeBtn.className = 'viz-ai-button';
    analyzeBtn.textContent = t('viz.aiAnalyze');
    analyzeBtn.onclick = () => runAgentChartWorkflow({ agent: lastAgent, metrics: lastComputed, statusEl });
    toolbar.append(analyzeBtn);
  }
  host.append(toolbar);

  const grid = document.createElement('div');
  grid.className = 'viz-grid';
  host.append(grid);

  // --- Build card list (data already aggregated in `m`) ---
  const cards = [];
  const add = (section, title, caption, draw, condition = true) => { if (condition) cards.push({ section, title, caption, draw }); };
  const colorAt = index => METRIC_PALETTE[index % METRIC_PALETTE.length];
  const lineLabel = (line, index) => (line.Name || `L${index + 1}`).slice(0, 6);

  // NOTE
  add('note', t('viz.noteType'), `${t('viz.fake')}：${m.fake}`, canvas => drawBars(canvas, TYPE_ORDER.map((type, index) => ({ label: NOTE_NAMES[type], value: m.typeCounts[type] ?? 0, color: METRIC_PALETTE[index] }))));
  add('note', t('viz.aboveBelow'), `${t('viz.above')} / ${t('viz.below')}`, canvas => drawProportion(canvas, [
    { label: t('viz.above'), value: m.above, color: METRIC_PALETTE[0] },
    { label: t('viz.below'), value: m.below, color: METRIC_PALETTE[1] },
  ]));
  add('note', t('viz.speedDist'), t('viz.xValue'), canvas => drawBars(canvas, m.speedDist));
  add('note', t('viz.sizeDist'), t('viz.xValue'), canvas => drawBars(canvas, m.sizeDist));
  add('note', t('viz.alphaDist'), t('viz.xValue'), canvas => drawHistogram(canvas, m.alphaBins, '#9b8cff'));
  add('note', t('viz.position'), `${t('viz.xPosition')} [${m.posX[0].toFixed(2)}, ${m.posX[1].toFixed(2)}]`, canvas => drawHistogram(canvas, m.posXBins, '#d39b55'));
  if (m.posYCount) add('note', t('viz.positionY'), `${t('viz.xPosition')} [${m.posYRange[0].toFixed(2)}, ${m.posYRange[1].toFixed(2)}]`, canvas => drawHistogram(canvas, m.posYBins, '#7ad19b'));
  if (m.colored) add('note', t('viz.colorNotes'), `${t('viz.colored')} / ${t('viz.plain')}`, canvas => drawProportion(canvas, [
    { label: t('viz.colored'), value: m.colored, color: METRIC_PALETTE[3] },
    { label: t('viz.plain'), value: m.totalNotes - m.colored, color: METRIC_PALETTE[4] },
  ]));

  // TIMING
  add('timing', t('viz.density'), `${t('viz.xTime')} (s) · 80 ${t('viz.bins')}`, canvas => drawHistogram(canvas, m.noteBins, '#56b9d4'));
  add('timing', t('viz.cumulative'), t('viz.xCumulative'), canvas => drawStackedArea(canvas, m.cumSeries));
  if (m.intervalBins) add('timing', t('viz.interval'), `${t('viz.xInterval')} · 40 ${t('viz.bins')}`, canvas => drawHistogram(canvas, m.intervalBins, '#d39b55'));
  add('timing', t('viz.offsetBeat'), `0 = ${t('viz.xTime')}`, canvas => drawHistogram(canvas, m.offsetBins, '#7ad19b'));
  if (m.holdBins) add('timing', t('viz.holdLength'), t('viz.xDuration'), canvas => drawHistogram(canvas, m.holdBins, '#9b8cff'));
  if (m.fake) add('timing', t('viz.fakeDensity'), `${t('viz.xTime')} (s) · 80 ${t('viz.bins')}`, canvas => drawHistogram(canvas, m.fakeBins, '#e08b8b'));

  // BPM
  add('bpm', t('viz.bpm'), `${t('viz.bpmRange')}：${m.bpmMin}–${m.bpmMax}`, canvas => drawStep(canvas, m.bpmPoints));
  add('bpm', t('viz.bpmFactor'), t('viz.xValue'), canvas => drawBars(canvas, lines.map((line, index) => ({ label: lineLabel(line, index), value: m.bpmFactors[index], color: colorAt(index) }))));

  // LINE
  add('line', t('viz.perLine'), `${t('viz.line')} · ${t('viz.notes')}`, canvas => drawBars(canvas, lines.map((line, index) => ({ label: lineLabel(line, index), value: m.perLineNotes[index], color: colorAt(index) }))));
  add('line', t('viz.perLineEvents'), `${t('viz.line')} · ${t('viz.xEvent')}`, canvas => drawBars(canvas, lines.map((line, index) => ({ label: lineLabel(line, index), value: m.perLineEvents[index], color: colorAt(index) }))));
  add('line', t('viz.groupDist'), t('viz.xCount'), canvas => drawProportion(canvas, m.groups));
  add('line', t('viz.fatherDist'), t('viz.xCount'), canvas => drawBars(canvas, m.fathers));

  // EVENT
  const eventTimelineRows = m.events.filter(e => m.eventTimes[e.type].length).map(e => ({ label: e.label, color: e.color, times: m.eventTimes[e.type] }));
  const eventRangeItems = m.events.filter(e => m.eventRanges[e.type]).map(e => ({ label: e.label, color: e.color, ...m.eventRanges[e.type] }));
  add('event', t('viz.events'), `${t('viz.xEvent')} · ${t('viz.xCount')}`, canvas => drawBars(canvas, m.events));
  if (eventTimelineRows.length) add('event', t('viz.eventTimeline'), `${t('viz.xTime')} (s)`, canvas => drawEventTimeline(canvas, eventTimelineRows, m.duration));
  if (eventRangeItems.length) add('event', t('viz.eventRange'), `${t('viz.min')} – ${t('viz.max')}`, canvas => drawRangeBars(canvas, eventRangeItems));

  // AI assistant: offline heuristic preview (works without an API key)
  const observations = generateObservations(lastComputed);
  if (observations.length) cards.push({ section: 'ai', title: t('viz.aiPreview'), caption: t('viz.aiPreviewHint'), text: observations });

  // --- Render with section grouping ---
  let currentSection = null;
  for (const card of cards) {
    if (card.section !== currentSection) {
      currentSection = card.section;
      const header = document.createElement('div');
      header.className = 'viz-section';
      header.textContent = t(`viz.section.${card.section}`);
      grid.append(header);
    }
    const section = document.createElement('div');
    section.className = 'viz-card';
    const heading = document.createElement('h4');
    heading.textContent = card.title;
    section.append(heading);
    if (card.text) {
      const list = document.createElement('ul');
      list.className = 'viz-observations';
      for (const line of card.text) { const item = document.createElement('li'); item.textContent = line; list.append(item); }
      section.append(list);
    } else {
      const canvas = document.createElement('canvas');
      canvas.className = 'viz-canvas';
      canvas.title = t('viz.clickToEnlarge');
      section.append(canvas);
      canvas.addEventListener('click', () => openLightbox(card.title, card.caption, card.draw));
      activeCharts.push({ canvas, draw: card.draw });
    }
    if (card.caption) {
      const paragraph = document.createElement('p');
      paragraph.className = 'hint';
      paragraph.textContent = card.caption;
      section.append(paragraph);
    }
    grid.append(section);
  }

  if (!resizeHandler) {
    resizeHandler = () => redrawAll();
    globalThis.addEventListener('resize', resizeHandler);
  }
  redrawAll();
  requestAnimationFrame(redrawAll);
}
