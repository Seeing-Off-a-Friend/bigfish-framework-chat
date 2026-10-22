'use strict';
/**
 * 系统提示词组装。
 *
 * 顺序是设计过的，不是随手拼的：
 *
 *   1. 人设（固定，每句都一样）      ← 前缀命中缓存靠它
 *   2. 思考要求（固定）
 *   3. 记忆（每句都变）              ← 从这里开始就不能靠缓存了
 *   4. 更早话题提要（每句都变）
 *   5. 它自己刚说过的话（每句都变）
 *   6. 心里那点事 / 情绪（每句都变）
 *
 * 缓存按 token 前缀命中：前缀一旦变了，后面全部按未命中价算。
 * 所以固定内容必须全在前面，动态内容全在后面 —— 这条纪律值 10 倍价格。
 */

// "少量思考"档额外追加的一句：接口只支持开/关，没有思考预算这个参数
// （传 budget_tokens 会被忽略），所以在提示词里限定思考篇幅。
const THINKING_LOW_HINT =
  '思考要求：心里只用一句话判断对方想听什么，然后马上回答。不要展开分析、不要复述人设、不要逐条检查规则。';

// 记忆块前面的一句固定引导。存在的理由很具体：实测同一条记忆（"中午吃了蛋炒饭"）
// 会在十句闲聊里被反复拿来当话头（10 句出现 5 次）——模型把记忆当成了"没话找话"的素材库。
// 这句话固定不变，不影响缓存前缀。
const MEMORY_GUIDE =
  '下面是你记得的事——只是背景印象，不是谈资：别主动翻出来讲，同一条也别反复拿来接话，几句话之内提过的就别再提了。\n' +
  '条目里的「（心里：…）」是你当时的真实感觉（你嘴硬，写下来的常跟嘴上说的不一样）：照它判断当时的语气，别把自己那句"哼"当成真生气了。';

/**
 * @param {object} p
 * @param {object} p.cfg        归一化后的配置
 * @param {object} [p.memory]   记忆模块
 * @param {object} [p.initiative] 主动模块（提供 moodLine）
 * @param {string} [p.digest]   被挤掉的旧话题压成的一行提要
 * @param {string} [p.userText] 当前这句话（记忆据此翻相关旧事）
 */
function buildSystemPrompt(p) {
  const cfg = p.cfg;
  let s = cfg.thinking === 'low' ? cfg.persona + '\n' + THINKING_LOW_HINT : cfg.persona;

  if (p.memory && cfg.memory) {
    const mem = p.memory.context(p.userText);
    if (mem) s += '\n\n' + MEMORY_GUIDE + '\n' + mem;
  }
  if (p.digest) s += '\n\n（更早聊过的，可能用得上：' + p.digest + '）';

  // 它自己刚才说过的话：只放还能接得上的几句（半天内、最多三条）。
  // 自言自语不搬全文进记忆，但它得知道自己说过什么，不然像失忆。
  if (p.memory && cfg.memory) {
    const selfTalk = p.memory.selfBlock(p.userText);
    if (selfTalk) s += '\n\n' + selfTalk;
  }

  // 心里那点事：被晾着 / 刚被接住，都只影响这阵子的语气
  if (p.initiative) {
    const mood = p.initiative.moodLine();
    if (mood) s += '\n\n' + mood;
  }
  return s;
}

module.exports = { buildSystemPrompt, THINKING_LOW_HINT, MEMORY_GUIDE };
