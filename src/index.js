'use strict';
/**
 * bigfish-framework-chat —— 一个便宜、记得住、会主动开口的陪伴式对话引擎。
 *
 * 它不管界面。它做的事只有：把你的话变成一次对话，把对话变成有用的记忆，
 * 在你需要的时候把记忆喂回去，并在你没说话的时候偶尔先开口。
 *
 *   const chat = createChat({ apiKey: process.env.DEEPSEEK_API_KEY });
 *   const r = await chat.say('今天好累啊');
 *   console.log(r.segments);   // ['累就瘫着呗。', '过来坐会儿。']
 *
 * 想跑起来看看：node demo/cli.js
 */

const path = require('node:path');
const fs = require('node:fs');

const { normalize, loadConfig, DEFAULTS } = require('./config.js');
const { createLlm } = require('./llm.js');
const { createMemory } = require('./memory.js');
const { createInitiative, isReplyTo } = require('./initiative.js');
const { createUsage } = require('./usage.js');
const { buildSystemPrompt } = require('./prompt.js');
const { defaultPersona } = require('./persona.js');
const saidStore = require('./said-store.js');

const MAX_SEGMENTS = 3;

/**
 * 擦掉旧式动作标签（`#动作:吃` / `【动作】` 这类空壳标记）。
 *
 * 2026-10-25 起动作改成写进正文的括号旁白，不再有标签。但模型偶尔还会照着
 * 老习惯写一个 —— 那串东西漏进回复就是一句莫名其妙的话，所以照着擦掉。
 * **圆括号里的动作旁白不擦**，那是要显示给人看的。
 */
function stripActionTags(text) {
  return String(text == null ? '' : text)
    .replace(/[【〔\[(（]\s*动作\s*[）)\]】〕]/g, '')
    .replace(
      /[#＃]{0,2}[ \t]*[【〔\[(（]?[ \t]*动作[ \t]*[:：=][ \t]*[^\s，,。、；;|）)\]】\n]+[ \t]*[）)\]】]?/g,
      ''
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 剥掉括号动作，只留正文 —— 给记忆用。
 *
 * 记忆里存「（尾巴垂下来）」没有意义，还会占掉那 1400 字预算；
 * 但对话历史里要留着，不然它下一次看不到自己刚才做过什么。
 */
function stripParens(text) {
  return String(text == null ? '' : text)
    .replace(/[（(][^（()）\n]{0,20}[)）]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；])/g, '$1')
    .trim();
}

/**
 * 把一段回复拆成 1~3 条消息。
 *
 * 为什么拆：一条长回复和三条短消息，观感差很远 —— 后者像人在打字。
 * 但拆过头就变成刷屏，所以超过 3 条时把剩下的并进最后一条，不丢内容。
 */
function splitSegments(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines;
  if (lines.length <= MAX_SEGMENTS) return lines;
  const head = lines.slice(0, MAX_SEGMENTS - 1);
  head.push(lines.slice(MAX_SEGMENTS - 1).join(' '));
  return head;
}

const SAID_LABEL = { speak: '主动开口', note: '留言', thought: '随笔' };

/**
 * @param {object} [options]
 * @param {string} [options.configFile]  JSONC 配置文件路径
 * @param {object} [options.config]      直接给配置对象（优先于 configFile）
 * @param {string} [options.apiKey]      key（优先于配置与环境变量）
 * @param {string} [options.dataDir]     记忆与状态放哪，默认 ./memory
 * @param {function} [options.isHere]    () => boolean，判断对方在不在（不注入=一直在）
 * @param {function} [options.idleSec]   () => number，对方多久没动（秒）
 * @param {function} [options.onSpeak]   (text) => void，它主动开口时回调
 * @param {function} [options.onUsage]   (kind, usage) => void
 * @param {function} [options.log]       (msg) => void
 */
function createChat(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  // 时间统一从这里取：对话的时间提示、主动开口的"现在几点"必须是同一个钟，
  // 两边各读一次 Date.now() 极少数情况下会差一秒，跨午夜时就成了两个日期。
  const getNow = typeof opts.now === 'function' ? () => Number(opts.now()) : () => Date.now();
  const cfg = opts.config ? normalize(opts.config) : loadConfig(opts.configFile);

  cfg.apiKey = String(opts.apiKey || cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  // 人设留空 = 用内置示例；一旦填了就用填的，一个字都不混
  if (!String(cfg.persona || '').trim()) cfg.persona = defaultPersona();

  const dataDir = opts.dataDir || path.join(process.cwd(), 'memory');
  fs.mkdirSync(dataDir, { recursive: true });

  // ---------- 记账 ----------
  const usage = createUsage({ dir: dataDir, log: log });
  usage.prune();
  const onUsage = (kind, u) => {
    const src = u || {};
    usage.add({
      kind: kind || '对话',
      prompt: Number(src.prompt_tokens) || 0,
      cached: Number(src.prompt_cache_hit_tokens) || 0,
      completion: Number(src.completion_tokens) || 0,
    });
    if (typeof opts.onUsage === 'function') {
      try {
        opts.onUsage(kind, src);
      } catch (e) {
        /* 回调出错不影响主流程 */
      }
    }
  };

  // ---------- 模型 ----------
  const llm = createLlm({ cfg, log, onUsage, fetch: opts.fetch });

  // ---------- 记忆 ----------
  let memory = null;
  if (cfg.memory) {
    memory = createMemory({
      dir: dataDir,
      // 整理是"分类判断"，不是"说话"：温度必须压到 0.3。
      // 继承对话的 1.2 等于用最活泼的采样去做"算不算重点"的判断，是误标的主要来源。
      complete: (messages) =>
        llm.complete(messages, { thinking: 'off', maxTokens: 420, presencePenalty: 0, temperature: 0.3, kind: '整理' }),
      idleMs: Math.round(cfg.memoryIdleMinutes * 60000),
      injectDays: cfg.memoryInjectDays,
      maxChars: cfg.memoryMaxChars,
      retentionDays: cfg.memoryRetentionDays,
      weeklyKeep: cfg.memoryWeeklyKeep,
      monthlyKeep: cfg.memoryMonthlyKeep,
      log: (m) => log('记忆：' + m),
    });
    memory.init();
    saidStore.migrate(dataDir); // 旧版把 said-*.md 平铺在根目录，这里搬进 said/（幂等）
  }

  // ---------- 它主动说过的话 ----------
  // 存两份：said/YYYY-MM-DD.md 给人翻，self/ 给它自己接话头、给整理当素材。
  function recordSaid(entry) {
    try {
      if (!entry || !entry.kind) return;
      const d = new Date(Number(entry.at) || Date.now());
      const file = saidStore.saidPath(dataDir, d);
      const pad = (n) => String(n).padStart(2, '0');
      const body = String(entry.text || '').replace(/\s*\n+\s*/g, ' / ');
      const line = '- ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' +
        (SAID_LABEL[entry.kind] || entry.kind) + '：' + body + '\n';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) {
        const day = path.basename(file).replace(/\.md$/, '');
        fs.writeFileSync(file, '# ' + day + ' 它主动说过的话\n\n', 'utf8');
      }
      fs.appendFileSync(file, line, 'utf8');
      if (memory) memory.noteSelf({ t: d, kind: entry.kind, text: entry.text });
    } catch (e) {
      // 记不下来也不能影响它说话
    }
  }

  // ---------- 主动开口 ----------
  let initiative = null;
  if (cfg.initiative) {
    initiative = createInitiative({
      dir: dataDir,
      cfg,
      persona: cfg.persona,
      complete: (messages, over) => llm.complete(messages, over),
      isHere: opts.isHere,
      idleSec: opts.idleSec,
      getNow,
      onSay: (text) => {
        if (typeof opts.onSpeak === 'function') {
          try {
            opts.onSpeak(text);
          } catch (e) {
            /* 回调出错不影响主流程 */
          }
        }
      },
      record: recordSaid,
      log: (m) => log('主动：' + m),
    });
  }

  // ---------- 对话状态 ----------
  let history = [];
  // 被 historyTurns 挤掉的旧话题，压成一行（只记对方问了什么），随系统提示一起发
  let digest = '';

  function trimHistory(turns) {
    const max = Math.max(0, turns) * 2;
    if (history.length <= max) return;
    // 被挤出去的那几轮：只把「对方说过什么」压成一行提要，助手的话不留
    // （回复内容对下一句没什么用，对方的话题才是衔接上下文的关键）
    const drop = max === 0 ? history : history.slice(0, history.length - max);
    const said = [];
    for (const m of drop) {
      if (!m || m.role !== 'user') continue;
      const s = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 18);
      if (s) said.push(s);
    }
    if (said.length) {
      const parts = digest ? digest.split('／') : [];
      digest = parts.concat(said).slice(-4).join('／'); // 最多记 4 句，一行写完
    }
    history = max === 0 ? [] : history.slice(-max);
  }

  /** 系统提示（也用于预热缓存）。 */
  function systemPrompt(userText) {
    return buildSystemPrompt({ cfg, memory, initiative, digest, userText, now: getNow() });
  }

  /**
   * 说一句话。返回 { ok, segments, reply, message }。
   * 出错不抛异常 —— 调用方拿到 ok:false 自己决定怎么提示。
   */
  async function say(text) {
    const msg = String(text || '').trim().slice(0, 500);
    if (!msg) return { ok: false, message: '内容为空' };
    if (!cfg.apiKey) return { ok: false, message: '没有 API key：传 apiKey，或设环境变量 DEEPSEEK_API_KEY' };

    // 对方说话了：先判断这句是不是在接它刚才那句。
    // 只按时间算的话，他随口聊别的也会被当成"理我了"—— 见 initiative.isReplyTo。
    const mark = initiative ? initiative.onUserChat(msg) : null;
    // 真的接住了才标"被听见"，日记里就不用再写成"没人理"
    if (mark && mark.heard && memory) memory.markHeard(mark.heard);

    trimHistory(cfg.historyTurns);
    const messages = [
      { role: 'system', content: systemPrompt(msg) },
      ...history,
      { role: 'user', content: msg },
    ];

    const r = await llm.complete(messages, { kind: '对话' });
    if (!r.ok) {
      log('对话失败：' + r.message);
      return r;
    }

    const clean = stripActionTags(r.reply || '……') || '……';
    // 历史里保留换行和括号动作（它能看到自己上次发了几条、做过什么），
    // 记忆里压成一行并剥掉括号（整理按行解析，动作说明对日记没用）
    history.push({ role: 'user', content: msg }, { role: 'assistant', content: clean });
    trimHistory(cfg.historyTurns);

    const segments = splitSegments(clean);
    const out = segments.length ? segments : [clean];
    if (memory && cfg.memory) memory.record(msg, stripParens(out.join(' ')));

    return { ok: true, reply: clean, segments: out, reasoningTokens: r.reasoningTokens, usage: r.usage };
  }

  /**
   * 定时器调它（建议 30~60 秒一次）。
   * 返回 { skipped: 原因 } = 这次不开口；{ ok: true, text } = 说了。
   */
  async function tick() {
    if (!initiative) return { skipped: 'disabled' };
    return initiative.tick();
  }

  /** 立刻让它说一句（不占每日额度）。 */
  async function forceSpeak() {
    if (!initiative) return { ok: false, message: '主动开口已关闭' };
    return initiative.forceSpeak();
  }

  /** 预热一次缓存：把系统提示写进接口的上下文缓存，之后每句都是命中价。 */
  async function warmup() {
    if (!cfg.apiKey) return { ok: false, message: '没有 API key' };
    const t0 = Date.now();
    const r = await llm.complete(
      [{ role: 'system', content: systemPrompt('') }, { role: 'user', content: '在吗' }],
      { thinking: 'off', maxTokens: 8, temperature: 0, kind: '预热' },
    );
    if (r.ok) log('缓存预热完成（' + (Date.now() - t0) + 'ms）');
    else log('缓存预热失败：' + r.message);
    return r;
  }

  /** 今天的用量合计：{ total, prompt, cached, completion, byKind } */
  function usageToday() {
    return usage.today();
  }

  /** 把还没整理的对话立刻整理掉（退出前调一次）。 */
  async function close() {
    if (!memory) return { ok: true, skipped: true };
    return memory.flush('退出前');
  }

  return {
    cfg,
    dataDir,
    memory,
    initiative,
    say,
    tick,
    forceSpeak,
    warmup,
    usageToday,
    close,
    systemPrompt,
    state() {
      return {
        dataDir,
        historyTurns: history.length / 2,
        digest,
        pendingMemory: memory ? memory.pendingCount() : 0,
        initiative: initiative ? initiative.state() : null,
        usageToday: usage.today(),
      };
    },
  };
}

module.exports = {
  createChat,
  splitSegments,
  buildSystemPrompt,
  defaultPersona,
  isReplyTo,
  stripActionTags,
  stripParens,
  DEFAULTS,
  // 单独暴露，方便直接组装
  modules: {
    config: require('./config.js'),
    llm: require('./llm.js'),
    memory: require('./memory.js'),
    initiative: require('./initiative.js'),
    recall: require('./recall.js'),
    usage: require('./usage.js'),
    presence: require('./presence.js'),
    saidStore: require('./said-store.js'),
  },
};
