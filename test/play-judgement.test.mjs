import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgeState, pressJudge, releaseJudge, updateJudge, judgeSummary } from '../src/core/play-judgement.mjs';

const tempo = { seconds: beat => beat[0] + (beat[1] ?? 0) / (beat[2] ?? 1) };

const chartOf = notes => ({
  judgeLineList: [{
    bpmfactor: 1, notes: notes.map(note => ({
      type: note.type ?? 1, startTime: [note.start, 0, 1], endTime: [note.end ?? note.start, 0, 1],
      positionX: 0, isFake: 0,
    })),
  }],
});

test('任意键在窗口内按下即可判定 Tap，并累计连击', () => {
  const state = createJudgeState(chartOf([{ start: 10 }, { start: 11 }]), tempo);
  assert.equal(pressJudge(state, 10.02, 'KeyA'), 1);
  assert.equal(state.combo, 1);
  assert.equal(state.counts.perfect, 1);
  pressJudge(state, 11.05, 'KeyA');
  assert.equal(state.combo, 2);
  assert.equal(state.maxCombo, 2);
});

test('窗口外的按键不判定，音符超时后计 Miss 并断连击', () => {
  const state = createJudgeState(chartOf([{ start: 10 }, { start: 12 }]), tempo);
  pressJudge(state, 10.02, 'KeyA');
  assert.equal(state.combo, 1);
  assert.equal(pressJudge(state, 11.5, 'KeyA'), 0, '窗口外不判定');  // 距 12 拍 0.5 秒 > good 窗口 0.16
  updateJudge(state, 12.5);
  assert.equal(state.counts.miss, 1);
  assert.equal(state.combo, 0);
});

test('Drag 按住即可判定，无需精确按下时刻', () => {
  const state = createJudgeState(chartOf([{ start: 10, type: 4 }]), tempo);
  pressJudge(state, 9.0, 'KeyZ');           // 远早于判定时刻按住
  assert.equal(state.notes[0].status, 'pending');
  updateJudge(state, 10.01);                 // 按住期间经过判定时刻
  assert.equal(state.notes[0].status, 'done');
  assert.equal(state.counts.perfect + state.counts.good, 1);
});

test('Drag 未按住时超时计 Miss', () => {
  const state = createJudgeState(chartOf([{ start: 10, type: 4 }]), tempo);
  updateJudge(state, 10.2);
  assert.equal(state.counts.miss, 1);
});

test('Hold 按住到尾即完成，中途松手则断连', () => {
  const held = createJudgeState(chartOf([{ start: 10, end: 12, type: 2 }]), tempo);
  pressJudge(held, 10.0, 'KeyX');
  assert.equal(held.notes[0].status, 'holding');
  updateJudge(held, 12.0);
  assert.equal(held.notes[0].status, 'done');
  assert.equal(held.counts.miss, 0);

  const broken = createJudgeState(chartOf([{ start: 10, end: 12, type: 2 }]), tempo);
  pressJudge(broken, 10.0, 'KeyX');
  releaseJudge(broken, 11.0, 'KeyX');
  assert.equal(broken.notes[0].status, 'miss');
  assert.equal(broken.counts.miss, 1);
});

test('多个键时 Hold 由最先按下的键持有', () => {
  const state = createJudgeState(chartOf([{ start: 10, end: 12, type: 2 }]), tempo);
  pressJudge(state, 10.0, 'KeyA');
  pressJudge(state, 10.1, 'KeyB');
  releaseJudge(state, 11.0, 'KeyB');   // 松开非持有键，不影响
  assert.equal(state.notes[0].status, 'holding');
  releaseJudge(state, 12.1, 'KeyA');   // 松开持有键且已到尾 -> 完成
  assert.equal(state.notes[0].status, 'done');
});

test('假音符不参与判定', () => {
  const chart = chartOf([{ start: 10 }]);
  chart.judgeLineList[0].notes[0].isFake = 1;
  const state = createJudgeState(chart, tempo);
  assert.equal(state.notes.length, 0);
  assert.equal(judgeSummary(state).total, 0);
});

test('结算数据反映完成比例与得分', () => {
  const state = createJudgeState(chartOf([{ start: 10 }, { start: 20 }]), tempo);
  pressJudge(state, 10.0, 'KeyA');
  const summary = judgeSummary(state);
  assert.equal(summary.total, 2);
  assert.equal(summary.judged, 1);
  assert.equal(summary.score, 500000);
  assert.equal(summary.accuracy, 0.5);
});
