// 人类极限试玩：不按真实按键，而是按人体工学约束估算谱面能否用手打过来。
// 结果同时用于界面报告和 AI 反馈，不做谱面修改。

const clampNumber = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const beatValue = beat => Array.isArray(beat) ? Number(beat[0] ?? 0) + Number(beat[1] ?? 0) / Number(beat[2] || 1) : Number(beat ?? 0);

export function analyzeHumanLimits(chart, tempo) {
  if (!chart || !tempo || !Array.isArray(chart.judgeLineList)) throw Error('谱面或节拍映射无效');
  const notes = [];
  chart.judgeLineList.forEach((line, lineIndex) => {
    const factor = clampNumber(line.bpmfactor, 1) || 1;
    for (const note of line.notes ?? []) {
      const at = tempo.seconds(beatValue(note.startTime), factor);
      const end = note.type === 2 ? tempo.seconds(beatValue(note.endTime), factor) : at;
      notes.push({ lineIndex, at, end: Math.max(at, end), x: clampNumber(note.positionX), type: note.type, fake: Boolean(note.isFake) });
    }
  });
  notes.sort((a, b) => a.at - b.at || a.x - b.x);
  const real = notes.filter(note => !note.fake);
  const violations = [];
  const add = (level, code, message, detail) => violations.push({ level, code, message, ...detail });
  const sec = value => `${Number(value.toFixed(2))}s`;

  // 1. 单点并发：40ms 窗口内超过两只手的击打数。
  let windowStart = 0;
  for (let end = 0; end < real.length; end++) {
    while (real[end].at - real[windowStart].at > .04) windowStart++;
    const count = end - windowStart + 1;
    if (count > 10) { add('fatal', 'burst', `同一瞬间 ${count} 个音符，双手无法覆盖`, { at: sec(real[windowStart].at), count }); break; }
    if (count > 6 && !violations.some(v => v.code === 'dense')) add('hard', 'dense', `40ms 内 ${count} 连击，接近双手极限`, { at: sec(real[windowStart].at), count });
  }

  // 2. 最小间隔与逐秒密度。
  let minGap = Infinity, minGapAt = 0;
  for (let i = 1; i < real.length; i++) {
    const gap = real[i].at - real[i - 1].at;
    if (gap < minGap) { minGap = gap; minGapAt = real[i].at; }
  }
  if (minGap < .025) add('fatal', 'gap', `音符间隔仅 ${(minGap * 1000).toFixed(1)}ms，低于人类按键响应`, { at: sec(minGapAt), gapMs: Number((minGap * 1000).toFixed(1)) });
  const buckets = new Map();
  for (const note of real) { const key = Math.floor(note.at); buckets.set(key, (buckets.get(key) ?? 0) + 1); }
  for (const [second, count] of buckets) if (count > 16) { add('fatal', 'density', `第 ${second}s 每秒 ${count} 键，超出双手极限`, { at: sec(second), count }); break; }
  else if (count > 12 && !violations.some(v => v.code === 'highDensity')) add('hard', 'highDensity', `第 ${second}s 每秒 ${count} 键，密度很高`, { at: sec(second), count });

  // 3. 长条锁手：同一时刻超过 4 个长条 = 强制多手锁死。
  const holds = real.filter(note => note.type === 2 && note.end - note.at > .15);
  const holdEvents = holds.flatMap(note => [{ time: note.at, delta: 1 }, { time: note.end, delta: -1 }]).sort((a, b) => a.time - b.time);
  let held = 0, peakHold = 0, peakHoldAt = 0;
  for (const event of holdEvents) { held += event.delta; if (held > peakHold) { peakHold = held; peakHoldAt = event.time; } }
  if (peakHold > 4) add('fatal', 'holds', `同时 ${peakHold} 条长条锁手，手指不够用`, { at: sec(peakHoldAt), count: peakHold });

  // 4. 跨手跳跃：短时间内同一侧手部需要横跨大半屏。
  const left = real.filter(note => note.x <= 0);
  const right = real.filter(note => note.x > 0);
  for (const [name, side] of [['左手', left], ['右手', right]]) {
    let worst = null;
    for (let i = 1; i < side.length; i++) {
      const dx = Math.abs(side[i].x - side[i - 1].x), gap = side[i].at - side[i - 1].at;
      if (gap <= .12 && dx >= 1.2 && (!worst || dx > worst.dx)) worst = { dx, gap, at: side[i].at };
    }
    if (worst) add('hard', 'jump', `${name}在 ${sec(worst.gap)} 内横跨 ${worst.dx.toFixed(2)} 屏幕宽度`, { at: sec(worst.at), dx: Number(worst.dx.toFixed(2)), gapMs: Number((worst.gap * 1000).toFixed(1)) });
  }

  // 5. 长时间持续无休：超过 12s 且每秒 >8 键。
  let runStart = null, longest = 0;
  for (const [second, count] of [...buckets].sort((a, b) => a[0] - b[0])) {
    if (count > 8) { runStart ??= second; longest = Math.max(longest, second - runStart + 1); }
    else runStart = null;
  }
  if (longest >= 12) add('hard', 'stamina', `连续 ${longest}s 保持高密度，体力难以维持`, { seconds: longest });

  const fatal = violations.filter(v => v.level === 'fatal').length;
  const hard = violations.filter(v => v.level === 'hard').length;
  const verdict = fatal ? 'unplayable' : hard ? 'borderline' : 'playable';
  return {
    verdict,
    verdictText: { playable: '可打：未发现明显超出人类极限的配置', borderline: '勉强可打：存在高压段落，需要微调', unplayable: '打不过来：存在超出人类极限的配置' }[verdict],
    stats: {
      notes: real.length, fakeNotes: notes.length - real.length, lines: chart.judgeLineList.length,
      minGapMs: Number.isFinite(minGap) ? Number((minGap * 1000).toFixed(1)) : null,
      peakPerSecond: Math.max(0, ...buckets.values()), peakHold, longestDenseSeconds: longest,
    },
    violations,
  };
}

export function humanLimitsFeedback(report, chart) {
  const lines = [
    `【人类极限测试结果】${report.verdictText}`,
    `统计：音符 ${report.stats.notes} / 判定线 ${report.stats.lines} / 最小间隔 ${report.stats.minGapMs ?? '—'}ms / 峰值 ${report.stats.peakPerSecond} 键每秒 / 同时长条 ${report.stats.peakHold} / 持续高密度 ${report.stats.longestDenseSeconds}s`,
  ];
  if (report.violations.length) lines.push('问题清单：', ...report.violations.map(v => `- [${v.level === 'fatal' ? '致命' : '高压'}] ${v.message}（${v.at ?? `${v.seconds}s`}）`));
  lines.push('请在不破坏设计意图的前提下降低不可打性，并说明调整理由。');
  return lines.join('\n');
}
