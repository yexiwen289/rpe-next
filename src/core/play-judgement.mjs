/**
 * 试玩判定：键盘任意键判定。
 *
 * 规则：
 *   - Tap / Flick：按下瞬间落在判定窗口内即完成。
 *   - Drag（滑键）：按住即可判定——按住期间经过判定时刻即算完成，无需精确按键。
 *   - Hold（长条）：按下瞬间落在窗口内即判定头部，按住到尾即完成；中途松手则断连。
 *   - 任意一个键都能触发判定，不区分按键与判定线的对应关系。
 */

export const JUDGE_WINDOWS = Object.freeze({ perfect: 0.08, good: 0.16 });

const NOTE_TYPE = { tap: 1, hold: 2, flick: 3, drag: 4 };

/** 收集谱面里所有参与判定的音符（跳过假音符）。 */
export function collectJudgeNotes(chart, tempo) {
  const notes = [];
  for (const [lineIndex, line] of (chart?.judgeLineList ?? []).entries()) {
    const factor = line?.bpmfactor ?? 1;
    for (const [noteIndex, note] of (line?.notes ?? []).entries()) {
      if (note?.isFake === 1 || note?.isFake === true) continue;
      const start = tempo.seconds(note.startTime, factor);
      const end = note.type === NOTE_TYPE.hold ? tempo.seconds(note.endTime, factor) : start;
      notes.push({
        id: `${lineIndex}:${noteIndex}`, lineIndex, noteIndex, note,
        type: note.type ?? NOTE_TYPE.tap, start, end,
        status: 'pending', judgement: null, holdKey: null,
      });
    }
  }
  notes.sort((left, right) => left.start - right.start);
  return notes;
}

export function createJudgeState(chart, tempo, windows = JUDGE_WINDOWS, options = {}) {
  return {
    notes: collectJudgeNotes(chart, tempo),
    windows: { ...windows },
    held: new Set(),
    combo: 0, maxCombo: 0,
    counts: { perfect: 0, good: 0, miss: 0 },
    lastJudgement: null,
    onJudge: options?.onJudge,
  };
}

const judgementOf = (delta, windows) => {
  const abs = Math.abs(delta);
  if (abs <= windows.perfect) return 'perfect';
  if (abs <= windows.good) return 'good';
  return null;
};

const complete = (state, entry, judgement, seconds) => {
  entry.status = 'done';
  entry.judgement = judgement;
  entry.holdKey = null;
  state.counts[judgement] = (state.counts[judgement] ?? 0) + 1;
  state.combo += 1;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  state.lastJudgement = { judgement, at: entry.start, combo: state.combo };
  state.onJudge?.(entry, judgement, seconds);
};

const miss = (state, entry) => {
  entry.status = 'miss';
  entry.judgement = 'miss';
  entry.holdKey = null;
  state.counts.miss += 1;
  state.combo = 0;
  state.lastJudgement = { judgement: 'miss', at: entry.start, combo: 0 };
};

/**
 * 按下任意键：判定所有落在窗口内的音符。
 * Drag 由按住状态在 update 中补判，因此这里只处理按压类（Tap/Flick/Hold 头）。
 */
export function pressJudge(state, seconds, key = 'any') {
  if (!state) return null;
  state.held.add(key);
  let judged = 0;
  for (const entry of state.notes) {
    if (entry.status !== 'pending') continue;
    const judgement = judgementOf(seconds - entry.start, state.windows);
    if (!judgement) continue;
    if (entry.type === NOTE_TYPE.hold) {
      entry.status = 'holding';
      entry.holdKey = key;
      entry.judgement = judgement;
      judged += 1;
      continue;
    }
    complete(state, entry, judgement, seconds);
    judged += 1;
  }
  return judged;
}

/** 松开按键：持有的 Hold 到尾则完成，否则断连。 */
export function releaseJudge(state, seconds, key = 'any') {
  if (!state) return null;
  state.held.delete(key);
  let judged = 0;
  for (const entry of state.notes) {
    if (entry.status !== 'holding' || entry.holdKey !== key) continue;
    if (seconds >= entry.end - 1e-6) complete(state, entry, entry.judgement ?? 'good', seconds);
    else miss(state, entry);
    judged += 1;
  }
  return judged;
}

/**
 * 推进时间：处理 Drag 的按住判定、Hold 的自动完成、以及超时未按的 Miss。
 */
export function updateJudge(state, seconds) {
  if (!state) return null;
  const heldCount = state.held.size;
  let judged = 0;
  for (const entry of state.notes) {
    if (entry.status === 'pending') {
      const judgement = judgementOf(seconds - entry.start, state.windows);
      if (judgement && entry.type === NOTE_TYPE.drag && heldCount > 0) {
        complete(state, entry, judgement);
        judged += 1;
        continue;
      }
      if (seconds > entry.start + state.windows.good) {
        miss(state, entry);
        judged += 1;
      }
      continue;
    }
    if (entry.status === 'holding' && seconds >= entry.end - 1e-6) {
      complete(state, entry, entry.judgement ?? 'good', seconds);
      judged += 1;
    }
  }
  return judged;
}

/** 试玩结算数据。 */
export function judgeSummary(state) {
  const total = state?.notes?.length ?? 0;
  const judged = (state?.counts?.perfect ?? 0) + (state?.counts?.good ?? 0);
  return {
    total,
    judged,
    combo: state?.combo ?? 0,
    maxCombo: state?.maxCombo ?? 0,
    counts: { ...(state?.counts ?? { perfect: 0, good: 0, miss: 0 }) },
    accuracy: total ? judged / total : 0,
    score: total ? Math.round(1000000 * judged / total) : 0,
  };
}

/** 判断某个音符当前是否仍需绘制（已完成的音符不再显示）。 */
export function noteVisible(entry) {
  return entry?.status !== 'done' && entry?.status !== 'miss';
}

/** 判定中的 Hold 是否应绘制剩余部分（未到尾部时仍需显示）。 */
export function holdRemaining(entry, seconds) {
  if (!entry || entry.type !== NOTE_TYPE.hold) return 0;
  if (entry.status === 'done') return 0;
  return Math.max(0, entry.end - seconds);
}
