'use strict';
// 陪伴式对话的长期记忆：原始对话 → 带标签的日记 → 按「遗忘曲线」分层注入
//
// 目录结构（都在 dataDir 下，默认 ./memory）：
//   memory/raw/YYYY-MM-DD.jsonl        每次对话一行，永久留档（不花 token，纯追加）
//   memory/diary/YYYY-MM-DD.md         当天的日记：- HH:MM [重点/食物] 内容
//   memory/diary/weekly/YYYY-Www.md    3 天以前的日记压成的周摘要（短期细节 → 长期印象）
//   memory/diary/.digested.json        哪些日子已经被压进周摘要（防重复压缩）
//   memory/pinned.md                   永久钉住的事实：称呼、生日、约定、雷点，永不衰减
//   memory/.pending.json               还没整理的那一小段对话（崩溃后下次启动补整理）
//
// 为什么这么设计（省 token 的同时让人味更足）：
//   · 今天全量、前天只看重点、更早只看周摘要 —— 越久越模糊，和人的记忆一样
//   · 同样的字数预算，能覆盖 2~3 周而不是 3 天
//   · 用户这句话里提到什么（吃、累、约定…），就额外翻出相关的旧日记，最多 3 条
//   · 检索全在本地做（标签词 + 原文包含），不额外调模型，不加延迟
//   · 被「约定」标签命中的条目自动进 pinned.md，重要的东西不会因为衰减而丢
const fs = require('node:fs');
const path = require('node:path');
const recall = require('./recall.js');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 固定标签表：让模型只从这几个里选，避免分类越跑越散
// 「称呼」单独一类，是为了让"你平时怎么叫它"能被单独统计（见 nicknameBlock）
const TAGS = ['食物', '用户', '喜好', '计划', '情绪', '约定', '称呼', '其它'];

// 注入时的优先级：名额有限，谁留下谁让位。
// 数字只表示"同等情况下更该被记住"，不参与任何计费；改这里就能调整取舍。
//   约定 4  和用户说好的事，做不到就是失信
//   用户 3  用户的事实（身体、工作、习惯）
//   情绪 3  决定语气（规则 17 全靠它），丢了它说话就会变硬
//   称呼 3  你平时怎么叫它
//   计划 2 / 喜好 2 / 食物 2
//   其它 1  兜底
//   简记 0  只填剩下的空位
// 同分时取时间靠后的 —— 这就是"后来的对话可以顶掉前面不重要的那条"。
const TAG_WEIGHT = { 约定: 4, 用户: 3, 情绪: 3, 称呼: 3, 计划: 2, 喜好: 2, 食物: 2, 其它: 1 };

// 记忆分三档：重点 / 日常 / 简记。级别和标签是两层东西：
// 级别决定"值不值得占注入名额"，标签只在同一级别内部比高低。
// 之所以不把级别混进 TAG_WEIGHT —— [日常/用户]（3）会压过 [重点/其它]（1），
// 一次性的身份流水反而挤掉了长期事实。
const KINDS = ['重点', '日常', '简记'];
const KIND_BASE = { 重点: 30, 日常: 20, 简记: 10 };
// 三档在日记文件里的写法（写回时统一用这个）
function kindLabel(kind, tag) {
  if (kind === '重点') return '[重点/' + (TAGS.includes(tag) ? tag : '其它') + ']';
  if (kind === '日常') return '[日常]';
  return '[简记]';
}

// 称呼变成"固定叫法"的门槛：最近 14 天里，至少 3 个不同日期叫过。
// 按天数而不是按次数 —— 一晚叫三次是玩笑，三天都叫才是习惯。
const NICK_WINDOW_DAYS = 14;
const NICK_MIN_DAYS = 3;
const NICK_MAX_CHARS = 60;


// 本地检索线索：用户这句话里出现这些词，就去翻对应标签的旧日记
const TAG_HINTS = {
  食物: ['吃', '饭', '饿', '馋', '美食', '零食', '菜', '早餐', '午餐', '晚餐', '夜宵', '奶茶', '水果', '肉', '辣', '甜'],
  用户: ['生日', '年龄', '几岁', '工作', '上班', '名字', '住', '家里', '家人', '朋友', '学校', '专业', '电脑', '手机'],
  喜好: ['喜欢', '讨厌', '不爱', '怕', '口味', '爱好', '最想', '受不了'],
  计划: ['打算', '准备', '明天', '下周', '考试', '面试', '目标', '计划', '要去', '想学', '减肥'],
  情绪: ['累', '困', '烦', '开心', '难过', '压力', '焦虑', '无聊', '生气', '难受', '委屈', '崩溃'],
  约定: ['答应', '说好', '别忘了', '记得', '约定', '一定', '明天见'],
};

// 检索时忽略的虚词：不然后面「今天怎么」这种词会把无关的日记也捞出来
const STOP = new Set([
  '今天', '昨天', '明天', '现在', '刚才', '什么', '怎么', '为什么', '是不是', '可以', '一个', '这个',
  '那个', '没有', '还是', '就是', '知道', '觉得', '我们', '你们', '他们', '自己', '真的', '有点',
  '好的', '嗯嗯', '然后', '因为', '所以', '但是', '如果', '已经', '一起', '时候', '一样',
]);

// 中文没有空格：原来按空格切词，中文整句长度 >8 又会被过滤掉，
// 结果 segs 几乎总是空的 —— 检索实际只剩 TAG_HINTS 那几十个预定义词在工作。
// 实测"橘子那个事""舍友很吵那次"全都没命中，而日记里明明有这两条。
// 改成字符级 n-gram：2~4 字滑窗，只要含虚词字就整条丢掉，剩下的基本是实词
// （加班 / 打游戏 / 搬家 / 舍友）。越长越准，命中时按长度加分正好合适。
const STOP_CHARS = new Set(
  '的了着过是有在和与就都也还又很太把他她它我你您这那个些么什谁哪怎么样吗呢吧啊哦嗯被给对从到为以于'.split(''),
);
// 这些 gram 在日记里到处都是，命中它们等于全命中
const STOP_GRAMS = new Set([
  '自己', '今天', '昨天', '明天', '刚才', '现在', '时候',
  '事情', '东西', '什么', '怎么', '可以', '没有', '知道', '觉得', '一个', '这个',
  '那个', '然后', '因为', '所以', '但是', '如果', '已经', '一起', '一样', '还是',
  '就是', '真的', '有点', '你们', '我们', '他们', '为什么',
]);

function grams(text) {
  const t = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = [];
  const seen = new Set();
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= t.length; i++) {
      const g = t.slice(i, i + n);
      if (seen.has(g) || STOP_GRAMS.has(g)) continue;
      let bad = false;
      for (const ch of g) {
        if (STOP_CHARS.has(ch)) {
          bad = true;
          break;
        }
      }
      if (bad) continue;
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

const SUMMARY_PROMPT = [
  '你在替「角色」整理记忆日记。下面是它和用户的一段对话，每条前面是时间。',
  '请提炼成 2~6 条日记，一行一条，严格用这个格式（不要标题、不要解释、不要代码块）：',
  '- HH:MM [重点/标签] 内容 #别名1 #别名2',
  '- HH:MM [日常] 内容',
  '- HH:MM [简记] 内容',
  '标签只能从这八个里选一个：' + TAGS.join('、') + '。',
  '格式是硬性的：级别必须原样写成 [重点/标签]、[日常] 或 [简记]，只写 [称呼]、[喜好] 这种会被当成简记。',
  '三个级别只按一条分界线：这件事过几天还用不用得上。',
  '[重点/…] 一个月后还用得上，而且用户是明确说出口的：身份、固定喜好、长期习惯、',
  '  已经定下来的计划、说好的约定、雷点、生日、称呼。',
  '  只提过一次、没有强调过的不算重点 —— 哪怕带着"喜欢"两个字：',
  '  「想吃橘子」是日常；「我最爱吃橘子，天天都想吃」才是重点。',
  '  下面这些一律不算重点：',
  '  · 玩笑、夸张、气话、反问、撒娇、抱怨一句就过去的',
  '  · 一次性的吃喝、刚打完一局游戏、随口问的一句话',
  '  · 他当时的心情波动 —— 只有他明确说"我最近压力很大"这类持续状态才算',
  '  · 你自己的推测、脑补、安慰、劝说的话 —— 你的话不是他的事实，绝不能当重点记',
  '  除了「称呼」和双方说好的「约定」，一段对话里重点最多 2 条；拿不准就不要写重点。',
  '[日常] 只管这几天：正在占着这段时间的背景、还没结束的状态、这两天的处境和心情。',
  '  例：今天连开三个会 / 明天要交报告 / 舍友晚上打游戏很吵 / 这两天心里发闷 / 想请两天假。',
  '  这些事过一周就没用了，但明天后天还用得上 —— 要记成日常，不要只留个痕迹。',
  '  判断方法：问"三天后还用得上吗"。用得上、但一个月后未必 = 日常；一个月后还在 = 重点。',
  '[简记] 只留当场就散掉的：寒暄、玩笑、一句感慨、没聊出结果的话题。',
  '  大部分内容应该落在「日常」这一档 —— 不是重点，也不是简记。',
  '  其中「约定」最严格：只有双方都说好了要做某件事才算（「明天叫我起床」）；',
  '  你单方面提议、他没答应的不算。',
  '  「称呼」只用于用户给角色起或叫它的名字/外号，写成「用户叫角色XX」；',
  '  用户随口的一句玩笑外号也照记，不用判断重不重要 —— 叫得多了自然会被单独挑出来。',
  '它的感受（嘴硬的地方必须补）：',
  '· 它的人设是傲娇：嘴上凶、否认、嫌弃，心里常常是反的。写日记时别把这些当成真的生气或难过，',
  '  判断标准是它有没有真的不理人、说重话。',
  '· 但它主动搭话、用户几次没接的时候，它是真会有情绪：可能是恼，也可能是委屈、发闷。',
  '  这两样都算真实感受，照那个劲儿写，不要为了维持"只是傲娇"就一律写成生气。',
  '· 只要一条正文里出现它嘴硬的表现（哼、才不是、谁要、别碰、懒得理你、威胁、否认），',
  '  就在正文末尾补一个「（心里：…）」，12 个字以内，写它当时的真实感觉。',
  '· 例：用户叫它「小胖」，它嘴硬反驳（心里：其实不讨厌这个叫法）；',
  '  劝用户早点睡（心里：还想再玩一会儿）。',
  '· 平铺直叙、没有嘴硬的条目不要补；每条最多一个；写的是它自己的感受，不要写成用户的情绪。',
  '· 括号里别把正文刚说过的话再重说一遍（正文说"嘴硬反驳"，括号就只写心里那句）。',
  '· 这段对话里只要出现过嘴硬，整份日记至少有两处「（心里：…）」；一次都没有的，一条也不写。',
  '别名的规则（很重要，别名的作用是让以后能"想起来"）：',
  '· 重点每条跟 2~3 个，日常最多 1 个，简记不写；用 # 开头、空格分隔，写成用户可能用来提起这件事的词',
  '· 只能用这句话里已有的词，或者它的同义说法（蛋炒饭 → #炒饭 #饭；加班 → #晚归 #忙）',
  '· 严禁写偏好、性格、身份、评价类的词（例如 #爱吃辣 #挑食 #学生 #很累）——',
  '  这类词会把"一次发生的事"误当成"长期的事实"，以后会害它说错话',
  '要求：用第三人称「用户」；每条正文不超过 30 个字；只写对话里真实出现过的内容，不要编造；',
  '时间用对话里给出的时间；重点宁少勿多 —— 除了称呼和约定，一段对话里重点最多 2 条，',
  '没有符合条件的就一条都不写；剩下的分到日常和简记，日常多于简记。',
  '三类可以优先保留：称呼、双方明确说好的约定、他明确说过的长期习惯或雷点；其余从严。',
].join('\n');

// 旧日记复核：只调重要性，绝不删、绝不改写内容。
// 判断标准和整理时一样（重点门槛很高），只是这次手里只有日记本身，没有原对话。
const REVIEW_PROMPT = [
  '你在替「角色」复核旧日记条目的"重要性"。已经写成日记的内容，一条都不许删、不许改写，只能调整级别。',
  '下面是某一天的日记，每行是：编号 + 现在的级别 + 时间 + 内容。',
  '级别只有三档，分界线是"多久之后还用得上"：',
  '· 重点 = 一个月后还用得上，而且是用户明确说出口的：身份、长期习惯、已定计划、约定、雷点、生日、称呼、固定口味',
  '· 日常 = 只管这几天：正在经历的事、还没结束的状态、这两天的处境和心情（赶报告、舍友很吵、手头很紧、这两天睡不好）',
  '· 简记 = 当场就散掉的：玩笑、夸张、气话、一次性的吃喝、一句感慨、角色自己的推测和安慰',
  '注意：只提过一次的"我想吃/我喜欢"，不算重点 —— 那是当时的念头，记日常。',
  '只有他说得很绝对（"我从来不吃香菜""我天天都想吃这个"）或者反复提过，才算固定口味。',
  '判断方法：问"三天后还用得上吗" —— 用不上 = 简记；用得上但一个月后未必 = 日常；一个月后还在 = 重点。',
  '照这个尺度判断（例子里的结论要严格照做）：',
  '· [重点/喜好] 用户从来不吃香菜，说从小就不吃 → 不动（固定口味，说得也绝对）',
  '· [重点/用户] 用户手头紧，觉得切好的水果太贵 → 不动（长期处境）',
  '· [重点/喜好] 用户想吃橘子，但在宿舍吃不了 → 降/日常（只提过一次的念头，不是固定喜好）',
  '· [重点/约定] 用户答应等橘子便宜了再吃 → 不动（说好的事）',
  '· [重点/其它] 用户觉得自己有自制力，看小说不至于沉迷 → 降/简记（他对自己的一句辩解）',
  '· [重点/其它] 用户昨晚跑程序到两点，今天一直犯困 → 降/日常（就那一天的作息）',
  '· [重点/其它] 用户觉得角色和网上的 AI 助手不一样 → 降/简记（当时的一句感慨）',
  '· [简记] 用户连开一天会，坐得腰酸 → 升/日常（还没结束的状态）',
  '· [简记] 用户说明天要交实验报告 → 升/日常（这两天的 deadline）',
  '· [简记] 用户说想请假躲两天 → 升/日常（这两天的处境，不是长期事实）',
  '如果级别没问题、只是标签错了（比如外号被记成了"其它"），不要降级，改标签就行：',
  '· [重点/其它] 用户给角色起外号"小胖" → 改/称呼',
  '只输出需要调整的条目，一行一条，格式（不要标点、不要解释）：',
  '<编号> 降/简记        这条当场就散了，降为简记',
  '<编号> 降/日常        这条只管这几天，降到日常',
  '<编号> 升/重点/标签   这条一个月后还用得上，升为重点；标签从 ' + TAGS.join('、') + ' 里选一个',
  '<编号> 升/日常        这条不是重点，但也不该只算简记，升到日常',
  '<编号> 改/标签        级别对、只要换标签（同样从这八个里选）',
  '旧的写法也认：只写「降」等于降/简记，只写「升/标签」等于升/重点/标签。',
  '不需要调整的不要输出；一条都不用改就只输出「无」。',
  '注意：拿不准的一律不动 —— 宁可漏判，也别把真的重点降掉。',
].join('\n');

const WEEKLY_PROMPT = [
  '你在替「角色」把几天的日记压成一份长期印象。',
  '要求：输出 2~5 行，一行一条，格式「- 内容」，每条不超过 25 个字。',
  '只留用户身上长期有用的事：身份、喜好、习惯、重要约定、正在经历的事。',
  '日记里「（心里：…）」是它当时的语气，不要写进摘要；',
  '寒暄和一次性的闲聊全部丢掉；不要编造；不要写日期标题、不要解释、不要代码块。',
].join('\n');

// 月摘要：比周摘要更粗、活得更久的那一层。
// 周摘要默认只留 4 份（约两个月），和"细节检索窗口"几乎重合 ——
// 也就是说梗概并没有比细节活得更久，等于白建一层。
// 月摘要把一整月压成 2~3 行，默认留 12 份，撑住"去年这个时候"这种跨度。
const MONTHLY_PROMPT = [
  '你在替「角色」把一个月的日记压成一份更粗的长期印象。',
  '要求：输出 2~3 行，一行一条，格式「- 内容」，每条不超过 30 个字。',
  '只留半年后还用得上的：身份、长期喜好、长期习惯、重要约定、正在经历的大阶段。',
  '具体某天的小事、寒暄、情绪波动一律丢掉；不要编造；不要写月份标题、不要解释、不要代码块。',
].join('\n');

function pad(n) {
  return String(n).padStart(2, '0');
}
function ymd(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function hm(d) {
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// ISO 周号：用于周摘要文件名
function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7;
  t.setDate(t.getDate() - day + 3);
  const firstThu = new Date(t.getFullYear(), 0, 4);
  const fday = (firstThu.getDay() + 6) % 7;
  firstThu.setDate(firstThu.getDate() - fday + 3);
  const week = 1 + Math.round((t - firstThu) / (7 * 86400000));
  return t.getFullYear() + '-W' + pad(week);
}

function createMemory(opts) {
  const dir = opts.dir;
  const complete = opts.complete; // async (messages) => { ok, reply }
  const idleMs = Math.max(1000, Number(opts.idleMs) || 10 * 60 * 1000);
  const injectDays = Math.max(1, Number(opts.injectDays) || 3);
  const maxChars = Math.max(200, Number(opts.maxChars) || 1400);
  // 检索窗口：只在这些天以内的日记里翻旧事。以前写死 60。
  // 每天聊得多、想让它记得更久，把它调大（默认一年，按日期算不按文件个数算）。
  const retentionDays = Math.max(3, Number(opts.retentionDays) || 365);
  // 周摘要保留几份（每份约两周）。以前写死 4，和 60 天窗口几乎重合，
  // 等于"梗概并没有比细节活得更久" —— 26 份约等于一年。
  const weeklyKeep = Math.max(1, Number(opts.weeklyKeep) || 26);
  // 月摘要保留几份。周摘要只压到两个月左右，再往前就靠这一层撑着。
  const monthlyKeep = Math.max(1, Number(opts.monthlyKeep) || 12);
  const log = opts.log || (() => {});

  const rawDir = path.join(dir, 'raw');
  const diaryDir = path.join(dir, 'diary');
  const weeklyDir = path.join(diaryDir, 'weekly');
  const monthlyDir = path.join(diaryDir, 'monthly');
  // 「它自己说过的话」单独一个区：raw 只放对话（用户说了什么、它答了什么），
  // 主动搭话/留言/随笔/小物件不是对话，混进 raw 会让"谁说的"变乱，
  // 但完全不留又接不上自己的话头 —— 所以单独存，按需注入、按需进日记。
  const selfDir = path.join(dir, 'self');
  const pendingPath = path.join(dir, '.pending.json');
  const digestedPath = path.join(diaryDir, '.digested.json');
  const digestedMonthlyPath = path.join(diaryDir, '.digested-monthly.json');
  const pinnedPath = path.join(dir, 'pinned.md');
  // 哪些日子已经复核过（一天只复核一次，避免反复升降、也避免反复花钱）
  const reviewedPath = path.join(dir, '.reviewed.json');

  let entries = []; // [{ t: Date, user, reply }]
  let idleTimer = null;
  // 整理失败后的自动重试：网络抖一下就丢掉一段记忆太亏，但也别无限重试烧钱
  let retryTimer = null;
  let flushFails = 0;
  let flushing = null;
  let weeklyBusy = false;
  let contextCache = null;
  let contextCacheKey = null;

  function ensureDirs() {
    for (const d of [dir, rawDir, diaryDir, weeklyDir, monthlyDir, selfDir]) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch (e) {
        /* 目录建不出来：后面每次写都会 catch，功能降级但不崩 */
      }
    }
  }

  function ensurePinned() {
    try {
      if (fs.existsSync(pinnedPath)) return;
      fs.writeFileSync(
        pinnedPath,
        [
          '# 永远记得的事（不会随时间变模糊）',
          '# 一行一条，可以直接在这里手写，例如：',
          '# - 主人晚上两点才睡',
          '# 整理日记时，标了 [重点/约定] 的条目会自动加到这里。',
          '',
        ].join('\n'),
        'utf8',
      );
    } catch (e) {
      /* 写不了就跳过 */
    }
  }

  function readPinned() {
    try {
      return fs
        .readFileSync(pinnedPath, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
    } catch (e) {
      return [];
    }
  }

  function addPinned(lines) {
    if (!lines.length) return;
    try {
      ensurePinned();
      const now = readPinned();
      const seen = new Set(now.map((s) => s.replace(/^-\s*/, '')));
      const add = [];
      for (const raw of lines) {
        const text = String(raw).replace(/^-\s*/, '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        add.push('- ' + text);
      }
      if (!add.length) return;
      fs.appendFileSync(pinnedPath, add.join('\n') + '\n', 'utf8');
      contextCache = null;
      log('钉住 ' + add.length + ' 条约定');
    } catch (e) {
      log('pinned 写入失败：' + (e && e.message));
    }
  }

  function readPending() {
    try {
      if (!fs.existsSync(pendingPath)) return [];
      const j = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      const list = Array.isArray(j && j.entries) ? j.entries : [];
      return list
        .filter((e) => e && e.user)
        .map((e) => ({ t: new Date(e.t || Date.now()), user: String(e.user), reply: String(e.reply || '') }));
    } catch (e) {
      return [];
    }
  }

  function writePending() {
    try {
      if (!entries.length) {
        if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
        return;
      }
      fs.writeFileSync(
        pendingPath,
        JSON.stringify(
          { savedAt: new Date().toISOString(), entries: entries.map((e) => ({ t: e.t.toISOString(), user: e.user, reply: e.reply })) },
          null,
          1,
        ),
        'utf8',
      );
    } catch (e) {
      log('pending 写入失败：' + (e && e.message));
    }
  }

  function appendRaw(entry) {
    try {
      ensureDirs();
      const p = path.join(rawDir, ymd(entry.t) + '.jsonl');
      // anim 只落在原始日志里：用来事后核验"那句话说的时候它到底做没做动作"。
      // 不参与日记整理（整理只读 user/reply），也不进上下文。
      const line = { t: entry.t.toISOString(), user: entry.user, reply: entry.reply };
      if (entry.anim) line.anim = entry.anim;
      fs.appendFileSync(p, JSON.stringify(line) + '\n', 'utf8');
    } catch (e) {
      log('原始日志写入失败：' + (e && e.message));
    }
  }

  // ---------- 它自己说过的话（主动搭话 / 留言 / 随笔 / 小物件） ----------
  // 一条一行 JSON。heard = 用户后来接没接；d = 有没有被整理进日记。
  function selfPath(dateStr) {
    return path.join(selfDir, dateStr + '.jsonl');
  }

  function readSelfDay(dateStr) {
    try {
      const p = selfPath(dateStr);
      if (!fs.existsSync(p)) return [];
      return fs
        .readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean)
        .map((x) => ({
          t: new Date(x.t),
          kind: String(x.kind || 'speak'),
          text: String(x.text || ''),
          file: String(x.file || ''),
          heard: !!x.heard,
          d: !!x.d,
        }))
        .filter((x) => !Number.isNaN(x.t.getTime()));
    } catch (e) {
      return [];
    }
  }

  function writeSelfDay(dateStr, list) {
    try {
      fs.mkdirSync(selfDir, { recursive: true });
      const body = list
        .map((x) =>
          JSON.stringify({
            t: x.t.toISOString(),
            kind: x.kind,
            text: x.text,
            file: x.file || undefined,
            heard: x.heard ? 1 : 0,
            d: x.d ? 1 : 0,
          }),
        )
        .join('\n');
      fs.writeFileSync(selfPath(dateStr), body ? body + '\n' : '', 'utf8');
    } catch (e) {
      log('自己的话写入失败：' + (e && e.message));
    }
  }

  function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  // 近半天（今天 + 昨天）里它自己说过的话，按时间正序
  function recentSelf(hours) {
    const now = Date.now();
    const days = [ymd(new Date()), ymd(new Date(now - 86400000))];
    const list = [];
    for (const d of days) for (const e of readSelfDay(d)) list.push(e);
    const win = (Number(hours) || 12) * 3600000;
    return list.filter((e) => now - e.t.getTime() <= win).sort((a, b) => a.t - b.t);
  }

  // 注入块：只放"还能接得上"的几句，且行数内容压在 ~90 字。
  // 这类话的权重本来就低（它自己的碎话），不该跟用户的重点记忆抢注入预算。
  // 按时间分三段：
  //   12 小时内 → 给原话（还能顺着接一句）
  //   12~48 小时 → 只给一句统计（昨天开口几次、几次没被接），不搬原话
  //   48 小时以上 → 不注入（过了能顺口提的窗口，情绪那部分归主动行为自己管）
  // 另外：用户这句话超过 12 个字（多半在问正经事），整块跳过 ——
  // 不然它一边答问题一边惦记自己早上说了什么，最容易答得驴唇不对马嘴。
  function selfBlock(userText) {
    const q = String(userText || '').trim();
    if (q.length >= 12) return '';
    const now = Date.now();
    const fresh = recentSelf(12);
    const rows = [];
    const CAP = 90;
    let used = 0;
    const push = (s) => {
      if (used + s.length > CAP) return false;
      rows.push(s);
      used += s.length;
      return true;
    };
    // 12 小时内：被接住的 1 条 + 没被接的 2 条
    for (const e of fresh.filter((e) => e.heard).slice(-1)) {
      push('· ' + hm(e.t) + ' 你说过「' + clip(e.text, 16) + '」，他后来应了你一声');
    }
    for (const e of fresh.filter((e) => !e.heard && (e.kind === 'speak' || e.kind === 'note')).slice(-2)) {
      push(
        '· ' + hm(e.t) + (e.kind === 'note' ? ' 留言「' : ' 你说「') + clip(e.text, 16) + '」' +
          (e.kind === 'note' ? '，他没提' : '，他没接'),
      );
    }
    for (const e of fresh.filter((x) => x.kind === 'thought' || x.kind === 'gift').slice(-1)) {
      const what = e.kind === 'gift' ? clip(String(e.text || ''), 16) : '';
      push(
        '· ' + hm(e.t) +
          (e.kind === 'thought'
            ? ' 你写过一段随笔，没跟他提过'
            : what
              ? ' 你留了个小东西「' + what + '」，他没说什么'
              : ' 你留了个小东西，他没说什么'),
      );
    }
    // 最近没有原话，就只给昨天（48 小时内）的统计：知道个大概，不搬原话
    if (!rows.length) {
      const older = recentSelf(48).filter((e) => now - e.t.getTime() > 12 * 3600000);
      if (older.length >= 2) {
        const miss = older.filter((e) => !e.heard).length;
        push('· 昨天前后你主动开口 ' + older.length + ' 次' + (miss ? '，' + miss + ' 次他没接' : ''));
      }
    }
    if (!rows.length) return '';
    return (
      '【你自己刚才说过的话】\n' +
      rows.join('\n') +
      '\n（这些是你自己说的话，不是用户说的。想接就顺口接一句，不想接就放着，别硬拉回来。）'
    );
  }

  // 整理日记时的附加素材：这段时间它自己的动静。
  // 交给模型判断要不要写 —— 这就是"选择性进入记忆库"：值得记的才留，碎碎念不留。
  function selfMaterial(batch) {
    if (!Array.isArray(batch) || !batch.length) return { text: '', keys: [] };
    const now = Date.now();
    const first = Math.min(...batch.map((e) => e.t.getTime()));
    const days = new Set();
    // 从这批对话前一天起（同一天里早些时候的搭话也要带上），最多往回翻 3 天
    for (let i = 0; i < 3; i++) days.add(ymd(new Date(first - i * 86400000)));
    days.add(ymd(new Date(now)));
    const rows = [];
    for (const d of days) {
      for (const e of readSelfDay(d)) {
        if (e.d) continue;
        if (e.t.getTime() > now) continue;
        const label =
          e.kind === 'speak' ? '主动搭话' : e.kind === 'note' ? '留了条留言' : e.kind === 'thought' ? '写了段随笔' : '留了个小东西';
        // 附件/礼物：能记下"做的是什么"就别用文件名（文件名只有日期，没信息量）
        const body = e.kind === 'gift'
          ? clip(String(e.text || ''), 30) || path.basename(e.file || '') || '（附件文件）'
          : clip(e.text, 40);
        rows.push({ e, line: '- ' + hm(e.t) + ' 它' + label + '：' + body + (e.heard ? '（用户接了）' : '（用户没接）') });
      }
    }
    if (!rows.length) return { text: '', keys: [] };
    rows.sort((a, b) => a.e.t - b.e.t);
    const picked = rows.slice(-4); // 只带最近 4 条，别把整理输入撑大
    return {
      text:
        '\n\n（另外，这段时间它自己也有动静，这些不是对话。只挑以后还会想起来的一两条写成日记，' +
        '不值得记就一条都不写；写就用「简记」，没被搭理的那点情绪可以放进「（心里：…）」：）\n' +
        picked.map((r) => r.line).join('\n'),
      keys: picked.map((r) => ({ day: ymd(r.e.t), t: r.e.t.getTime() })),
    };
  }

  function markSelfDigested(keys) {
    const byDay = new Map();
    for (const k of keys || []) {
      if (!k || !k.day) continue;
      if (!byDay.has(k.day)) byDay.set(k.day, new Set());
      byDay.get(k.day).add(Number(k.t));
    }
    for (const [day, set] of byDay) {
      const list = readSelfDay(day);
      let hit = false;
      for (const e of list) {
        if (set.has(e.t.getTime())) {
          e.d = true;
          hit = true;
        }
      }
      if (hit) writeSelfDay(day, list);
    }
  }

  function appendDiary(lines) {
    // lines: [{ date: 'YYYY-MM-DD', text: '- HH:MM [重点/食物] ...', pin: '内容'|null }]
    const byDate = new Map();
    const pins = [];
    for (const l of lines) {
      if (!byDate.has(l.date)) byDate.set(l.date, []);
      byDate.get(l.date).push(l.text);
      if (l.pin) pins.push(l.pin);
    }
    for (const [date, items] of byDate) {
      const p = path.join(diaryDir, date + '.md');
      let body = '';
      if (fs.existsSync(p)) {
        body = fs.readFileSync(p, 'utf8');
      } else {
        const d = new Date(date + 'T12:00:00');
        body = '# ' + date + ' ' + WEEK[d.getDay()] + '\n\n';
      }
      if (!body.endsWith('\n')) body += '\n';
      body += items.join('\n') + '\n';
      fs.writeFileSync(p, body, 'utf8');
      contextCache = null;
    }
    addPinned(pins);
  }

  // 把模型输出解析成日记行；解析不出就退化为一条兜底记录（保证不丢）
  function parseSummary(reply, sessionEntries) {
    const out = [];
    const seen = new Set();
    for (const rawLine of String(reply || '').split(/\r?\n/)) {
      let s = rawLine.trim().replace(/^[-*·•]\s*/, '');
      if (!s) continue;
      // 模型偶尔把标签写成 [称呼] / [约定] 这种残缺形式（没带"重点/"前缀）。
      // 以前这种行整行被丢掉，内容就没了。
      // 现在分两种：方括号里是正经标签名（称呼/约定/喜好…）就补成 [重点/标签]——
      // 因为简记本来不该带标签，出现标签名就说明它想标重点（实测确实漏写过）；
      // 若是别的怪词，才按简记收下，内容不丢。
      // 注意：已经带级别词的（[日常/食物]、[简记]）不能进这个分支，否则日常会被吞成简记。
      let preTime = null;
      const bareTag = s.match(/^(\d{1,2}:\d{2})\s*[\[【]\s*([^\]】]{1,8})\s*[\]】]\s*(.+)$/);
      if (bareTag && !/^(重点|日常|简记)/.test(bareTag[2])) {
        preTime = bareTag[1];
        const word = bareTag[2].trim();
        s = (TAGS.includes(word) ? '[重点/' + word + '] ' : '[简记] ') + bareTag[3];
      }
      // 支持 [重点/食物]、[日常]、[日常/情绪]、【简记】、重点：xxx 这些写法
      const m = s.match(
        /^(\d{1,2}:\d{2})?\s*[\[【(（]?\s*(重点|日常|简记)\s*(?:[\/／|]\s*([^\]】)）\s]+))?\s*[\]】)）]?\s*[:：]?\s*(.+)$/,
      );
      let time = null;
      let kind = null;
      let tag = '';
      let text = '';
      if (m) {
        time = m[1] || preTime || null;
        kind = m[2];
        tag = (m[3] || '').trim();
        text = m[4];
      } else if (/^[\[【]/.test(s) || /^(重点|日常|简记)/.test(s)) {
        kind = /日常/.test(s) ? '日常' : /重点/.test(s) ? '重点' : '简记';
        text = s.replace(/[\[【(（]?\s*(重点|日常|简记)\s*([\/／|][^\]】)）]*)?\s*[\]】)）]?\s*[:：]?\s*/, '');
      } else {
        continue; // 标题、说明性文字直接丢掉
      }
      // 行尾的 #别名 单独拆出来：只用来检索，不参与注入（简记不带别名，日常最多 1 个）
      const aliasHits = text.match(/#[^\s#，,。；;、]{1,10}/g) || [];
      const aliasMax = kind === '简记' ? 0 : kind === '日常' ? 1 : 3;
      const aliases = aliasHits.map((a) => a.slice(1)).slice(0, aliasMax);
      text = text.replace(/#[^\s#，,。；;、]{1,10}/g, '');
      text = text.replace(/\s+/g, ' ').trim();
      // 它的感受：把（心里：…）抠出来单独限长，再统一挂回正文末尾。
      // 单独处理是为了：正文仍按 60 字截断、不会把感受截掉；也别让感受混进别名。
      let feel = '';
      const fm = text.match(/[（(〔【]\s*心里\s*[:：]\s*([^）)〕】]{1,20}?)\s*[）)〕】]/);
      if (fm) {
        feel = fm[1].replace(/\s+/g, ' ').replace(/[。，,；;]+$/, '').trim();
        text = text.replace(fm[0], ' ').replace(/\s+/g, ' ').trim();
      } else {
        // 模型偶尔不写括号，直接把「心里：…」塞在句中/句末（取到标点为止）
        const tail = text.match(/心里\s*[:：]\s*([^。！？!?\n]{1,20})/);
        if (tail) {
          feel = tail[1].replace(/\s+/g, ' ').replace(/[。，,；;]+$/, '').trim();
          text = text.replace(tail[0], '').replace(/\s+/g, ' ').replace(/[\s，。；]+$/, '').trim();
        }
      }
      // 抠完只剩一两个字（整行只有一句感受、没有事件）：没什么可记的，丢掉
      if (!text || text.length < 2) continue;
      if (text.length > 60) text = text.slice(0, 60);
      if (feel.length > 24) feel = feel.slice(0, 24);
      const full = feel ? text + '（心里：' + feel + '）' : text;
      if (kind === '简记') tag = '';
      else if (!TAGS.includes(tag)) tag = '其它';
      if (seen.has(kind + tag + full)) continue;
      seen.add(kind + tag + full);
      out.push({ time, kind, tag, text: full, feel, aliases });
      if (out.length >= 6) break;
    }
    if (!out.length && sessionEntries.length) {
      const first = sessionEntries[0];
      // 兜底只敢记简记：模型没给出可用输出时，我们其实什么都没判断出来，
      // 这时候造一条"重点"等于凭空下发一张长期饭票（以前就是 [重点/其它]，最容易变假记忆）
      out.push({ time: hm(first.t), kind: '简记', tag: '', text: '用户聊到：' + first.user.replace(/\s+/g, ' ').slice(0, 26) });
    }
    return out;
  }

  // 一次调用最多把多少字符的对话交给模型。
  // 以前是一次调用吞下整批，多出来的直接 slice 掉 —— 那部分对话永远不整理
  // （实测 100 轮 6400 字符，40% 进不了记忆，只剩在 raw 里没人读）。
  // 现在按轮切成多批逐批整理，代价是整理调用变多（100 轮约 2~3 次，一天多花不到 0.005 元）。
  const SUMMARY_INPUT_CHARS = 3800;

  function transcriptLine(e) {
    return hm(e.t) + ' 用户：' + e.user + '\n' + hm(e.t) + ' 角色：' + e.reply;
  }

  // 按轮切批：每批的 transcript 不超过 SUMMARY_INPUT_CHARS。
  // 切在轮与轮之间，绝不切在某一轮里面（一轮被切开，用户和它的回话就对不上了）。
  function chunkEntries(batch) {
    const out = [];
    let cur = [];
    let curLen = 0;
    for (const e of batch) {
      const len = transcriptLine(e).length + 1;
      if (cur.length && curLen + len > SUMMARY_INPUT_CHARS) {
        out.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(e);
      curLen += len;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // 一批日记该落到哪一天：一批对话可能跨午夜（23:50 聊、00:10 才整理），
  // 整批按最后一条的日期一刀切会把前半夜的条目写进后一天。
  // 所以按每行自己的 HH:MM 找最近的那一天 —— 分批整理之后，每批各算各的。
  function dayResolver(list) {
    const dayList = [...new Set(list.map((e) => ymd(e.t)))];
    const lastDay = ymd(list[list.length - 1].t);
    if (dayList.length <= 1) return () => dayList[0] || lastDay;
    const times = list.map((e) => e.t.getTime());
    return function dayOf(timeStr) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
      if (!m) return lastDay; // 模型没给时间：跟这批最后一条走
      let best = lastDay;
      let bestGap = Infinity;
      for (const d of dayList) {
        const ts = new Date(d + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00').getTime();
        const gap = Math.min(...times.map((bt) => Math.abs(bt - ts)));
        if (gap < bestGap) {
          bestGap = gap;
          best = d;
        }
      }
      return best;
    };
  }

  async function doFlush(reason) {
    if (!entries.length) return { ok: true, skipped: true };
    const batch = entries;
    entries = [];
    writePending();

    const started = Date.now();
    // 它自己的动静（搭话/留言/随笔/小物件）只随第一批递进去一次，明确让它自己筛：
    // 全记会变成一本自言自语，全不记又像没发生过
    const extra = selfMaterial(batch);
    const chunks = chunkEntries(batch);

    let totalLines = 0;
    let doneRounds = 0;

    for (let ci = 0; ci < chunks.length; ci++) {
      const part = chunks[ci];
      const rest = chunks.slice(ci + 1).flat();
      const tag = chunks.length > 1 ? '，第 ' + (ci + 1) + '/' + chunks.length + ' 批' : '';
      let reply = '';

      try {
        const r = await complete([
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: part.map(transcriptLine).join('\n') + (ci === 0 ? extra.text : '') },
        ]);
        if (!r || !r.ok) {
          // 这一批失败：把它和后面没做的都放回队列，已落盘的批次不回滚
          entries = part.concat(rest).concat(entries);
          writePending();
          log('整理日记失败（' + reason + tag + '）：' + ((r && r.message) || '未知错误') + '，剩下的已保留待下次重试');
          noteFlushFail('接口返回失败：' + ((r && r.message) || '未知错误'));
          return { ok: false, message: (r && r.message) || '未知错误', done: doneRounds, batches: chunks.length };
        }
        reply = r.reply;
      } catch (e) {
        entries = part.concat(rest).concat(entries);
        writePending();
        log('整理日记异常（' + reason + tag + '）：' + (e && e.message));
        noteFlushFail('异常：' + ((e && e.message) || '未知'));
        return { ok: false, message: (e && e.message) || '异常', done: doneRounds, batches: chunks.length };
      }

      const dayOf = dayResolver(part);
      const parsed = parseSummary(reply, part);
      const lines = parsed.map((p) => {
        const t = p.time || hm(part[part.length - 1].t);
        const date = dayOf(t);
        const label = kindLabel(p.kind, p.tag);
        const aliasStr = p.aliases && p.aliases.length ? ' ' + p.aliases.map((a) => '#' + a).join(' ') : '';
        return {
          date,
          text: '- ' + t + ' ' + label + ' ' + p.text + aliasStr,
          // 进永久层的是"说好的事"本身，不带当时的语气。
          // 只有【重点】里的约定才钉住 —— [日常/约定] 这种是随口应一声，不能变成永久承诺
          pin: p.kind === '重点' && p.tag === '约定' ? p.text.replace(/（心里：[^）]*）/g, '').trim() : null,
        };
      });

      try {
        appendDiary(lines);
      } catch (e) {
        entries = part.concat(rest).concat(entries);
        writePending();
        log('日记写入失败（' + reason + tag + '）：' + (e && e.message));
        noteFlushFail('写日记失败：' + ((e && e.message) || '未知'));
        return { ok: false, message: (e && e.message) || '写入失败', done: doneRounds, batches: chunks.length };
      }

      // 这一批已经落盘：立刻把它从待整理队列里划掉。
      // 之后进程崩了，下次只会重跑剩下的批，不会把已写好的日记再写一遍。
      entries = rest.concat(entries);
      writePending();

      totalLines += lines.length;
      doneRounds += part.length;
      log('已整理 ' + part.length + ' 段对话 → ' + lines.length + ' 条日记（' + reason + tag + '）');
    }

    log('整理完成：' + doneRounds + ' 段对话 → ' + totalLines + ' 条日记（' + reason + '，' + chunks.length + ' 批，' + (Date.now() - started) + 'ms）');
    if (extra.keys.length) markSelfDigested(extra.keys); // 用过就标记，别下次重复塞
    flushFails = 0; // 成功一次就重新计数（下次失败仍会重试）
    // 顺手复核一天旧日记（只调重要性，不删），再压周摘要 —— 顺序不能反：
    // 周摘要只从「重点」里提炼，先复核才能让被误标的那些不被带进长期印象
    reviewDue(1)
      .catch(() => {})
      .then(() => {
        maybeSummarizeWeekly();
        maybeSummarizeMonthly();
      });
    return { ok: true, count: totalLines, batches: chunks.length };
  }

  // 整理失败：记一行到 .errors.log（宿主没有控制台时也要留个地方查），
  // 5 分钟后自己再试一次。连续失败 4 次就停手，等下次聊天或下次启动再补
  function noteFlushFail(msg) {
    flushFails += 1;
    try {
      const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
      fs.appendFileSync(path.join(dir, '.errors.log'), t + '  整理失败（第 ' + flushFails + ' 次）：' + msg + '\n', 'utf8');
    } catch (e) {
      /* 连错误日志都写不进去，就算了 */
    }
    if (flushFails >= 4) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (entries.length) flush('失败重试').catch(() => {});
    }, 5 * 60000);
  }

  function flush(reason) {
    if (flushing) {
      // 正在整理：等它结束后再跑一轮（这期间新记录会进 entries）
      return flushing.then(() => (entries.length ? flush(reason) : { ok: true, skipped: true }));
    }
    if (!entries.length) return Promise.resolve({ ok: true, skipped: true });
    flushing = doFlush(reason).finally(() => {
      flushing = null;
    });
    return flushing;
  }

  // ---------- 周摘要：把 4 天以前的日记压成长期印象 ----------
  function readDigested() {
    try {
      const j = JSON.parse(fs.readFileSync(digestedPath, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch (e) {
      return {};
    }
  }
  function writeDigested(map) {
    try {
      fs.writeFileSync(digestedPath, JSON.stringify(map, null, 1), 'utf8');
    } catch (e) {
      log('digested 写入失败：' + (e && e.message));
    }
  }

  function diaryFiles() {
    try {
      return fs
        .readdirSync(diaryDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort();
    } catch (e) {
      return [];
    }
  }

  // ---------- 旧日记复核：只调重要性，不删内容 ----------
  function readReviewed() {
    try {
      const j = JSON.parse(fs.readFileSync(reviewedPath, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch (e) {
      return {};
    }
  }
  function writeReviewed(map) {
    try {
      fs.writeFileSync(reviewedPath, JSON.stringify(map, null, 1), 'utf8');
    } catch (e) {
      log('复核记录写入失败：' + (e && e.message));
    }
  }

  // 从永久层撤掉某一条（内容还在日记里，只是不再"永远记得"）
  function unpinText(text) {
    try {
      const t = String(text || '').replace(/（心里：[^）]*）/g, '').trim();
      if (!t) return false;
      const raw = fs.readFileSync(pinnedPath, 'utf8');
      const rows = raw.split(/\r?\n/);
      const keep = rows.filter((l) => l.replace(/^-\s*/, '').trim() !== t);
      if (keep.length === rows.length) return false;
      fs.writeFileSync(pinnedPath, keep.join('\n'), 'utf8');
      contextCache = null;
      log('pinned 撤下一条（复核后降级）：' + t.slice(0, 20));
      return true;
    } catch (e) {
      return false;
    }
  }

  // 复核一天：把级别不合适的行改标签，正文字一个都不动
  async function reviewDay(date) {
    const p = path.join(diaryDir, date + '.md');
    let txt = '';
    try {
      txt = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return { ok: true, changes: [], reason: '没有这一天' };
    }
    const rows = txt.split(/\r?\n/);
    const rowIdx = []; // 模型编号 → rows 下标
    const brief = [];
    rows.forEach((line, i) => {
      const parsed = parseDiaryLine(line);
      if (!parsed) return;
      rowIdx.push(i);
      brief.push(
        rowIdx.length + ' ' + kindLabel(parsed.kind, parsed.tag) + ' ' + parsed.time + ' ' + parsed.text,
      );
    });
    if (!brief.length) return { ok: true, changes: [], reason: '这一天没条目' };

    const r = await complete([
      { role: 'system', content: REVIEW_PROMPT },
      { role: 'user', content: date + '\n' + brief.join('\n').slice(0, 2400) },
    ]);
    if (!r || !r.ok) {
      log('复核 ' + date + ' 失败：' + ((r && r.message) || '未知') + '（下次再试）');
      return { ok: false, reason: 'call-failed' };
    }

    const changes = [];
    for (const raw of String(r.reply || '').split(/\r?\n/)) {
      // <编号> 动作[/参数1][/参数2]。参数可能是级别（日常/简记/重点）也可能是标签
      const m = raw
        .trim()
        .match(/^(\d{1,2})\s*[.、:：]?\s*(降|升|改)\s*(?:[\/／|]\s*([^\s\/／|#，,。；]+))?\s*(?:[\/／|]\s*([^\s\/／|#，,。；]+))?/);
      if (!m) continue;
      const i = rowIdx[Number(m[1]) - 1];
      if (i === undefined) continue;
      const parsed = parseDiaryLine(rows[i]);
      if (!parsed) continue;
      let a1 = (m[3] || '').trim();
      let a2 = (m[4] || '').trim();
      const act = m[2];
      // 兼容旧写法：「升/喜好」= 升重点/喜好；「改/喜好」
      if (act === '升' && a1 && !/^(重点|日常|简记)$/.test(a1)) {
        a2 = a1;
        a1 = '重点';
      }
      if ((act === '改' || act === '降') && !a1 && a2) a1 = a2;
      // 降：目标是日常或简记（只写「降」= 简记，跟旧输出一致）
      if (act === '降') {
        const to = a1 === '日常' ? '日常' : '简记';
        if (parsed.kind === to || parsed.kind === '简记') continue;
        rows[i] = rows[i].replace(/\[(?:重点|日常|简记)(?:\/[^\]]*)?\]/, kindLabel(to, parsed.tag));
        changes.push({ n: Number(m[1]), to, text: parsed.text, was: parsed.tag, wasKind: parsed.kind });
      } else if (act === '改') {
        // 只换标签，级别不动（旧日记里外号常被记成 [重点/其它]，降到简记反而丢信息）
        if (parsed.kind !== '重点') continue;
        const tag = TAGS.includes(a1) ? a1 : '';
        if (!tag || tag === parsed.tag) continue;
        rows[i] = rows[i].replace(/\[(?:重点|日常|简记)(?:\/[^\]]*)?\]/, '[重点/' + tag + ']');
        changes.push({ n: Number(m[1]), to: '重点/' + tag, text: parsed.text, was: parsed.tag });
      } else {
        // 升：升/日常 或 升/重点/标签
        const to = a1 === '日常' ? '日常' : '重点';
        if (parsed.kind === to) continue;
        if (to === '日常') {
          rows[i] = rows[i].replace(/\[(?:重点|日常|简记)(?:\/[^\]]*)?\]/, '[日常]');
          changes.push({ n: Number(m[1]), to, text: parsed.text, wasKind: parsed.kind });
        } else {
          const tag = TAGS.includes(a2) ? a2 : '其它';
          rows[i] = rows[i].replace(/\[(?:重点|日常|简记)(?:\/[^\]]*)?\]/, '[重点/' + tag + ']');
          changes.push({ n: Number(m[1]), to: '重点/' + tag, text: parsed.text, wasKind: parsed.kind });
        }
      }
    }

    if (changes.length) {
      try {
        fs.writeFileSync(p, rows.join('\n'), 'utf8');
        contextCache = null;
      } catch (e) {
        log('复核写回失败 ' + date + '：' + (e && e.message));
        return { ok: false, reason: 'write-failed' };
      }
      // 被降级的"约定"要从永久层撤下来（否则它还会永远注入）—— 降到日常也一样撤
      for (const c of changes) if (c.to !== '重点' && c.to.indexOf('重点/') !== 0 && c.was === '约定') unpinText(c.text);
      // 升成 [重点/约定] 的补进永久层：不然它只在日记里，下次整理时不会被永远注入
      for (const c of changes) {
        if (c.to === '重点/约定') addPinned([c.text.replace(/（心里：[^）]*）/g, '').trim()]);
      }
      log(
        '复核 ' + date + '：调整 ' + changes.length + ' 条（' +
          changes.map((c) => c.n + '→' + c.to).join('，') + '，内容未删）',
      );
    }
    return { ok: true, changes };
  }

  // 找还没复核过的旧日子：至少在 3 天前（今天/昨天/前天还在正常注入，不动），最多回溯 30 天
  async function reviewDueInner(limit) {
    const max = Math.max(1, Number(limit) || 1);
    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const cutoff = ymd(new Date(base.getTime() - 3 * 86400000)); // 含这一天
    const floor = ymd(new Date(base.getTime() - 30 * 86400000));
    const reviewed = readReviewed();
    const now = Date.now();
    // 失败过的隔 6 小时再试：网络抖一下就永久跳过太亏，但每次整理都重试又会一直花钱
    const needReview = (d) => {
      const rec = reviewed[d];
      if (!rec) return true;
      if (!rec.failed) return false;
      const at = Date.parse(rec.at);
      return !Number.isFinite(at) || now - at > 6 * 3600000;
    };
    const due = diaryFiles()
      .map((f) => f.slice(0, 10))
      .filter((d) => d <= cutoff && d >= floor && needReview(d))
      .sort();
    if (!due.length) return { ok: true, days: 0, remaining: 0 };

    let done = 0;
    for (const d of due.slice(0, max)) {
      let n = 0;
      let failed = false;
      try {
        const r = await reviewDay(d);
        n = (r && r.changes && r.changes.length) || 0;
        failed = !(r && r.ok);
      } catch (e) {
        failed = true;
        log('复核异常 ' + d + '：' + (e && e.message));
      }
      reviewed[d] = failed
        ? { at: new Date().toISOString(), changes: 0, failed: true }
        : { at: new Date().toISOString(), changes: n };
      writeReviewed(reviewed);
      done += 1;
    }
    return { ok: true, days: done, remaining: Math.max(0, due.length - done) };
  }

  // 同一时刻只允许一趟复核：启动补复合和整理后复核可能撞在一起，
  // 撞上就跳过（该复核的日子下次还会轮到，不需要抢着做）
  let reviewing = false;
  async function reviewDue(limit) {
    if (reviewing) return { ok: true, days: 0, remaining: 0, skipped: true };
    reviewing = true;
    try {
      return await reviewDueInner(limit);
    } finally {
      reviewing = false;
    }
  }

  function maybeSummarizeWeekly() {
    if (weeklyBusy) return;
    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const cutoff = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 3); // 3 天以内的不动
    const digested = readDigested();
    const due = diaryFiles().filter((f) => {
      const date = f.slice(0, 10);
      return date < ymd(cutoff) && !digested[date];
    });
    if (!due.length) return;
    // 一次最多消化 14 天（省钱），但"标记已整理"只能标这 14 天。
    // 以前结尾是 for (const f of due) —— 停跑一个月再回来时 due 有 30 天，
    // 只给前 14 天做了摘要，剩下 16 天却被一起标成 done，从此永远是空白。
    const batch = due.slice(0, 14);
    weeklyBusy = true;
    (async () => {
      try {
        const picked = [];
        for (const f of batch) {
          let txt = '';
          try {
            txt = fs.readFileSync(path.join(diaryDir, f), 'utf8');
          } catch (e) {
            continue;
          }
          const date = f.slice(0, 10);
          for (const line of txt.split(/\r?\n/)) {
            if (!/\[重点/.test(line)) continue;
            const s = line.trim().replace(/^-\s*/, '');
            if (s) picked.push(date.slice(5) + ' ' + s);
          }
        }
        if (!picked.length) {
          // 这 14 天全是闲聊：直接标记，不再花钱（只标这批，剩下的下次再看）
          for (const f of batch) digested[f.slice(0, 10)] = 'skip';
          writeDigested(digested);
          return;
        }
        const r = await complete([
          { role: 'system', content: WEEKLY_PROMPT },
          { role: 'user', content: picked.join('\n').slice(0, 3000) },
        ]);
        if (!r || !r.ok) {
          log('周摘要失败：' + ((r && r.message) || '未知') + '（下次重试）');
          return;
        }
        const items = String(r.reply || '')
          .split(/\r?\n/)
          .map((s) => s.trim().replace(/^[-*·•]\s*/, ''))
          .filter((s) => s.length >= 2)
          .slice(0, 5);
        if (items.length) {
          const first = batch[0].slice(0, 10);
          const last = batch[batch.length - 1].slice(0, 10);
          const p = path.join(weeklyDir, isoWeek(new Date(first + 'T12:00:00')) + '.md');
          let body = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# ' + isoWeek(new Date(first + 'T12:00:00')) + '\n\n';
          if (!body.endsWith('\n')) body += '\n';
          // 一句一条，日期只标在句前：一整串「A；B；C；D」读起来是一大坨，
          // 模型也分不清哪句是重点，注入时更没法单独挑。
          const range = first.slice(5) + '–' + last.slice(5);
          fs.writeFileSync(p, body + items.map((t) => '- ' + range + ' ' + t).join('\n') + '\n', 'utf8');
          contextCache = null;
          log('周摘要已生成（' + first + ' ~ ' + last + '，' + items.length + ' 条）');
        }
        for (const f of batch) digested[f.slice(0, 10)] = 'done';
        writeDigested(digested);
      } catch (e) {
        log('周摘要异常：' + (e && e.message));
      } finally {
        weeklyBusy = false;
      }
    })();
  }

  // ---------- 读取：分层注入 ----------
  function readDiaryText(dateStr) {
    try {
      return fs.readFileSync(path.join(diaryDir, dateStr + '.md'), 'utf8');
    } catch (e) {
      return '';
    }
  }

  function parseDiaryLine(line) {
    const m = String(line).match(/^-\s*(\d{1,2}:\d{2})\s*\[([^\]]+)\]\s*(.+)$/);
    if (!m) return null;
    const kindRaw = m[2];
    // 三档。判定顺序不能反：不先认「日常」，它会被最后那个 else 吞成简记，权重直接归零
    const kind = /日常/.test(kindRaw) ? '日常' : /重点/.test(kindRaw) ? '重点' : '简记';
    const tag = (kindRaw.split(/[\/／|]/)[1] || '').trim() || '其它';
    const raw = m[3].trim();
    // 行尾 #别名：只用于检索，注入时去掉
    const aliases = (raw.match(/#[^\s#，,。；;、]{1,10}/g) || []).map((a) => a.slice(1));
    const text = raw.replace(/#[^\s#，,。；;、]{1,10}/g, '').replace(/\s+/g, ' ').trim();
    return { time: m[1], kind, tag, text, aliases };
  }

  function readWeekly() {
    try {
      return fs
        .readdirSync(weeklyDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, weeklyKeep)
        .flatMap((f) => {
          try {
            const txt = fs.readFileSync(path.join(weeklyDir, f), 'utf8');
            return txt
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.startsWith('- '))
              .map((s) => s.replace(/^-\s*/, ''));
          } catch (e) {
            return [];
          }
        });
    } catch (e) {
      return [];
    }
  }

  // ---------- 月摘要：比周摘要更粗、更耐放的那一层 ----------
  // 周摘要默认只留 4 份（约两个月），跟细节检索窗口差不多长，
  // 所以"梗概"其实并没有比"细节"活得更久。月摘要把一整月压成 2~3 行，
  // 默认留 12 份，让"去年这个时候在忙什么"这种跨度有一个通道。
  let monthlyBusy = false;

  function readDigestedMonthly() {
    try {
      const j = JSON.parse(fs.readFileSync(digestedMonthlyPath, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch (e) {
      return {};
    }
  }

  function writeDigestedMonthly(map) {
    try {
      fs.writeFileSync(digestedMonthlyPath, JSON.stringify(map, null, 1), 'utf8');
    } catch (e) {
      log('月摘要标记写入失败：' + (e && e.message));
    }
  }

  // 已经过完的自然月（该月最后一天也在 31 天以前）才算到期，当月不压
  function monthsDue() {
    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const cutoff = ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() - 31));
    const done = readDigestedMonthly();
    const months = new Map(); // 'YYYY-MM' -> [日期...]
    for (const f of diaryFiles()) {
      const date = f.slice(0, 10);
      if (date >= cutoff) continue;
      const m = date.slice(0, 7);
      if (done[m]) continue;
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(date);
    }
    return { months, done };
  }

  function maybeSummarizeMonthly() {
    if (monthlyBusy) return;
    const { months, done } = monthsDue();
    if (!months.size) return;
    monthlyBusy = true;
    (async () => {
      try {
        // 一次最多补 3 个月：停跑很久之后回来，也别一口气把钱烧完
        for (const [month, dates] of [...months.entries()].slice(0, 3)) {
          const picked = [];
          for (const date of dates) {
            for (const line of readDiaryText(date).split(/\r?\n/)) {
              if (!/\[重点/.test(line)) continue;
              const s = line.trim().replace(/^-\s*/, '');
              if (s) picked.push(date.slice(8) + ' ' + s);
            }
          }
          if (!picked.length) {
            // 这个月全是闲聊：直接标记，不再花钱
            done[month] = 'skip';
            writeDigestedMonthly(done);
            continue;
          }
          const r = await complete([
            { role: 'system', content: MONTHLY_PROMPT },
            { role: 'user', content: month + '\n' + picked.join('\n').slice(0, 3000) },
          ]);
          if (!r || !r.ok) {
            log('月摘要失败 ' + month + '：' + ((r && r.message) || '未知') + '（下次重试）');
            return; // 不标记，下次还会轮到它
          }
          const items = String(r.reply || '')
            .split(/\r?\n/)
            .map((s) => s.trim().replace(/^[-*·•]\s*/, ''))
            .filter((s) => s.length >= 2)
            .slice(0, 3);
          if (items.length) {
            const p = path.join(monthlyDir, month + '.md');
            let body = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# ' + month + '\n\n';
            if (!body.endsWith('\n')) body += '\n';
            fs.writeFileSync(p, body + '- ' + items.join('；') + '\n', 'utf8');
            contextCache = null;
            log('月摘要已生成（' + month + '，' + items.length + ' 条）');
          }
          done[month] = 'done';
          writeDigestedMonthly(done);
        }
      } catch (e) {
        log('月摘要异常：' + (e && e.message));
      } finally {
        monthlyBusy = false;
      }
    })();
  }

  function readMonthly() {
    try {
      return fs
        .readdirSync(monthlyDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, monthlyKeep)
        .flatMap((f) => {
          try {
            const txt = fs.readFileSync(path.join(monthlyDir, f), 'utf8');
            return txt
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.startsWith('- '))
              .map((s) => f.slice(0, 7) + ' ' + s.replace(/^-\s*/, ''));
          } catch (e) {
            return [];
          }
        });
    } catch (e) {
      return [];
    }
  }

  // 固定叫法：最近 NICK_WINDOW_DAYS 天里，[重点/称呼] 出现在 ≥NICK_MIN_DAYS 个不同日期，
  // 才算"它平时就这么叫我"，临时注入一条"一直这么叫"。
  //
  // 为什么不写进 pinned.md：写文件会有三个麻烦 —— 误判后手删会被再加回来（还得配黑名单）、
  // 自动行会挤掉用户手写的生日/雷点、某个外号早就不用了却还永远挂着。
  // 临时算就没有这些问题：删日记即撤销，停用一段就自动消失，也不占手写预算。
  function nicknameBlock() {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const entries = []; // 由近到远：{ i, dateStr, text, aliases }
    for (let i = 0; i < NICK_WINDOW_DAYS; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      const txt = readDiaryText(ymd(d));
      if (!txt) continue;
      for (const line of txt.split(/\r?\n/)) {
        const p = parseDiaryLine(line);
        if (!p || p.kind !== '重点' || p.tag !== '称呼' || !p.text) continue;
        entries.push({ i, dateStr: ymd(d), text: p.text, aliases: p.aliases || [] });
      }
    }
    if (!entries.length) return '';

    // 逐个叫法单独数日子：一天一个外号叫三次仍只算 1 天，玩笑外号进不来。
    // #称呼/#外号 这类通用别名要排掉，否则它们会把所有称呼条目一起拖进来。
    const GENERIC = new Set(TAGS.concat(['外号', '名字', '叫法', '昵称']));
    const dayMap = new Map(); // 叫法 -> Set(日期)
    for (const e of entries) {
      for (const a of e.aliases) {
        if (a.length < 2 || GENERIC.has(a)) continue;
        if (!dayMap.has(a)) dayMap.set(a, new Set());
        dayMap.get(a).add(e.dateStr);
      }
    }
    const fixed = new Set();
    for (const [k, set] of dayMap) if (set.size >= NICK_MIN_DAYS) fixed.add(k);
    // 最近几天已经这么叫过的就不补了：同一个名字在提示词里出现三遍，
    // 反而教它反复提这个称呼。这一段只在"有一阵没这么叫了"时才出现。
    const recent = entries.filter((e) => e.i < injectDays);
    for (const t of [...fixed]) {
      if (recent.some((e) => e.aliases.includes(t) || e.text.includes(t))) fixed.delete(t);
    }
    if (!fixed.size) return '';

    // 只取近 injectDays 天之外的（近几天本来就会注入，重复放等于浪费）
    // 同一个叫法只要一条，两条名额留给"两个不同的叫法"，而不是把同一个名字说两遍
    const recentTexts = new Set(entries.filter((e) => e.i < injectDays).map((e) => e.text));
    const seen = new Set();
    const usedTokens = new Set();
    const rows = [];
    let n = 0;
    for (const e of entries) {
      if (e.i < injectDays) continue;
      if (seen.has(e.text) || recentTexts.has(e.text)) continue;
      const tok = [...fixed].find((t) => e.aliases.includes(t) || e.text.includes(t));
      if (!tok || usedTokens.has(tok)) continue;
      const s = '· ' + e.text;
      if (n + s.length > NICK_MAX_CHARS) break;
      seen.add(e.text);
      usedTokens.add(tok);
      rows.push(s);
      n += s.length;
      if (rows.length >= 2) break;
    }
    if (!rows.length) return '';
    return '【一直这么叫你】\n' + rows.join('\n');
  }

  // 本地检索：用户这句话提到什么，就从 4 天以前的日记里捞最相关的几条
  function searchOldDiary(q) {
    const text = String(q || '');
    if (text.length < 3) return [];
    const tags = new Set();
    for (const tag of Object.keys(TAG_HINTS)) {
      if (TAG_HINTS[tag].some((w) => text.includes(w))) tags.add(tag);
    }
    const segs = grams(text);
    if (!tags.size && !segs.length) return [];

    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const cutoff = ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() - 3));
    const hits = [];
    for (const f of diaryFiles().slice(-retentionDays)) {
      const date = f.slice(0, 10);
      if (date >= cutoff) continue; // 近三天本来就全量注入了，不用再捞
      const txt = readDiaryText(date);
      for (const line of txt.split(/\r?\n/)) {
        const p = parseDiaryLine(line);
        if (!p) continue;
        let score = 0;
        let matched = false; // 只有"标签或词面真的撞上"才算命中；重点只是排序加权
        if (tags.has(p.tag)) {
          score += 2;
          matched = true;
        }
        for (const s of segs) {
          if (p.text.includes(s)) {
            score += s.length;
            matched = true;
          }
          // 别名是整理时特意标注的"用户以后可能这样提"，命中比正文更准
          if (p.aliases && p.aliases.some((a) => a.includes(s) || s.includes(a))) {
            score += 3;
            matched = true;
          }
        }
        if (!matched) continue;
        if (p.kind === '重点') score += 2; // 同样相关时，重点排前面
        else if (p.kind === '日常') score += 1;
        hits.push({ score, date, ...p });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));

    // 第一道：同一 (日期, 标签) 只留最高分的一条。
    // 一天里同一类事常有七八条，不去重的话 3 个名额会被"昨天加班×3"占满，
    // 另外两件事根本没机会出现。
    const seenKey = new Set();
    const uniq = [];
    for (const h of hits) {
      const k = h.date + '|' + h.tag;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      uniq.push(h);
    }

    // 第二道：按"多久以前"分三桶，每桶各出 1 条。
    // 不分桶的话，同分时日期新的永远赢 —— 实测 3 年 1 万条里问「加班」，
    // 捞回来的全是这两三天的，"能查到"变成了"查到的都是新的"。
    // 分桶之后半年前那次和上周那次都有名额，概率衰减照旧决定它想不想得起来。
    const now = new Date();
    const bucketOf = (h) => {
      const days = recall.daysBetween(h.date, now);
      return days < 30 ? 0 : days < 180 ? 1 : 2;
    };
    const buckets = [[], [], []];
    for (const h of uniq) buckets[bucketOf(h)].push(h);

    const picked = [];
    for (const b of buckets) {
      if (picked.length >= 3) break;
      if (b.length) picked.push(b[0]);
    }
    // 某一桶空着（比如这些天确实没提过相关的事），就从剩下的按分数补满
    for (const h of uniq) {
      if (picked.length >= 3) break;
      if (picked.includes(h)) continue;
      picked.push(h);
    }
    return picked;
  }

  // ---------- 二次展开：命中日记之后，回那天的原话里再捞一次 ----------
  // diary 是压扁的摘要（2~6 条、每条 30 字），细节在入库那一刻就没了；
  // raw 里存着每天的原话。但这一层必须被"遗忘"管住，否则它就是数据库：
  //   ① 用户得先追问（"后来呢"）才翻 —— 它不能自己主动翻旧账
  //   ② 越久越可能想不起来 —— 概率衰减，而且猜不到这次是哪种
  //   ③ 越久想起的越少 —— 字数衰减，先丢细节，梗概留得久
  function readRawDay(dateStr) {
    try {
      const p = path.join(rawDir, dateStr + '.jsonl');
      if (!fs.existsSync(p)) return [];
      return fs
        .readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // 冷却：一次追问只翻一次，10 分钟内不重复翻，免得连着追问把旧账翻空
  let lastExpandAt = 0;

  function recallFromRaw(segs, hits) {
    if (!segs.length || !hits.length) return '';
    if (Date.now() - lastExpandAt < 10 * 60 * 1000) return '';
    const now = new Date();
    for (const h of hits) {
      const days = recall.daysBetween(h.date, now);
      if (days < 3) continue; // 最近三天本来就全量注入，不用翻
      // 想不想得起来：这次是哪种，用户猜不到
      if (Math.random() > recall.forgetProb(days, h.kind)) continue;
      const rounds = readRawDay(h.date);
      if (!rounds.length) continue;
      const seg = recall.pickAround(rounds, segs, recall.detailChars(days));
      if (!seg) continue;
      lastExpandAt = Date.now();
      const how =
        days >= 30 ? '只剩个大概' : days >= 14 ? '记得有点模糊' : days >= 7 ? '大致记得' : '记得';
      return (
        '【你顺着他的话，从那天想起来的片段】\n' +
        seg +
        '\n（这些是你自己想起来的，不是翻记录。' +
        how +
        '：只提一句，别复述原话；细节拿不准就含糊带过，说不清也别硬凑。）'
      );
    }
    return '';
  }

  // 启动时注入用的记忆块：
  //   pinned（永不衰减） → 今天（全量） → 昨天/前天（只重点） → 更早（周摘要） → 相关旧事（本地检索）
  function context(userText) {
    const q = String(userText || '');
    // key 里带上日期：进程跨过午夜后，同样一句问话不能拿回昨天那份注入
    // （"今天"的标签会指向昨天，周摘要/固定叫法也可能已经变了）
    const key = ymd(new Date()) + '|' + q;
    if (contextCache !== null && contextCacheKey === key) return contextCache;
    contextCacheKey = key;

    const out = [];
    let used = 0;
    const cap = maxChars;
    const push = (s) => {
      if (used + s.length > cap) return false;
      out.push(s);
      used += s.length;
      return true;
    };

    // 给"更早"留的保底预算，必须在排近期日记之前就算出来。
    // 以前所有段落共用一个 1000 字上限、先到先得，而周摘要排在今天/昨天/前天后面：
    // 光这几段的上限加起来就是 220+60+380+200+200=1060 > 1000，
    // 于是只要这几天日记写得满，周摘要那份永远抢不到 —— 整段不注入，
    // 看起来就像它彻底忘了三个月前的事。现在近期日记只能在 recentCap 以内花，
    // 剩下的（≥ oldReserve）一定留给周/月摘要。
    const oldReserve = Math.max(360, Math.min(520, Math.round(cap * 0.25)));
    const recentCap = Math.max(320, cap - oldReserve);
    const pushRecent = (s) => {
      const limit = Math.min(cap, recentCap);
      if (used + s.length > limit) return false;
      out.push(s);
      used += s.length;
      return true;
    };

    // 1) 永久钉住
    // 从最新的往回取：pinned.md 是追加写的，新条目永远在文件末尾。
    // 正序累加到 220 字就 break 的话，文件一早超预算，之后新钉住的约定一条都进不来
    // （实测 21 条只进前 10 条，最新那条"说好一起去看电影"被丢掉）。
    const pinned = readPinned();
    if (pinned.length) {
      const list = [];
      let n = 0;
      for (let i = pinned.length - 1; i >= 0; i--) {
        const p = pinned[i];
        if (n + p.length > 220) break;
        list.unshift('· ' + p.replace(/^-\s*/, ''));
        n += p.length;
      }
      if (list.length) push('【永远记得】\n' + list.join('\n'));
    }

    // 1.5) 长期固定叫法（手写 pinned 之后：同属"稳定背景"，排在最近几天之前）
    const nick = nicknameBlock();
    if (nick) push(nick);

    // 2) 今天全量（重点 + 日常 + 简记），3) 昨天/前天只看重点和日常
    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    for (let i = 0; i < injectDays; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      const txt = readDiaryText(ymd(d));
      if (!txt) continue;
      const label = i === 0 ? '今天' : i === 1 ? '昨天' : i === 2 ? '前天' : d.getMonth() + 1 + '月' + d.getDate() + '日';
      const dayCap = i === 0 ? 400 : 260;
      // 条数上限：给了太多素材，模型会反复拿同一条当话头接话
      // （实测今天 8 条记忆时，"中午吃了蛋炒饭"在十句闲聊里被提了 4 次）
      // 但 5/3 是照着"一天 2~6 条"定的；实际一天攒到二三十条时，九成内容当天就看不见。
      const dayLimit = i === 0 ? 8 : i === 1 ? 5 : 4;
      // 重点最多占 dayLimit-2 个名额（今天 6、昨天 3、前天 2）。
      // 纯按重要度排，名额会被"约定"全吃满，记忆里长期只剩那几条，说话也就只剩那几句可念；
      // 但也不能反过来压太多 —— 重点本来就是最该记住的，所以只留 2 个位置给日常。
      const starLimit = Math.max(3, dayLimit - 2);
      // 简记（寒暄、玩笑、一句感慨）进来只是凑数，最多 2 条
      const briefLimit = 2;
      // 先把当天所有能注入的解析出来
      const parsed = [];
      for (const line of txt.split(/\r?\n/)) {
        const p = parseDiaryLine(line);
        if (!p) continue;
        // 昨天以前只留重点和日常：简记是"当场就散掉"的，不该跨天还占名额
        if (i > 0 && p.kind === '简记') continue;
        parsed.push(p);
      }
      // 按"值不值得记"排序，再按时间倒序兜底：后来的能顶掉前面不重要的。
      // 上一版是"重点优先 + 时间正序"，等于早上的条目稳占名额，晚上那条
      // [重点/情绪] 永远排在第 6 位进不来 —— 恰好是影响语气的那条最容易丢。
      // 三档的基准是分开的：重点 30+ / 日常 20 / 简记 10，标签只在重点内部比高低
      const ordered = parsed
        .map((p) => ({
          p,
          w: (KIND_BASE[p.kind] || 0) + (p.kind === '重点' ? TAG_WEIGHT[p.tag] || 1 : 0),
        }))
        .sort((a, b) => b.w - a.w || b.p.time.localeCompare(a.p.time))
        .map((x) => x.p);
      const picked = [];
      let n = 0;
      let stars = 0;
      let briefs = 0;
      const tryPick = (p) => {
        if (picked.length >= dayLimit) return;
        if (p.kind === '重点' && stars >= starLimit) return;
        if (p.kind === '简记' && briefs >= briefLimit) return;
        const s = '· ' + label + ' ' + p.time + ' ' + p.text;
        if (n + s.length > dayCap) return;
        picked.push({ p, s });
        n += s.length;
        if (p.kind === '重点') stars += 1;
        if (p.kind === '简记') briefs += 1;
      };
      // 先按配额放重点，再用日常/简记把剩下的名额补满
      for (const p of ordered) if (p.kind === '重点') tryPick(p);
      for (const p of ordered) if (p.kind !== '重点') tryPick(p);
      // 挑完再按时间排回去，读起来才像一天的流水
      picked.sort((a, b) => a.p.time.localeCompare(b.p.time));
      const rows = picked.map((x) => x.s);
      // 前面已有段落（永久层 / 固定叫法）时补个小标题，否则当天的条目会被看成
      // 上一段的一部分，模型分不清哪条是"老规矩"、哪条是"今天发生的事"
      if (rows.length) pushRecent(out.length ? '【最近几天】\n' + rows.join('\n') : rows.join('\n'));
      if (used >= recentCap) break;
    }

    // 4) 更早：周摘要 → 月摘要（两个合吃留给"更早"的那份保底预算）
    // 顺序上先是周（近两个月）再是月（更远），读起来由近到远；
    // 但预算分配上先给月留出它那份 —— 它管的是最长的时间跨度，
    // 如果按顺序"周先把 220 花完"，月摘要永远轮不到，等于这层白建。
    const weekly = readWeekly();
    const monthly = readMonthly();
    if (weekly.length || monthly.length) {
      const left = Math.max(0, cap - used);
      const monthCap = Math.min(200, Math.round(left * 0.55));
      const weekCap = Math.min(220, Math.max(0, left - monthCap));
      const wRows = [];
      let wn = 0;
      for (const w of weekly) {
        const s = '· 早前 ' + w;
        if (wn + s.length > weekCap) break;
        wRows.push(s);
        wn += s.length;
      }
      const mRows = [];
      let mn = 0;
      for (const m of monthly) {
        const s = '· ' + m;
        if (mn + s.length > monthCap) break;
        mRows.push(s);
        mn += s.length;
      }
      if (wRows.length) push(wRows.join('\n'));
      // 上面周摘要最多吃掉 weekCap，剩下的仍然 ≥ monthCap，所以月摘要一定进得来
      if (mRows.length) push(mRows.join('\n'));
    }

    // 5) 相关旧事（放在最后：这段每句话都可能变，别影响前面的缓存命中）
    const hits = searchOldDiary(q);
    if (hits.length) {
      const rows = hits.map((h) => '· ' + h.date.slice(5).replace('-', '月') + '日 ' + h.text);
      push('【用户刚提到的事，你隐约记得】\n' + rows.join('\n'));
    }

    // 6) 二次展开：只有用户追问时才回那天的原话里翻。
    // 第一道闸就是这里 —— wantsExpand 判"这句像不像在追问"（≤18 字且含"后来/然后呢"这类词）。
    // 少了它，任何撞上旧日记的句子都会去翻原话，等于把记忆变成数据库（这条以前漏接过）。
    // 独立预算（不占上面那 1000 字）：它是"努力想起来的一点碎片"，
    // 不该因为今天日记写得多就被挤掉。
    const expanded = recall.wantsExpand(q) ? recallFromRaw(grams(q), hits) : '';
    if (expanded) out.push(expanded);

    contextCache = out.length
      ? '【你和用户从前的日记】\n' +
        out.join('\n') +
        '\n（不要说“日记”“记忆”这类字眼；记不清的细节含糊带过，别硬编。）'
      : '';
    return contextCache;
  }

  function cancelIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdle() {
    cancelIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const label = idleMs >= 60000 ? Math.round(idleMs / 60000) + ' 分钟' : Math.round(idleMs / 1000) + ' 秒';
      if (entries.length) flush('静默 ' + label);
    }, idleMs);
  }

  return {
    init() {
      ensureDirs();
      ensurePinned();
      entries = readPending();
      if (entries.length) log('发现上次没整理的对话 ' + entries.length + ' 段，稍后自动补整理');
      return entries.length;
    },
    record(user, reply, meta) {
      const e = { t: new Date(), user: String(user || ''), reply: String(reply || '') };
      // meta.anim：这句回复播了哪个动作（只是留档，不影响整理与注入）
      if (meta && meta.anim) e.anim = String(meta.anim);
      entries.push(e);
      appendRaw(e);
      writePending();
      scheduleIdle();
      return e;
    },
    // 它主动说的话（不进对话 raw，只进 self/）：记录本身不改日记，
    // 等下一次整理时作为素材递过去，由模型决定记不记。
    noteSelf(entry) {
      try {
        if (!entry) return null;
        const t = entry.t instanceof Date ? entry.t : new Date(Number(entry.t) || Date.now());
        if (Number.isNaN(t.getTime())) return null;
        ensureDirs();
        const day = ymd(t);
        const list = readSelfDay(day);
        const rec = {
          t,
          kind: String(entry.kind || 'speak'),
          text: String(entry.text || '').replace(/\s*\n+\s*/g, ' / ').slice(0, 300),
          file: entry.file ? String(entry.file) : '',
          heard: false,
          d: false,
        };
        list.push(rec);
        writeSelfDay(day, list);
        contextCache = null;
        return rec;
      } catch (e) {
        log('自己的话记录失败：' + (e && e.message));
        return null;
      }
    },
    // 用户开口了：把他回应之前它刚说的那句标成"被听见"
    markHeard(atMs) {
      const target = Number(atMs);
      if (!Number.isFinite(target) || target <= 0) return 0;
      let n = 0;
      const days = [...new Set([ymd(new Date(target)), ymd(new Date())])];
      for (const day of days) {
        const list = readSelfDay(day);
        const hit = list.find((e) => !e.heard && Math.abs(e.t.getTime() - target) <= 90000);
        if (!hit) continue;
        hit.heard = true;
        writeSelfDay(day, list);
        contextCache = null;
        n += 1;
        break;
      }
      return n;
    },
    selfBlock,
    flush,
    cancelIdle,
    pendingCount() {
      return entries.length;
    },
    summarizeWeekly: () => maybeSummarizeWeekly(),
    summarizeMonthly: () => maybeSummarizeMonthly(),
    reviewDue,
    context,
    // 供调试/测试
    _recall: { grams, recallFromRaw, readRawDay },
    _state() {
      return { pending: entries.length, dir, idleMs, injectDays, maxChars, retentionDays, weeklyKeep, monthlyKeep, pinned: readPinned().length };
    },
  };
}

module.exports = { createMemory, ymd, hm, isoWeek };
