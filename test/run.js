'use strict';
/**
 * 自测：不联网、不花钱、不依赖任何测试框架。
 *
 *   node test/run.js
 *
 * 覆盖的是"改了会静默出错"的地方 —— 解析、排序、判定、记账。
 * 这些地方坏了程序照样跑，只是行为悄悄变差，所以必须有断言兜着。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { splitSegments, stripActionTags, stripParens } = require('../src/index.js');
const { buildSystemPrompt, ACT_GUIDE } = require('../src/prompt.js');
const config = require('../src/config.js');
const persona = require('../src/persona.js');
const { createMemory, ymd } = require('../src/memory.js');
const recall = require('../src/recall.js');
const { createInitiative, isReplyTo, inQuietHours, timeLine } = require('../src/initiative.js');
const { createUsage } = require('../src/usage.js');

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error('✗ ' + label);
  passed += 1;
  console.log('  ✓ ' + label);
}
function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
const pad2 = (n) => String(n).padStart(2, '0');
function dayStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// ---------------------------------------------------------------------------
console.log('\n[1] 分段：一条长回复拆成 1~3 条');
{
  ok(splitSegments('嗯。').length === 1, '单行只算一条');
  ok(splitSegments('一\n二').length === 2, '两行拆成两条');
  const seg = splitSegments('一\n二\n三\n四\n五');
  ok(seg.length === 3, '超过 3 条时压回 3 条（不刷屏）');
  ok(seg[2].includes('三') && seg[2].includes('五'), '被并掉的内容不丢');
}

// ---------------------------------------------------------------------------
console.log('\n[2] 配置：JSONC 与坏值');
{
  const src = '{\n // 注释\n "temperature": 0.9, /* 块注释 */ "model": "x"\n}';
  const j = JSON.parse(config.stripJsonc(src));
  ok(j.temperature === 0.9 && j.model === 'x', '注释被去掉，值保留');
  ok(config.stripJsonc('{"a":"http://x//y"}').includes('http://x//y'), '字符串里的 // 不被当注释');

  const c1 = config.normalize({ temperature: '' });
  ok(c1.temperature === config.DEFAULTS.temperature, '空串回默认（Number("")===0 的坑）');
  const c2 = config.normalize({ temperature: 99, historyTurns: -3 });
  ok(c2.temperature === 2 && c2.historyTurns === 0, '越界被夹回合法区间');
  const c3 = config.normalize({ thinking: 'false' });
  ok(c3.thinking === 'off', '"false" 认成关思考');
  const c4 = config.normalize({ memory: 'yes' });
  ok(c4.memory === true, '只有显式 false 才关记忆');
  const c5 = config.normalize({ memoryInjectDays: 999 });
  ok(c5.memoryInjectDays === 30, '注入天数上限 30');
}

// ---------------------------------------------------------------------------
console.log('\n[3] 人设：抽样稳定 + 必抽样例在场');
{
  persona.resetPersonaCache();
  const p1 = persona.defaultPersona();
  const p2 = persona.defaultPersona();
  ok(p1 === p2, '同一次进程内只抽一次（否则缓存前缀每句都变，贵 10 倍）');
  ok(p1.includes(persona.MUST[0]), '必抽的不附和样例每次都在');
  ok(p1.split('\n').some((l) => /^\s{10,}\S/.test(l)), '多段样例进入人设（续行是缩进的）');
  persona.resetPersonaCache();
  ok(persona.defaultPersona() !== p1, '重启后才允许换一批');
}

// ---------------------------------------------------------------------------
console.log('\n[4] 记忆：三档解析、名额取舍、显示顺序');
{
  const dir = tmp('bfchat-mem-');
  fs.mkdirSync(path.join(dir, 'diary'), { recursive: true });
  const today = new Date();
  fs.writeFileSync(
    path.join(dir, 'diary', dayStr(today) + '.md'),
    [
      '- 09:00 [简记] 随口说了句天气不错',
      '- 09:05 [简记] 又说了句今天风大',
      '- 09:10 [日常] 站了一天腰酸',
      '- 09:20 [重点/喜好] 最爱吃橘子 #橘子',
      '- 09:30 [日常/情绪] 这两天心里有点闷',
      '- 09:40 [简记] 随手记了句好困',
    ].join('\n'),
    'utf8',
  );
  const m = createMemory({ dir, complete: async () => ({ ok: true, reply: '- 09:00 [简记] x' }), log: () => {} });
  m.init();
  const ctx = m.context('');
  ok(ctx.includes('橘子'), '重点注入');
  ok(ctx.includes('腰酸'), '日常注入');
  ok(ctx.includes('闷'), '[日常/情绪] 这种带标签的日常也能解析');
  // 今天名额 8 条，但简记最多 2 条：这里 3 条简记 → 挤掉一条
  const notes = ['天气不错', '今天风大', '好困'].filter((x) => ctx.includes(x));
  ok(notes.length === 2, '名额不够时简记先出局（三选二）');
  ok(ctx.includes('【你和用户从前的日记】'), '注入块带固定标题');
  // 展示按时间正序：读起来像一天的流水，而不是按重要性排
  ok(ctx.indexOf('腰酸') < ctx.indexOf('橘子'), '注入内容按时间正序排列');
}

// ---------------------------------------------------------------------------
console.log('\n[4c] 永久层：pinned 装满后优先保留新的');
{
  const dir = tmp('bfchat-pin-');
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push('- 旧约定第' + i + '条：每天喝水');
  fs.writeFileSync(path.join(dir, 'pinned.md'), lines.join('\n') + '\n- 说好下周一起去看电影\n', 'utf8');
  const m = createMemory({ dir, complete: async () => ({ ok: true, reply: '' }), log: () => {} });
  m.init();
  const ctx = m.context('');
  ok(ctx.includes('一起去看电影'), '装满 220 字以后，最新钉住的那条仍在注入里');
  ok(!ctx.includes('旧约定第0条'), '被挤掉的是最早的那条');
}

// ---------------------------------------------------------------------------
async function testChunking() {
  console.log('\n[4b] 整理分批：100 轮长对话不再被 slice 截掉');
  const dir = tmp('bfchat-chunk-');
  const batches = [];
  const m = createMemory({
    dir,
    complete: async (msgs) => {
      const body = msgs[1].content;
      batches.push({ len: body.length, rounds: (body.match(/角色：/g) || []).length });
      const n = batches.length;
      return {
        ok: true,
        reply: [0, 1, 2, 3, 4, 5].map((i) => '- 10:0' + i + ' [日常] 第' + n + '批第' + i + '条记录').join('\n'),
      };
    },
    log: () => {},
  });
  m.init();
  const userTxt = '今天加班到十点，回家路上还下雨了，累得不行，饭都没吃';
  const replyTxt = '那就别动了，歇着吧。先把饭吃了再说。';
  for (let i = 0; i < 100; i++) m.record(userTxt, replyTxt);

  const r = await m.flush('分批测试');
  ok(batches.length > 1, '100 轮被切成多批（原来只发一次，40% 被截掉）');
  ok(batches.every((b) => b.len <= 3800), '每批都在 3800 字符以内');
  ok(batches.reduce((s, b) => s + b.rounds, 0) === 100, '100 轮全部进了某一批，没有轮次被丢掉');
  ok(r.ok === true && r.batches === batches.length, '返回值里带批次数');
  const diary = fs.readFileSync(path.join(dir, 'diary', dayStr(new Date()) + '.md'), 'utf8');
  const rows = diary.split('\n').filter((l) => l.startsWith('- '));
  ok(rows.length === 6 * batches.length, '每批各 6 条，总数突破单批 6 条上限');
}

// ---------------------------------------------------------------------------
async function testRecallLayers() {
  console.log('\n[5c] 检索分层：老的旧事不会被"最新的"挤掉');
  {
    const dir = tmp('bfchat-layer-');
    fs.mkdirSync(path.join(dir, 'diary'), { recursive: true });
    for (const n of [10, 100, 300]) {
      const d = new Date(Date.now() - n * 86400000);
      const rows = [];
      for (let k = 0; k < 3; k++) rows.push('- 20:0' + k + ' [日常] 那天晚上打游戏打到很晚，队友还很菜');
      fs.writeFileSync(path.join(dir, 'diary', dayStr(d) + '.md'), rows.join('\n') + '\n', 'utf8');
    }
    const m = createMemory({ dir, retentionDays: 365, complete: async () => ({ ok: true, reply: '' }), log: () => {} });
    m.init();
    const ctx = m.context('最近打游戏总是输');
    const rows = ctx.split('\n').filter((l) => l.trim().startsWith('· ') && l.includes('打游戏'));
    const dates = new Set(rows.map((l) => l.trim().replace(/^·\s*/, '').split(' ')[0]));
    ok(rows.length === 3, '三个时间档各取 1 条（同一类事不再占满名额）');
    ok(dates.size === 3, '3 条来自 3 个不同日期（同一天只出一条）');
    const oldDay = dayStr(new Date(Date.now() - 300 * 86400000)).slice(5).replace('-', '月') + '日';
    ok(rows.some((l) => l.includes(oldDay)), '300 天前的旧事也进了注入');
  }

  console.log('\n[5d] 月摘要：比周摘要活得更久的那一层');
  {
    const dir = tmp('bfchat-month-');
    fs.mkdirSync(path.join(dir, 'diary'), { recursive: true });
    const d1 = new Date();
    d1.setMonth(d1.getMonth() - 2);
    fs.writeFileSync(path.join(dir, 'diary', dayStr(d1) + '.md'), '- 20:00 [重点/喜好] 用户一直想学弹吉他\n', 'utf8');
    let asked = 0;
    const m = createMemory({
      dir,
      complete: async () => {
        asked += 1;
        return { ok: true, reply: '- 用户一直想学弹吉他；那阵子在攒钱买琴' };
      },
      log: () => {},
    });
    m.init();
    m.summarizeMonthly();
    await new Promise((r) => setTimeout(r, 100)); // 它是异步 IIFE，等它落盘
    const mDir = path.join(dir, 'diary', 'monthly');
    const files = fs.existsSync(mDir) ? fs.readdirSync(mDir).filter((f) => f.endsWith('.md')) : [];
    ok(files.length === 1, '过完的月份被压成一份月摘要');
    ok(asked === 1, '一个月只调一次模型（没重点的月份打 skip 不花钱）');
    ok(m.context('').includes('弹吉他'), '月摘要进了注入');
  }
}

// ---------------------------------------------------------------------------
console.log('\n[5] 检索：中文实词能撞上（曾经的隐藏 bug）');
{
  const dir = tmp('bfchat-search-');
  fs.mkdirSync(path.join(dir, 'diary'), { recursive: true });
  // 检索会跳过最近 3 天（那几天本来就全量注入），所以造一份 10 天前的日记
  const old = new Date(Date.now() - 10 * 86400000);
  fs.writeFileSync(
    path.join(dir, 'diary', dayStr(old) + '.md'),
    '- 20:00 [日常] 舍友晚上打游戏太吵，用户睡不着 #舍友 #打游戏',
    'utf8',
  );
  const m = createMemory({ dir, complete: async () => ({ ok: true, reply: '' }), log: () => {} });
  m.init();
  ok(m.context('舍友很吵那次').includes('舍友'), '「舍友很吵那次」命中');
  ok(m.context('上次那个打游戏的事').includes('打游戏'), '「打游戏」命中');
}

// ---------------------------------------------------------------------------
console.log('\n[5b] 二次展开：只有追问才回原话里翻');
{
  const dir = tmp('bfchat-expand-');
  fs.mkdirSync(path.join(dir, 'diary'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  const old = new Date(Date.now() - 10 * 86400000);
  const day = dayStr(old);
  fs.writeFileSync(
    path.join(dir, 'diary', day + '.md'),
    '- 20:00 [日常] 用户说打游戏时队友太坑，讲到一半去吃饭了 #打游戏 #队友',
    'utf8',
  );
  const line = (t, u, r) => JSON.stringify({ t, user: u, reply: r });
  fs.writeFileSync(
    path.join(dir, 'raw', day + '.jsonl'),
    [
      line(new Date(old).toISOString(), '打游戏排到一个队友', '怎么了'),
      line(new Date(old.getTime() + 60000).toISOString(), '他全程挂机，气死我了', '那你后来赢了吗'),
    ].join('\n') + '\n',
    'utf8',
  );
  const mk = () => createMemory({ dir, complete: async () => ({ ok: true, reply: '' }), log: () => {} });

  const realRandom = Math.random;
  Math.random = () => 0; // 让遗忘概率这道闸必过，专测"追问"这一道
  try {
    const m1 = mk();
    m1.init();
    ok(m1.context('那个打游戏的事后来呢').includes('从那天想起来的片段'), '追问 → 翻出原话片段');

    const m2 = mk(); // 新实例，绕开 10 分钟冷却
    m2.init();
    ok(!m2.context('那个打游戏的事真烦').includes('从那天想起来的片段'), '没追问 → 只给日记摘要，不翻原话');
  } finally {
    Math.random = realRandom;
  }
}

// ---------------------------------------------------------------------------
console.log('\n[6] 遗忘曲线：概率单调下降，字数先丢细节');
{
  const p1 = recall.forgetProb(1, '日常');
  const p30 = recall.forgetProb(30, '日常');
  const p90 = recall.forgetProb(90, '日常');
  ok(p1 > p30 && p30 > p90, '越久越可能想不起来');
  ok(recall.forgetProb(30, '重点') > recall.forgetProb(30, '简记'), '重要的事更容易想起来');
  ok(recall.detailChars(1) > recall.detailChars(30) && recall.detailChars(30) >= 20, '想起来的部分随时间变少');
  ok(recall.wantsExpand('后来呢'), '「后来呢」算追问');
  ok(!recall.wantsExpand('后来我就走了，路上还遇到一个人，聊了很久'), '长句里的「后来」不算追问');
}

// ---------------------------------------------------------------------------
console.log('\n[7] 接话判定：按内容，不按时间');
{
  ok(isReplyTo('你说的那个事我想了想', '楼下那家店关门了', 60000), '明着指回 = 接住了');
  ok(isReplyTo('嗯', '楼下那家店关门了', 30000), '短接话 + 刚说完 = 接住了');
  ok(!isReplyTo('嗯', '楼下那家店关门了', 30 * 60000), '短接话但过了太久 = 不算');
  ok(isReplyTo('那家店确实关了', '楼下那家店关门了', 10 * 60000), '有共同实词 = 接住了');
  ok(!isReplyTo('我今天考试没过', '楼下那家店关门了', 60000), '聊别的事 = 没接（不能自作多情）');
}

// ---------------------------------------------------------------------------
async function testInitiative() {
  console.log('\n[8] 主动开口：额度、在场、被晾着');
  const dir = tmp('bfchat-init-');
  let t = Date.parse('2026-10-21T22:00:00');
  let here = true;
  const said = [];
  const it = createInitiative({
    dir,
    cfg: { initiativeSpeakPerDay: 3, initiativeGapMin: 10, initiativeGapMax: 10, initiativeQuietStart: 0, initiativeQuietEnd: 6 },
    persona: '人设',
    complete: async () => ({ ok: true, reply: '喂，在不在。' }),
    isHere: () => here,
    idleSec: () => 30,
    now: () => t,
    onSay: (x) => said.push(x),
    log: () => {},
  });

  const r1 = await it.tick();
  ok(r1.ok && said[0] === '喂，在不在。', '到点就开口');

  const r2 = await it.tick();
  ok(r2.skipped === 'speak-gap', '刚说完不会马上再说');

  here = false;
  t += 11 * 60000;
  const r3 = await it.tick();
  ok(r3.skipped === 'away', '人不在就不开口');

  here = true;
  await it.tick(); // 第二次开口 → 上一次没人接，记一笔
  t += 11 * 60000;
  await it.tick(); // 第三次 → ignored 到 2
  const mark = it.onUserChat('我今天考试没过');
  ok(mark.heard === 0, '聊别的不算接住');
  ok(mark.sulk === true, '被晾两次后开始堵着');
  const mood = it.moodLine();
  ok(mood.includes('他没接'), '被晾时只陈述事实：它说的那句他没接');
  ok(
    !/你自己定|别装作什么都没发生|该气还是|心里有点不是滋味|留点硬气/.test(mood),
    '不替它排反应：不提"该气还是该难过"、不要求"别装没事"'
  );

  const heard = it.onUserChat('你刚才说的那句什么意思');
  ok(heard.heard > 0, '明着回应才算接住');
  ok(it.state().sulk === true, '接住了也不再提这件事（但旧账不会瞬间抹掉）');

  // 静默时段：0~6 点完全不主动，6 点之后恢复
  t = Date.parse('2026-10-22T03:30:00');
  const rq = await it.tick();
  ok(rq.skipped === 'quiet', '0~6 点不主动开口');
  t = Date.parse('2026-10-22T06:00:00');
  const ra = await it.tick();
  ok(ra.skipped !== 'quiet', '6 点之后恢复主动');
  ok(it.state().quiet === false && it.state().quietStart === 0 && it.state().quietEnd === 6, 'state 里能查到静默时段');

  // 静默时段支持跨零点；起止相同 = 不设静默
  ok(inQuietHours(Date.parse('2026-10-22T23:30:00'), 23, 6), '跨零点的静默（23→6）');
  ok(!inQuietHours(Date.parse('2026-10-22T12:00:00'), 23, 6), '跨零点静默之外的时段不受影响');
  ok(!inQuietHours(Date.parse('2026-10-22T03:30:00'), 8, 8), '起止相同 = 不设静默');

  // 刚聊完不插话：换一天，额度重置，间隔也早已过期
  t = Date.parse('2026-10-23T10:00:00');
  await it.tick();
  t = Date.parse('2026-10-23T10:11:00');
  it.onUserChat('我今天考试没过');
  t = Date.parse('2026-10-23T10:14:00');
  const rj = await it.tick();
  ok(rj.skipped === 'just-chatted', '刚聊完 3 分钟不会插嘴');
  t = Date.parse('2026-10-23T10:25:00');
  const rk = await it.tick();
  ok(rk.ok === true, '距上次聊天满 10 分钟才轮到它开口');
}

// ---------------------------------------------------------------------------
console.log('\n[9] 记账：一天一个文件、收进 usage/ 子目录、坏行跳过');
{
  const dir = tmp('bfchat-usage-');
  const u = createUsage({ dir, log: () => {} });
  u.add({ kind: '对话', prompt: 1000, cached: 800, completion: 60 });
  u.add({ kind: '整理', prompt: 500, cached: 0, completion: 40 });
  const t = u.today();
  ok(t.total === 1600, 'total = 输入 + 输出');
  ok(t.byKind['对话'].total === 1060 && t.byKind['整理'].total === 540, '按类型分开记');
  ok(
    fs.existsSync(path.join(dir, 'usage', 'usage-' + dayStr(new Date()) + '.jsonl')),
    '账本落在 usage/ 子目录里（数据目录根下不再一天多一个文件）'
  );
  const file = path.join(dir, 'usage', 'usage-' + dayStr(new Date()) + '.jsonl');
  fs.appendFileSync(file, '这不是 json\n', 'utf8');
  ok(u.today().total === 1600, '坏行被跳过，不影响合计');

  // 老版本的账本直接放在根目录：升级后要自动搬进 usage/，不然历史账读不到
  const dir2 = tmp('bfchat-usage-legacy-');
  const legacy = path.join(dir2, 'usage-' + dayStr(new Date()) + '.jsonl');
  fs.writeFileSync(legacy, '{"t":"2026-10-20T10:00:00+08:00","kind":"对话","prompt":100,"cached":0,"completion":20}\n', 'utf8');
  const u2 = createUsage({ dir: dir2, log: () => {} });
  ok(!fs.existsSync(legacy), '根目录的旧账被搬走');
  ok(u2.today().total === 120, '旧账搬进 usage/ 后照样算得进当日合计');
}

// ---------------------------------------------------------------------------
console.log('\n[9b] 动作与时间：括号旁白、旧标签擦除、时刻给到分钟');
{
  const base = { persona: 'P', thinking: 'off', action: true };
  const on = buildSystemPrompt({ cfg: base });
  ok(on.includes(ACT_GUIDE), '动作说明进了系统提示（固定前缀，走缓存价）');
  ok(on.includes('（尾巴动了一下）'), '给了括号写法的例子');
  const off = buildSystemPrompt({ cfg: Object.assign({}, base, { action: false }) });
  ok(!off.includes('【动作】'), 'action=false 时提示词里一个字都不提动作');
  ok(on.indexOf('【动作】') > on.indexOf('P'), '动作段落在人设之后（固定内容都排在前面）');

  ok(stripActionTags('累就瘫着呗。#动作:吃') === '累就瘫着呗。', '旧式 #动作 标签被擦掉');
  ok(stripActionTags('【动作】') === '', '空壳【动作】标记不留残渣');
  ok(
    stripActionTags('哼（尾巴动了一下）') === '哼（尾巴动了一下）',
    '括号旁白保留 —— 那是要显示给人看的'
  );

  ok(stripParens('累就瘫着呗。（尾巴垂下来）') === '累就瘫着呗。', '入库前剥掉括号动作');
  ok(stripParens('嗯（别过头）然后就睡了') === '嗯然后就睡了', '句子中间的括号动作也剥');
  ok(stripParens('（尾巴动了一下）') === '', '只有动作、没有正文时剥成空串');

  // 时间：给到「10月25日周日 19:06」，不再只说"晚上"
  const tl = timeLine(new Date(2026, 9, 25, 19, 6));
  ok(tl.includes('10月25日') && tl.includes('周日') && tl.includes('19:06'), '时间给到日期 + 星期 + 时刻');
  ok(!/凌晨|早上|上午|中午|下午|晚上|深夜/.test(tl), '不再用"晚上"这种粗档 —— 19 点和 23 点得分得开');

  const withTime = buildSystemPrompt({ cfg: base, now: Date.parse('2026-10-25T19:06:00') });
  ok(withTime.trim().endsWith('19:06。'), '时间拼在系统提示最末尾（只影响尾部几十 token）');
}

// ---------------------------------------------------------------------------
(async () => {
  await testChunking();
  await testRecallLayers();
  await testInitiative();
  console.log('\n[10] 端到端：假接口跑一遍（不联网、不花钱）');
  const dir = tmp('bfchat-e2e-');
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const isMemory = Array.isArray(body.messages) && /整理/.test(String(body.messages[0].content || '').slice(0, 20));
    const content = isMemory ? '- 22:00 [日常] 今天加班到很晚' : '累就瘫着呗。\n过来坐会儿。';
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 2000, prompt_cache_hit_tokens: 1800, completion_tokens: 30 },
        }),
    };
  };
  const { createChat } = require('../src/index.js');
  const chat = createChat({
    config: { apiKey: 'sk-test', memory: true, initiative: true, memoryIdleMinutes: 999 },
    dataDir: dir,
    fetch: fakeFetch,
    log: () => {},
  });
  const r = await chat.say('今天好累啊');
  ok(r.ok && r.segments.length === 2, '两条回复被拆开');
  ok(calls[0].messages[0].role === 'system', '系统提示在最前（缓存前缀）');
  ok(calls[0].messages[0].content.includes('鲸鱼娘'), '人设进了系统提示');
  ok(calls[0].thinking && calls[0].thinking.type === 'enabled', 'low 档传 enabled');
  ok(chat.usageToday().total === 2030, '用量记账接上了');
  ok(fs.existsSync(path.join(dir, 'raw', dayStr(new Date()) + '.jsonl')), '原始对话落盘');

  await chat.close(); // 触发整理
  const diary = fs.readFileSync(path.join(dir, 'diary', dayStr(new Date()) + '.md'), 'utf8');
  ok(diary.includes('[日常]'), '整理后的日记写进了 diary/');

  console.log('\n全部通过：' + passed + ' 项断言\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n' + (e && e.message ? e.message : e));
  process.exit(1);
});
