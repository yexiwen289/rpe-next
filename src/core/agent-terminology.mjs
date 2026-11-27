// AI 指令术语自动识别：命中时把精简定义附到指令末尾，避免模型误解社区黑话。
// 完整版见 protocols/ADVANCED-CHART-TECHNIQUES.zh-CN.md。
export const AGENT_TERMS = Object.freeze({
  '无判定线': '判定线不显示；用下落方向相反、X 相同的一对音符确定落点，可旋转隐藏判定线。',
  '零速音符': '音符不动，判定线主动移动到音符上判定。',
  '移位': '判定线沿自身延伸方向平移；视觉上线不动，但音符落点改变。',
  '仁王盾': '并排高密纵联，至多 5 排，最好 3 排。',
  '快慢刀': '判定线下落速度波动（非匀速）。',
  '垂判': '在音符落点做判定线的垂线，点击垂线上任意一点均可判定；强制垂判时可遮挡判定线。',
  '锁手': '超长条锁住手，至多 5 个即强迫单手。',
  '天地': '上下各有判定线，或左右下落方向相反。',
  '倒打': '判定线翻转，置于上半屏，音符自下而上落入。',
  '侧判': '垂直判定线，音符从左右落向竖线。',
  '四合院': '上下左右均有判定线；用垂判压制两条虚打线，另两条用红区遮挡。慎用。',
  '纵连': '同一位置连续单键音符，按时间顺序击打。',
  '噪域': 'blockAreaList 定义的区域判定机制，与透明度隐藏无关。',
  '红区': '噪域的一种，覆盖区域后该处判定线不可见/不可直接击打。',
  '初见杀': '首次游玩时因反直觉设计导致的失误，复玩后不再构成难点。',
  '采音': '按音频打击点/节奏铺谱的方法。',
});

export function augmentInstruction(text) {
  const source = String(text ?? '');
  if (source.includes('【术语定义（自动识别')) return source;
  const matched = Object.entries(AGENT_TERMS).filter(([term]) => source.includes(term));
  if (!matched.length) return source;
  return source + '\n\n【术语定义（自动识别，按 VibePhi 高级知识库）】\n' + matched.map(([term, definition]) => `- ${term}：${definition}`).join('\n');
}
