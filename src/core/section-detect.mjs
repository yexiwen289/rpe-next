// 基于全曲 DDC salience / 波形能量的段落边界检测。
// 输入是按时间顺序的 {seconds, energy} 样本，输出谱面 markers（秒 + 名称）。

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 从能量序列检测段落边界。
 * 做法：平滑 → 计算滑动窗口均值对比 → 在能量突变点（drop / break）切分，
 * 同时保证每段最短时长（避免过碎）。返回一个 markers 数组 [{time,name}]。
 */
export function detectSections(samples, options = {}) {
  const minGap = Math.max(2, Number(options.minGap) || 8);      // 段最短秒数
  const threshold = Number(options.threshold) || 1.45;          // 突变倍率阈值
  const windowSec = Math.max(1, Number(options.windowSec) || 2); // 对比窗口
  if (!Array.isArray(samples) || samples.length < 4) return [];
  const pts = samples
    .map(p => ({ seconds: Number(p?.seconds), energy: Math.max(0, Number(p?.energy) || 0) }))
    .filter(p => Number.isFinite(p.seconds) && Number.isFinite(p.energy))
    .sort((a, b) => a.seconds - b.seconds);
  if (pts.length < 4) return [];

  // 平滑（3 点滑动平均）
  const smooth = pts.map((p, i) => {
    const lo = Math.max(0, i - 1), hi = Math.min(pts.length - 1, i + 1);
    let sum = 0; for (let j = lo; j <= hi; j++) sum += pts[j].energy;
    return { seconds: p.seconds, energy: sum / (hi - lo + 1) };
  });
  const duration = smooth.at(-1).seconds - smooth[0].seconds;
  if (duration < minGap * 2) return [];

  // 逐点比较前后 windowSec 窗口均值，找突变点
  const scoreAt = index => {
    const t = smooth[index].seconds;
    let before = 0, beforeN = 0, after = 0, afterN = 0;
    for (let i = 0; i < smooth.length; i++) {
      const dt = smooth[i].seconds - t;
      if (dt >= -windowSec && dt < 0) { before += smooth[i].energy; beforeN++; }
      else if (dt > 0 && dt <= windowSec) { after += smooth[i].energy; afterN++; }
    }
    if (!beforeN || !afterN) return { ratio: 1, dir: 0 };
    const b = before / beforeN, a = after / afterN;
    const base = Math.max(0.02, Math.min(b, a));
    return { ratio: Math.max(b, a) / base, dir: a > b ? 1 : -1 };
  };

  const marks = [{ time: smooth[0].seconds, name: '前奏 / 起始' }];
  let lastTime = smooth[0].seconds;
  for (let i = 1; i < smooth.length - 1; i++) {
    const t = smooth[i].seconds;
    if (t - lastTime < minGap) continue;
    const { ratio, dir } = scoreAt(i);
    if (ratio < threshold) continue;
    marks.push({ time: t, name: dir > 0 ? '段落进入（能量上升）' : '段落回落（能量下降）' });
    lastTime = t;
  }
  // 保证末尾有一个尾段标记
  if (smooth.at(-1).seconds - lastTime >= minGap * .6) marks.push({ time: smooth.at(-1).seconds, name: '尾段 / 结束' });
  return marks.slice(0, 60);
}

/** 从 AudioOnsets.fullScan 的 segments 里抽取能量序列（按 salience 帧能耗）。 */
export function energyFromFullScan(entry, stepSeconds = 0.25) {
  if (!entry?.segments?.length) return [];
  const out = [];
  for (const segment of entry.segments) {
    const raw = segment.raw;
    if (!raw?.salience || !raw.frameRate) continue;
    const fps = Number(raw.frameRate) || 100;
    const stride = Math.max(1, Math.round(fps * stepSeconds));
    for (let i = 0; i < raw.salience.length; i += stride) {
      let sum = 0, n = 0;
      for (let j = i; j < Math.min(raw.salience.length, i + stride); j++) { sum += Number(raw.salience[j]) || 0; n++; }
      out.push({ seconds: (raw.startSeconds ?? 0) + i / fps, energy: n ? sum / n : 0 });
    }
  }
  return out;
}
