// Pure, DOM-free chart analytics shared by the visualization panel and the
// agent's `chart_insights` tool. Given a chart and a TempoMap it returns every
// aggregate the editor needs to *understand* a chart at a glance: note-type mix,
// speed/size/alpha distributions, density & interval histograms, beat-phase
// (syncopation) bins, cumulative curves, position histograms, per-line and
// per-event breakdowns, BPM trajectory and diagnostics.
//
// Keeping this in core (not the UI module) lets the agent reason about the chart
// without streaming thousands of raw notes through the model context.

import { NOTE_NAMES, EVENT_TYPES, EXTENDED_TYPES, noteIsAbove } from './chart.mjs';
import { beatValue } from './beat.mjs';

export const METRIC_PALETTE = ['#56b9d4', '#d39b55', '#9b8cff', '#7ad19b', '#e08b8b', '#c9c06a', '#6fc3e0', '#d08bd0'];
export const EVENT_LABELS = { moveXEvents: 'moveX', moveYEvents: 'moveY', rotateEvents: 'rotate', alphaEvents: 'alpha', speedEvents: 'speed' };
const ALL_EVENT = [...EVENT_TYPES, ...EXTENDED_TYPES];
const TYPE_ORDER = [1, 2, 3, 4];

export function valueCounts(values, round = 2, maxDistinct = 14) {
  const map = new Map();
  for (const raw of values) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const key = Number.isInteger(v) ? v : Math.round(v * 10 ** round) / 10 ** round;
    map.set(key, (map.get(key) || 0) + 1);
  }
  let entries = [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  let rows;
  if (entries.length > maxDistinct) {
    const top = entries.slice(0, maxDistinct - 1);
    const rest = entries.slice(maxDistinct - 1).reduce((sum, e) => sum + e.count, 0);
    rows = top.map(e => ({ label: String(e.key), value: e.count }));
    rows.push({ label: '其他', value: rest });
  } else {
    rows = entries.sort((a, b) => a.key - b.key).map(e => ({ label: String(e.key), value: e.count }));
  }
  return rows.map((row, index) => ({ ...row, color: METRIC_PALETTE[index % METRIC_PALETTE.length] }));
}

export function buildBins(values, binCount, maxValue) {
  const bins = new Array(binCount).fill(0);
  for (const raw of values) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const index = Math.max(0, Math.min(binCount - 1, Math.floor(v / maxValue * binCount)));
    bins[index]++;
  }
  return bins;
}

export function distributionText(values, round = 2) {
  const map = new Map();
  for (const raw of values) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const key = Number.isInteger(v) ? v : Math.round(v * 100) / 100;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, c]) => `${k}:${c}`).join(', ');
}

export function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Compute the full metric bundle for a chart. `tempo` must be a TempoMap built
// from chart.BPMList. The result is plain, serializable data (no DOM, no i18n).
export function computeChartMetrics(chart, tempo) {
  const lines = chart?.judgeLineList ?? [];
  const bpmList = chart?.BPMList ?? [];
  const metrics = {
    totalNotes: 0,
    lineCount: lines.length,
    duration: 0,
    bpmMin: 0,
    bpmMax: 0,
    typeCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    above: 0,
    below: 0,
    fake: 0,
    colored: 0,
    speedDist: [],
    sizeDist: [],
    alphaTransparent: 0,
    alphaBins: [],
    holdBins: null,
    posX: [0, 0],
    posYCount: 0,
    posYRange: null,
    posXBins: [],
    posYBins: null,
    holdCount: 0,
    holdAvg: 0,
    intervalCount: 0,
    intervalMedian: 0,
    intervalMax: 0,
    intervalBins: null,
    offsetBins: new Array(8).fill(0),
    perLineNotes: [],
    perLineEvents: [],
    groups: [],
    fathers: [],
    events: [],
    eventTimes: {},
    eventRanges: {},
    bpmPoints: [],
    bpmFactors: [],
    noteBins: [],
    fakeBins: [],
    cumSeries: [],
  };

  if (!lines.length) return metrics;

  const notes = [];
  let duration = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const factor = line.bpmfactor ?? 1;
    for (const note of (line.notes ?? [])) {
      const start = tempo.seconds(note.startTime, factor);
      const end = tempo.seconds(note.endTime, factor);
      duration = Math.max(duration, start, end);
      notes.push({
        lineIndex,
        time: start,
        end,
        beat: beatValue(note.startTime),
        type: Number(note.type),
        above: noteIsAbove(note) ? 1 : 0,
        speed: Number(note.speed ?? 1),
        size: Number(note.size ?? 1),
        alpha: Number(note.alpha ?? 255),
        posX: Number(note.positionX),
        posY: Number.isFinite(Number(note.positionY)) ? Number(note.positionY) : null,
        isFake: Number(note.isFake) === 1,
        hasColor: Array.isArray(note.color),
      });
    }
  }
  duration = Math.max(duration, 1);
  const totalNotes = notes.length;
  metrics.totalNotes = totalNotes;
  metrics.duration = duration;

  const speeds = [], sizes = [], alphas = [], posXs = [], posYs = [];
  const holdLengths = [];
  const fakeTimes = [];
  for (const note of notes) {
    metrics.typeCounts[note.type] = (metrics.typeCounts[note.type] ?? 0) + 1;
    if (note.above) metrics.above++; else metrics.below++;
    if (note.isFake) metrics.fake++;
    if (note.hasColor) metrics.colored++;
    speeds.push(note.speed); sizes.push(note.size); alphas.push(note.alpha);
    posXs.push(note.posX);
    if (note.posY !== null) posYs.push(note.posY);
    if (note.type === 2) holdLengths.push(Math.max(0, note.end - note.time));
    if (note.isFake) fakeTimes.push(note.time);
  }
  metrics.speedDist = valueCounts(speeds);
  metrics.sizeDist = valueCounts(sizes);
  metrics.alphaTransparent = alphas.filter(a => a < 255).length;
  metrics.alphaBins = buildBins(alphas, 32, 256);

  // Inter-note intervals per line
  const byLine = new Map();
  for (const note of notes) {
    if (!byLine.has(note.lineIndex)) byLine.set(note.lineIndex, []);
    byLine.get(note.lineIndex).push(note.time);
  }
  const intervals = [];
  for (const times of byLine.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) { const gap = times[i] - times[i - 1]; if (gap > 0 && gap < duration) intervals.push(gap); }
  }

  // Beat-phase (syncopation) distribution, 8 bins, index 0 = on-beat
  for (const note of notes) {
    const frac = ((note.beat % 1) + 1) % 1;
    metrics.offsetBins[Math.min(7, Math.floor(frac * 8))]++;
  }

  // Cumulative notes by type
  const cumBins = 100;
  const cumCounts = { 1: new Array(cumBins).fill(0), 2: new Array(cumBins).fill(0), 3: new Array(cumBins).fill(0), 4: new Array(cumBins).fill(0) };
  for (const note of notes) {
    const index = Math.max(0, Math.min(cumBins - 1, Math.floor(note.time / duration * cumBins)));
    cumCounts[note.type][index]++;
  }
  metrics.cumSeries = TYPE_ORDER.map((type, index) => {
    const cumulative = [];
    let sum = 0;
    for (let i = 0; i < cumBins; i++) { sum += cumCounts[type][i]; cumulative.push(sum); }
    return { color: METRIC_PALETTE[index], values: cumulative };
  });

  metrics.noteBins = buildBins(notes.map(n => n.time), 80, duration);
  metrics.fakeBins = buildBins(fakeTimes, 80, duration);

  const minPosX = posXs.length ? Math.min(...posXs, -1) : -1;
  const maxPosX = posXs.length ? Math.max(...posXs, 1) : 1;
  metrics.posX = [minPosX, maxPosX];
  const posXBins = new Array(40).fill(0);
  for (const p of posXs) posXBins[Math.max(0, Math.min(39, Math.round((p - minPosX) / (maxPosX - minPosX || 1) * 39)))]++;
  metrics.posXBins = posXBins;
  metrics.posYCount = posYs.length;
  if (posYs.length) {
    const minPosY = Math.min(...posYs), maxPosY = Math.max(...posYs);
    metrics.posYRange = [minPosY, maxPosY];
    const posYBins = new Array(40).fill(0);
    for (const p of posYs) posYBins[Math.max(0, Math.min(39, Math.round((p - minPosY) / (maxPosY - minPosY || 1) * 39)))]++;
    metrics.posYBins = posYBins;
  }

  if (intervals.length) {
    const sorted = [...intervals].sort((a, b) => a - b);
    const cap = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] || 1;
    metrics.intervalBins = buildBins(intervals, 40, Math.max(0.1, cap));
    metrics.intervalCount = intervals.length;
    metrics.intervalMedian = median(intervals);
    metrics.intervalMax = Math.max(...intervals);
  }

  const bpmPoints = bpmList.map(entry => ({ x: tempo.seconds(entry.startTime), y: Number(entry.bpm) })).sort((a, b) => a.x - b.x);
  const bpmValues = bpmPoints.map(p => p.y);
  metrics.bpmPoints = bpmPoints;
  metrics.bpmMin = bpmValues.length ? Math.min(...bpmValues) : 0;
  metrics.bpmMax = bpmValues.length ? Math.max(...bpmValues) : 1;

  metrics.perLineNotes = lines.map(line => (line.notes ?? []).length);
  metrics.perLineEvents = lines.map(line => {
    let count = 0;
    for (const layer of (line.eventLayers ?? [])) for (const type of ALL_EVENT) count += (layer?.[type]?.length ?? 0);
    for (const type of ALL_EVENT) count += (line.extended?.[type]?.length ?? 0);
    return count;
  });
  metrics.bpmFactors = lines.map(line => Number(line.bpmfactor ?? 1));

  const groups = chart.judgeLineGroup ?? ['Default'];
  const groupCounts = new Map();
  for (const line of lines) {
    const name = groups[line.Group ?? 0] ?? `G${line.Group ?? 0}`;
    groupCounts.set(name, (groupCounts.get(name) || 0) + 1);
  }
  metrics.groups = [...groupCounts.entries()].map(([name, value], index) => ({ label: name, value, color: METRIC_PALETTE[index % METRIC_PALETTE.length] }));

  const fatherCounts = new Map();
  for (const line of lines) {
    const key = (line.father ?? -1) === -1 ? '无父线' : `判定线 ${(line.father ?? -1) + 1}`;
    fatherCounts.set(key, (fatherCounts.get(key) || 0) + 1);
  }
  metrics.fathers = [...fatherCounts.entries()].map(([label, value], index) => ({ label, value, color: METRIC_PALETTE[index % METRIC_PALETTE.length] }));

  const eventCounts = Object.fromEntries(ALL_EVENT.map(type => [type, 0]));
  const eventTimes = Object.fromEntries(ALL_EVENT.map(type => [type, []]));
  const eventRanges = Object.fromEntries(ALL_EVENT.map(type => [type, null]));
  for (const line of lines) {
    const factor = line.bpmfactor ?? 1;
    const collect = layer => {
      if (!layer) return;
      for (const type of ALL_EVENT) {
        const list = layer[type];
        if (!Array.isArray(list)) continue;
        for (const event of list) {
          eventCounts[type] += 1;
          const startBeat = event?.startTime;
          if (startBeat != null) eventTimes[type].push(tempo.seconds(startBeat, factor));
          const start = Number(event?.start);
          if (Number.isFinite(start)) {
            const current = eventRanges[type];
            eventRanges[type] = current ? { min: Math.min(current.min, start), max: Math.max(current.max, start) } : { min: start, max: start };
          }
        }
      }
    };
    for (const layer of (line.eventLayers ?? [])) collect(layer);
    collect(line.extended);
  }
  metrics.events = ALL_EVENT.map((type, index) => ({
    type,
    label: EVENT_LABELS[type] ?? type.replace('Events', ''),
    value: eventCounts[type] ?? 0,
    color: METRIC_PALETTE[index % METRIC_PALETTE.length],
  }));
  metrics.eventTimes = eventTimes;
  metrics.eventRanges = eventRanges;

  metrics.holdCount = holdLengths.length;
  metrics.holdAvg = average(holdLengths);
  metrics.holdBins = holdLengths.length ? buildBins(holdLengths, 40, Math.max(0.1, ...holdLengths)) : null;

  return metrics;
}

// Turn the structured metrics into the compact, prompt-friendly text shape the
// AI workflow uses (localized labels are supplied by the caller via `t`).
export function formatMetricsForPrompt(m, { t }) {
  const groupText = m.groups.map(s => `${s.label}×${s.value}`).join('，');
  const fatherText = m.fathers.map(s => `${s.label}×${s.value}`).join('，');
  const eventCountsText = m.events.map(e => `${e.label} ${e.value}`).join('，');
  const eventRangeText = m.events.filter(e => m.eventRanges[e.type]).map(e => `${e.label} ${m.eventRanges[e.type].min}..${m.eventRanges[e.type].max}`).join('，');
  const speedDist = distributionText(m.speedDist.map(r => Number(r.label)));
  const sizeDist = distributionText(m.sizeDist.map(r => Number(r.label)));
  return {
    totalNotes: m.totalNotes,
    lineCount: m.lineCount,
    duration: m.duration,
    bpmMin: m.bpmMin,
    bpmMax: m.bpmMax,
    typeCounts: m.typeCounts,
    above: m.above,
    below: m.below,
    fake: m.fake,
    colored: m.colored,
    speedDist,
    sizeDist,
    alphaTransparent: m.alphaTransparent,
    posX: m.posX,
    posYCount: m.posYCount,
    holdCount: m.holdCount,
    holdAvg: m.holdAvg,
    intervalCount: m.intervalCount,
    intervalMedian: m.intervalMedian,
    intervalMax: m.intervalMax,
    offsetBins: m.offsetBins,
    perLineNotes: m.perLineNotes,
    perLineEvents: m.perLineEvents,
    groupText,
    fatherText,
    eventCountsText,
    eventRangeText,
  };
}

// ---------------------------------------------------------------------------
// Compact insight payloads
//
// Raw density / cumulative / position series are 80-400 numbers each. Sending
// them verbatim wastes most of the model context on data it only needs
// qualitatively. Fold long numeric series into 16 buckets + quantiles; the
// agent can pass full=true to chart_insights when it needs an exact array.
// ---------------------------------------------------------------------------

export function seriesDigest(values) {
  const numbers = values.map(value => Number(value) || 0);
  const count = numbers.length;
  const sorted = [...numbers].sort((a, b) => a - b);
  const q = p => Number((sorted[Math.min(count - 1, Math.max(0, Math.floor(p * (count - 1))))] ?? 0).toFixed(3));
  const bucketCount = 12, buckets = new Array(bucketCount).fill(0);
  for (let index = 0; index < count; index++) buckets[Math.min(bucketCount - 1, Math.floor(index * bucketCount / count))] += numbers[index];
  const maximum = Math.max(...numbers);
  return {
    len: count, min: q(0), max: q(1), mean: Number((numbers.reduce((sum, value) => sum + value, 0) / (count || 1)).toFixed(3)),
    p50: q(0.5), p95: q(0.95), peakIndex: numbers.indexOf(maximum),
    buckets: buckets.map(value => Number(value.toFixed(2))),
    _hint: 'full=true',
  };
}

export function compactChartInsights(value) {
  const seen = new WeakSet();
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'string' && node.length > 240) return node.slice(0, 200) + '…';
      return node;
    }
    if (seen.has(node)) return '[circular]';
    if (depth > 8) return Array.isArray(node) ? `[${node.length} items]` : '{…}';
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length > 24 && node.every(item => typeof item === 'number')) return seriesDigest(node);
      if (node.length > 24) {
        if (Array.isArray(node[0])) return { len: node.length, rows: node.slice(0, 4).map(row => seriesDigest(row)), _hint: 'full=true' };
        return { len: node.length, head: node.slice(0, 8).map(item => walk(item, depth + 1)), _hint: 'full=true' };
      }
      return node.map(item => walk(item, depth + 1));
    }
    const out = {};
    for (const [key, entry] of Object.entries(node)) out[key] = walk(entry, depth + 1);
    return out;
  };
  return walk(value, 0);
}
