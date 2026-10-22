// 从原始对话（raw/*.jsonl）里"努力想起来一点"。
//
// 为什么要有这一层：diary 是压扁的摘要（2~6 条、每条 30 字），细节在入库那一刻就没了。
// raw 里存着每天的原话，一直没人读过。所以命中日记之后，可以回 raw 里再捞一次。
//
// 但这一层必须被"遗忘"管住，否则它就是个数据库：
//   · 概率衰减 —— 越久越可能想起来不想来，而且你猜不到这次是哪种（不可预测才像人）
//   · 细节衰减 —— 想起来的东西越久越少：先丢细节，梗概留得久
//   · 追问触发 —— 只有用户追问（"后来呢"）才去翻，不给它主动翻旧账的机会
//
// 概率用的是艾宾浩斯的形状，但整体上抬了：艾宾浩斯测的是"无提示的自由回忆"，
// 而这里用户已经先提了关键词，属于有线索的回忆，保持率本来就高得多。

// [下界天数, 概率]
const CURVE = [
  [1, 0.98],
  [3, 0.9],
  [7, 0.78],
  [14, 0.62],
  [30, 0.42],
  [60, 0.28],
  [Infinity, 0.15],
];

// 重要的事记得更牢：日记的级别就当作"重要程度"
const KIND_ADJ = { 重点: 1.25, 日常: 1.0, 简记: 0.85 };

// 想起来多少字：先丢细节，梗概留得久
const DETAIL = [
  [3, 150],
  [14, 90],
  [30, 50],
  [Infinity, 24],
];

function forgetProb(days, kind) {
  const d = Math.max(0, Number(days) || 0);
  let base = CURVE[CURVE.length - 1][1];
  for (const [limit, p] of CURVE) {
    if (d < limit) {
      base = p;
      break;
    }
  }
  const adj = KIND_ADJ[kind] == null ? 1 : KIND_ADJ[kind];
  return Math.min(0.99, Math.max(0, base * adj));
}

function detailChars(days) {
  const d = Math.max(0, Number(days) || 0);
  for (const [limit, n] of DETAIL) if (d < limit) return n;
  return DETAIL[DETAIL.length - 1][1];
}

// 追问词：这些是"接着往下听"的信号，不是"提到旧事"的信号。
// 只在短句里成立 —— "后来我就走了，路上还遇到…" 不是追问，"后来呢" 是。
const CUES = ['后来', '然后呢', '那后来', '继续', '接着', '讲完', '说完', '结果呢', '下文', '再然后'];
const CUE_MAX_LEN = 18;

function wantsExpand(text) {
  const t = String(text || '').trim();
  if (!t || t.length > CUE_MAX_LEN) return false;
  return CUES.some((w) => t.includes(w));
}

// 在一天的原话里找出"最像那件事"的一轮，取它前后各一轮。
// 只返回文本段，不返回结构体 —— 调用方要的是一段能塞进提示词的话。
function pickAround(rounds, segs, maxChars) {
  if (!Array.isArray(rounds) || !rounds.length) return null;
  if (!Array.isArray(segs) || !segs.length) return null;
  let best = -1;
  let bestScore = 0;
  rounds.forEach((r, i) => {
    const hay = String(r.user || '') + ' ' + String(r.reply || '');
    let score = 0;
    for (const s of segs) if (s && hay.includes(s)) score += s.length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best < 0) return null;

  const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  // 从命中那一轮往外扩，直到字数用完：先拿命中轮，再拿前一轮，再拿后一轮。
  // 命中轮本身一定要在（否则捞回来的是别的片段）。
  const budget = Math.max(12, Number(maxChars) || 60);
  const out = [];
  let used = 0;
  const add = (i, tag) => {
    if (i < 0 || i >= rounds.length) return;
    const r = rounds[i];
    let s = '· ' + tag + '用户：' + clip(r.user, 60);
    const room = budget - used;
    if (room < 8) return;
    if (s.length > room) s = s.slice(0, room) + '…';
    out.push(s);
    used += s.length;
    // 它当时回的半句：让"讲到一半"的语境能接上，但要更短
    const room2 = budget - used;
    if (room2 >= 12) {
      let r2 = '  / 你：' + clip(r.reply, 40);
      if (r2.length > room2) r2 = r2.slice(0, room2) + '…';
      out.push(r2);
      used += r2.length;
    }
  };
  add(best, '');
  if (used < budget * 0.7) add(best - 1, '（前面）');
  if (used < budget * 0.7) add(best + 1, '（后面）');
  return out.join('\n');
}

function daysBetween(fromDate, toDate) {
  const a = new Date(fromDate);
  const b = new Date(toDate);
  if (isNaN(a) || isNaN(b)) return 0;
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / 86400000);
}

module.exports = { forgetProb, detailChars, wantsExpand, pickAround, daysBetween, CURVE, DETAIL, CUES };
