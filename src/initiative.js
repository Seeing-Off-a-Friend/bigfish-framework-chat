'use strict';
/**
 * 主动开口：什么时候、要不要、说什么。
 *
 * 这一层只负责三件事，**不碰任何显示**（没有窗口、没有动画、没有桌面）：
 *   1. 判断现在该不该开口（在场 + 频率 + 额度 + 静默时段）
 *   2. 生成那句话（交给调用方去显示）
 *   3. 记住自己说过什么，用来判断"对方这句到底有没有接我刚才那句"
 *
 * 第 3 条是整个模块的重点。少了它，主动开口就只是"定时弹一句话"，
 * 对方理不理它都一样 —— 那不像人，像一个通知推送。
 */

const fs = require('node:fs');
const path = require('node:path');

// DeepSeek 的高峰时段：工作日 9:00-12:00 / 14:00-18:00，单价翻倍。
// 保留这个常量只是为了 state() 能报出来（成本透明度），不再限制主动开口的时间。
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
];

const DEFAULTS = {
  enabled: true,
  speakGapMin: 90, // 两次主动开口最少隔多久（分钟），实际在 min~max 之间随机
  speakGapMax: 180,
  speakPerDay: 6,
  speakTokens: 90,
  // 静默时段：这段时间里完全不主动（默认 0 点到 6 点）。
  // 起止设成相同 = 不设静默；支持跨零点（如 23 → 6）。
  quietStart: 0,
  quietEnd: 6,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function hhmm(d) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// 静默时段（默认 0:00~6:00）：这段时间不主动说话。
// 跨零点也支持（比如 23 → 6：23 点之后到次日 6 点都静默）。
function inQuietHours(now, start, end) {
  const a = Number.isFinite(start) ? start : DEFAULTS.quietStart;
  const b = Number.isFinite(end) ? end : DEFAULTS.quietEnd;
  if (a === b) return false;
  const h = new Date(now).getHours();
  return a < b ? h >= a && h < b : h >= a || h < b;
}

// 只用于 state() 里报"现在是不是高峰价"，不参与任何开关判断。
function isPeak(now) {
  const d = new Date(now);
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const h = d.getHours() + d.getMinutes() / 60;
  return PEAK_HOURS.some(([a, b]) => h >= a && h < b);
}

// 时间给到「10月25日周日 19:06」这个精度，和聊天那条线一样。
// 原来这里只有「晚上」这种粗档 —— 实测模型把 19:00 和 23:00 当成一回事，
// 七点就催人睡觉，还得主人自己说一句「才七点」。人看一眼钟就知道的事，它也该知道。
function timeLine(d) {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return '现在是' + (d.getMonth() + 1) + '月' + d.getDate() + '日' + week + ' ' + hhmm(d) + '。';
}

function num(v, def, lo, hi) {
  if (v === '' || v === null || v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

// ---------- "对方这句是不是在接我刚才那句" ----------
// 以前只按时间判：它说完 30 分钟内对方说了话，就当被接住了。
// 结果对方随口聊别的（"我今天考试没过"），它也会当成"他理我了"，赌气被清零、还松一口气——自作多情。
// 现在要内容对得上才算，判据三条（都在本地跑，不花钱）：
//   1) 明着指回刚才那几句：你刚才 / 你说的 / 你又说 / 听见没 / 那张纸 …
//   2) 短接话：嗯 / 哦 / 对 / 真的吗 / 然后呢 —— 且必须是刚说完那几分钟
//   3) 字面有共同话题：2 字词交集（滤掉"现在/就是/什么"这类空词）
// 三条都不中 = 没接。宁可漏判（少给一次好脸色），也别把"他在说别的"算成"他在理我"。
const REPLY_CUE =
  /(你(刚才|刚刚|上回|上次|之前)|刚才(你|说)|你说的|你说啥|你说什么|你又说|你又来|你倒是|听见没|听到没|听见了吗|听到了吗|看到没|看到了吗|看见没|你写的|你留的)/;

const SHORT_CUE =
  /^(嗯+|哦+|喔+|呃|啊+|哈+|呵+|嘿+|嗷|好吧?|行吧?|行|对|是|是的|是啊|对呀|嗯嗯|真的|真的吗|是吗|这样啊|然后呢?|怎么呢?|怎么了|为啥|为什么|谁|啥|什么|你说|继续|还有呢?|不会吧|骗人|才不|不要|走开|讨厌|烦|闭嘴|滚|过分|过分了|好过分|我不|我不管)$/;

// 虚字：由这类字组成的 2 字词不算"共同话题"（"你了""的呀"这种）
const FILLER_CHARS = new Set(
  '的了着过吗呢吧啊呀哈嗯哦呃嘛啦是我你他她它在有就不都很也还要这那哪个些和与及或但而如果为没会能可把被给让对从到'.split(''),
);
// 空词表：两边都出现也不代表在聊同一件事
const FILLER_GRAMS = new Set([
  '现在', '知道', '没有', '可以', '这个', '那个', '时候', '觉得', '如果', '因为',
  '所以', '然后', '还是', '就是', '不是', '什么', '怎么', '我们', '他们', '你们',
  '自己', '一个', '这样', '那样', '真的', '有点', '东西', '事情', '一下', '出来',
  '起来', '回来', '过来', '其实', '应该', '可能', '但是', '而且', '于是', '已经',
  '一直', '总是', '每次', '要不', '好了', '行吧', '对吧', '是啊', '说话', '说过',
]);

/** 把一句话拆成 2 字词集合（去掉标点空白，滤掉虚词组合）。 */
function grams(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) {
    const g = t.slice(i, i + 2);
    if (FILLER_GRAMS.has(g)) continue;
    if (FILLER_CHARS.has(g[0]) && FILLER_CHARS.has(g[1])) continue;
    out.add(g);
  }
  return out;
}

/**
 * msg 是不是在接 said 那句。
 * ageMs = 它那句是多久以前说的；短接话（"嗯""对"）只在小窗口内才认。
 */
function isReplyTo(msg, said, ageMs) {
  const m = String(msg || '').trim();
  const s = String(said || '').trim();
  if (!m || !s) return false;
  const age = Number(ageMs) > 0 ? Number(ageMs) : 0;

  if (REPLY_CUE.test(m)) return true;

  const bare = m.replace(/[\s\p{P}\p{S}]/gu, '');
  if (bare.length <= 8 && age <= 5 * 60000 && SHORT_CUE.test(bare)) return true;

  const a = grams(m);
  const b = grams(s);
  for (const g of a) if (b.has(g)) return true;
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.dir        状态文件放哪（一般就是 dataDir）
 * @param {object} opts.cfg        归一化后的配置
 * @param {string} opts.persona    人设（作为系统提示前缀，能吃到缓存）
 * @param {function} opts.complete async (messages, overrides) => { ok, reply, message }
 * @param {function} [opts.isHere] () => boolean  —— 不注入就一律当成在
 * @param {function} [opts.idleSec] () => number  —— 对方多久没动了（秒）
 * @param {function} [opts.onSay]  (text) => void —— 说出去了，交给调用方显示
 * @param {function} [opts.record] (entry) => void —— 落档（可选）
 * @param {function} [opts.now]    () => number
 * @param {function} [opts.log]
 */
function createInitiative(opts) {
  const dir = opts.dir;
  const statePath = path.join(dir, '.initiative.json');
  const log = opts.log || (() => {});
  const getNow = opts.now || (() => Date.now());
  const getIdleSec = opts.idleSec || (() => 0);
  // 「人在不在」：没注入时一律当成在（老行为），注入了就按它判
  const isHereFn = typeof opts.isHere === 'function' ? opts.isHere : null;
  const complete = opts.complete;
  const persona = opts.persona || '';
  const onSay = opts.onSay || (() => {});
  const record = typeof opts.record === 'function' ? opts.record : () => {};

  const cfg = Object.assign({}, DEFAULTS);
  const src = opts.cfg || {};
  cfg.enabled = src.initiative !== false;
  cfg.speakGapMin = num(src.initiativeGapMin, DEFAULTS.speakGapMin, 10, 1440);
  cfg.speakGapMax = num(src.initiativeGapMax, DEFAULTS.speakGapMax, cfg.speakGapMin, 2880);
  cfg.speakPerDay = num(src.initiativeSpeakPerDay, DEFAULTS.speakPerDay, 0, 48);
  // 静默时段：起止相同表示不设静默
  cfg.quietStart = num(src.initiativeQuietStart, DEFAULTS.quietStart, 0, 23);
  cfg.quietEnd = num(src.initiativeQuietEnd, DEFAULTS.quietEnd, 0, 23);

  let st = load();
  let busy = false;

  function load() {
    const base = {
      day: '',
      speakCount: 0,
      lastSpeakAt: 0,
      lastUserChatAt: 0,
      ignored: 0, // 连续几次对方没接
      sulkUntil: 0, // 这两小时里还要不要提"他没接"这件事
      sulkHeardAt: 0, // 这件事是被哪一刻接住的（只用来看这段时间里该不该再提）
      chatStreak: 0, // 这一段连着说了几句（用来判断"人是真回来了"还是"顺口回一句"）
      speakGapUntil: 0,
      recentSaid: [], // 最近说过的几句（判"他这句是不是在接我"要用到它说过什么）
    };
    try {
      const j = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return Object.assign(base, j && typeof j === 'object' ? j : {});
    } catch (e) {
      return base;
    }
  }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf8');
      fs.renameSync(tmp, statePath);
    } catch (e) {
      log('状态写入失败：' + e.message);
    }
  }

  function rollDay(now) {
    const today = ymd(new Date(now));
    if (st.day === today) return;
    st.day = today;
    st.speakCount = 0;
    save();
  }

  function randInt(a, b) {
    const lo = Math.ceil(a);
    const hi = Math.floor(b);
    if (hi <= lo) return lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  // 记下"我刚说了什么"。判"有没有被接住"必须靠这句话本身，光有时间戳不够 ——
  // 对方十分钟后聊完全不相干的事，不能算接住了。
  function noteSaid(at, kind, text, manual) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const list = Array.isArray(st.recentSaid) ? st.recentSaid : [];
    list.push({ at, kind, text: t.slice(0, 120), heard: false, manual: !!manual });
    // 只留 6 小时内、最近 8 条：够判"接的是哪句"，也不会把状态文件撑大
    st.recentSaid = list.filter((x) => x && x.at && at - x.at <= 6 * 3600000).slice(-8);
  }

  // 在这句话里找"可以被算作接住了"的那一句：30 分钟内、还没被接过的，从最近往前试
  function findReplyTarget(msg, now) {
    const list = Array.isArray(st.recentSaid) ? st.recentSaid : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (!s || !s.at || s.heard) continue;
      const age = now - s.at;
      if (age < 0 || age > 30 * 60000) continue;
      if (isReplyTo(msg, s.text, age)) return s;
    }
    return null;
  }

  // ---------- 「没被接住」的那几句 ----------
  // 只给事实（次数 + 原话），不给结论。是气、是难过、还是装作不在意，
  // 由模型自己拿捏 —— 写死成"先冷一点"等于替它决定了情绪，这不对。
  function unheardSaid(now, limit) {
    const list = Array.isArray(st.recentSaid) ? st.recentSaid : [];
    return list
      .filter((x) => x && !x.heard && (!x.at || now - x.at <= 24 * 3600000))
      .slice(-(limit || 3))
      .reverse(); // 最近的排前面
  }

  function unheardHint(now) {
    const n = st.ignored || 0;
    if (n < 2) return '';
    const list = unheardSaid(now, 3);
    const quote = list.length
      ? '（比如你说的「' + String(list[0].text).slice(0, 22) + '」，他一个字没回）'
      : '';
    // 只陈述事实：说过几次、他没回。要不要在意、下一句带不带刺，它自己定 ——
    // 原来这里写着"你还想再说一句，但心里不太痛快""是带刺还是带点委屈你自己看着来"，
    // 那等于替它把情绪和态度都排好了，它只剩照着演。
    return '你之前主动说过 ' + n + ' 次话，他都没接' + quote + '。';
  }

  // ---------- 情境描述 ----------
  function situationText(now, idleSec) {
    const d = new Date(now);
    const lines = [timeLine(d)];
    const mins = Math.round(idleSec / 60);
    if (mins < 5) lines.push('对方正坐在电脑前，手刚停下来没多久。');
    else lines.push('对方已经 ' + mins + ' 分钟没碰电脑了。');
    if (st.lastUserChatAt && ymd(new Date(st.lastUserChatAt)) === ymd(new Date(now))) {
      lines.push('今天他找你说过话。');
    } else {
      lines.push('今天他还没怎么理你。');
    }
    const uh = unheardHint(now);
    if (uh) lines.push(uh);
    return lines.join('\n');
  }

  // ---------- 模型调用 ----------
  async function ask(instruction, sit) {
    const messages = [
      { role: 'system', content: persona ? persona + '\n\n' + sit : sit },
      { role: 'user', content: instruction },
    ];
    const r = await complete(messages, {
      maxTokens: DEFAULTS.speakTokens,
      temperature: 1.2, // 主动开口比对话更放得开一点
      presencePenalty: 0.3,
      thinking: 'off',
      kind: '主动',
    });
    if (!r || !r.ok) {
      log('模型调用失败：' + ((r && r.message) || '未知'));
      return '';
    }
    return String(r.reply || '');
  }

  function cleanLine(t) {
    let s = String(t || '').trim();
    if (!s) return '';
    s = s.split(/\r?\n/).filter((x) => x.trim())[0] || '';
    s = s.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '');
    s = s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '');
    s = s.replace(/^[-–—·•]\s*/, '');
    s = s.replace(/^(它|我)[:：]\s*/, '');
    // 顺手擦掉旧式动作标签（模型照着老习惯写 #动作:吃 时别让它漏进气泡）
    s = s.replace(/[#＃]{0,2}[ \t]*[【〔\[(（]?[ \t]*动作[ \t]*[:：=][ \t]*[^\s，,。、；;|）)\]】\n]+[ \t]*[）)\]】]?/g, '');
    s = s.replace(/[【〔\[(（]\s*动作\s*[）)\]】〕]/g, '');
    // 主动开口只有一句、气泡里塞不下动作旁白，这里照旧剥掉
    s = s.replace(/[（(][^）)]{0,20}[）)]\s*$/, '');
    if (s.length > 40) s = s.slice(0, 40).replace(/[，,、。]$/, '');
    return s.trim();
  }

  // ---------- 开口 ----------
  // manual=true 表示是外部手动点的（比如宿主界面上的"现在说一句"）：
  // 不算走过一次自动开口，不占每日额度、不重置自动间隔，
  // 也不能拿它当"被晾着"的证据。
  async function doSpeak(now, idleSec, manual) {
    busy = true;
    try {
      // 上一次主动之后对方一直没说话 → 记一笔"被晾着"（手动点的这次不算）
      if (!manual && st.lastSpeakAt && (st.lastUserChatAt || 0) < st.lastSpeakAt) {
        st.ignored = Math.min(5, (st.ignored || 0) + 1);
      }
      const sit = situationText(now, idleSec);
      const instruction =
        '写一句你现在想对他说的话，就一句，20 字以内。\n' +
        '- 不要问"在吗""在干嘛"\n' +
        '- 不要提屏幕、看到、注意到\n' +
        '- 别像监工一样点评他在忙什么，顺手搭一句或者嫌弃一句都行\n' +
        '- 只输出这句话本身，不要引号、不要解释';

      const text = cleanLine(await ask(instruction, sit));
      if (!text) return { ok: false, reason: '空回复' };

      onSay(text);
      st.lastSpeakAt = now;
      noteSaid(now, 'speak', text, manual);
      if (!manual) st.speakCount += 1;
      // 手动说完也别立刻让自动开口接一句，隔 20 分钟再回到正常节奏
      st.speakGapUntil = now + (manual ? 20 : randInt(cfg.speakGapMin, cfg.speakGapMax)) * 60000;
      save();
      log('主动说了：' + text);
      record({ kind: 'speak', text, at: now });
      return { ok: true, kind: 'speak', text };
    } finally {
      busy = false;
    }
  }

  return {
    /** 定时器每几十秒调一次；返回 { skipped: 原因 } 表示这次不开口。 */
    async tick() {
      const now = getNow();
      if (!cfg.enabled) return { skipped: 'disabled' };
      if (busy) return { skipped: 'busy' };
      rollDay(now);
      if (inQuietHours(now, cfg.quietStart, cfg.quietEnd)) return { skipped: 'quiet' };
      if (isHereFn && !isHereFn()) return { skipped: 'away' };
      if (st.speakCount >= cfg.speakPerDay) return { skipped: 'speak-limit' };
      if (now < (st.speakGapUntil || 0)) return { skipped: 'speak-gap' };
      // 刚聊完不插话：在场判定只认 5 秒内的动静，挡不住"人正跟你说话"这种事 ——
      // 上一句还是他说的，这一秒主动开口就成了插嘴。隔十分钟才轮到它开口。
      if (st.lastUserChatAt && now - st.lastUserChatAt < 10 * 60000) return { skipped: 'just-chatted' };
      return doSpeak(now, getIdleSec(), false);
    },

    /**
     * 对方说了话：先看这句是不是在接它刚才那句，再决定销不销账。
     * 返回 { heard: 被接住那句的时刻|0, sulk: 是不是还堵着, matched, said }
     *
     * 注意：只要对方开口就算"人来了"（lastUserChatAt 更新），
     * 但"接住了"必须内容对得上 —— 随口聊别的不能把赌气清零。
     */
    onUserChat(text) {
      const now = getNow();
      const msg = String(text || '').trim();
      const hit = findReplyTarget(msg, now);
      const wasSulk = (st.ignored || 0) >= 2;

      // 连着说了几句就算"人真的回来了"。以前只要没接住那一句就续两小时，
      // 于是人陪聊一个钟头、它还在堵着 —— 那不像人，像记仇的机器。
      // 隔了 10 分钟以上的不算同一段。
      st.chatStreak = now - (st.lastUserChatAt || 0) > 10 * 60000 ? 1 : (st.chatStreak || 0) + 1;

      if (hit) {
        hit.heard = true; // 同一条不会被接两次
        hit.heardAt = now;
        st.ignored = 0;
        // 被晾过两回以上、这会儿接上了：两小时内不再提"没接"这件事。
        // 注意这里只决定"还说不说这个事实"，不代表它这会儿该热络还是该冷淡。
        if (wasSulk) st.sulkUntil = now + 2 * 3600000;
        st.sulkHeardAt = wasSulk ? now : 0;
        log('对方接住了刚才那句：「' + hit.text.slice(0, 20) + '」');
      }

      // 人来了、但绕开了刚才那句：继续承认"他没接"（只是陈述，不催反应）。
      // （人一直没出现时不走这里 —— 没人在场，谈不上接不接）
      // 例外：已经连着说了三句就是真在陪你了，那就不再提这件事，只留半小时，
      // 免得人明明在聊，它却还咬着前面那句话。
      if (!hit && wasSulk) {
        if (st.chatStreak >= 3) {
          st.ignored = 0;
          st.sulkUntil = now + 30 * 60000;
          st.sulkHeardAt = now;
          log('连着聊了 ' + st.chatStreak + ' 句，不再提"没接"这件事');
        } else {
          st.sulkUntil = now + 2 * 3600000;
        }
      }

      st.lastUserChatAt = now;
      save();
      return {
        heard: hit ? hit.at : 0,
        sulk: !!(st.sulkUntil && now < st.sulkUntil),
        matched: hit ? hit.kind : '',
        said: hit ? hit.text : '',
      };
    },

    /** 这句会不会被当成"接住了"，接的是哪一句（自检用）。 */
    matchReply(text) {
      const hit = findReplyTarget(String(text || '').trim(), getNow());
      return hit ? { at: hit.at, kind: hit.kind, text: hit.text } : null;
    },

    /**
     * 对话里"心里那点事"：注入系统提示尾部（动态，不破坏缓存）。
     * 只给事实（说过哪句、他没接），一个字都不提"你该怎么样"。
     *
     * 早先这里写着"别装作什么都没发生""是有点气还是有点难受，你自己定""顺着这个来"——
     * 名义上把方向交给它，实际已经替它排好了一场必须演的反应：不生气就等于"装没事"。
     * 2026-10-24 按用户要求删掉，只留事实；理不理这句、下句冷不冷，它自己决定。
     */
    moodLine() {
      if (!cfg.enabled) return '';
      const now = getNow();
      if (!st.sulkUntil || now >= st.sulkUntil) return '';
      // 隔太久才来，提这件事也没意义了，不必翻旧账
      if (now - (st.lastUserChatAt || 0) > 3 * 3600000) return '';
      // 已经被接住了：历史里就有它那句和对方的回应，不用再提一遍
      if (st.sulkHeardAt) return '';
      const list = unheardSaid(now, 2);
      if (!list.length) return '';
      return '（你主动说的「' + String(list[0].text).slice(0, 22) + '」，他没接。）';
    },

    /** 手动"现在说一句"：不占额度、不重置节奏。 */
    forceSpeak: (idleSec) => doSpeak(getNow(), idleSec === undefined ? 120 : idleSec, true),

    state() {
      const now = getNow();
      const next = st.speakGapUntil || 0;
      return {
        dir,
        enabled: cfg.enabled,
        peak: isPeak(now),
        quiet: inQuietHours(now, cfg.quietStart, cfg.quietEnd),
        quietStart: cfg.quietStart,
        quietEnd: cfg.quietEnd,
        speakToday: st.speakCount,
        speakPerDay: cfg.speakPerDay,
        nextSpeakInMin: next > now ? Math.ceil((next - now) / 60000) : 0,
        ignored: st.ignored,
        sulk: !!(st.sulkUntil && now < st.sulkUntil),
        lastSpeakAt: st.lastSpeakAt,
        lastUserChatAt: st.lastUserChatAt,
      };
    },

    setEnabled(v) {
      cfg.enabled = !!v;
      return cfg.enabled;
    },
    isEnabled: () => cfg.enabled,
  };
}

module.exports = { createInitiative, isPeak, inQuietHours, isReplyTo, grams, timeLine, DEFAULTS };
