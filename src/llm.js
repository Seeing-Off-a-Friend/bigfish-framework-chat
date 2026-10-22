'use strict';
/**
 * 模型调用：一个极薄的 OpenAI 兼容 /chat/completions 客户端。
 *
 * 没有 SDK、没有重试库、没有依赖 —— 整个仓库零依赖是刻意的：
 * 想抄的人打开就能跑，不用先 npm install 三百个包。
 *
 * 这里也是**记账的唯一入口**：所有调用（对话 / 整理 / 复核 / 主动开口 / 预热）
 * 都从这里出去，所以账只可能少记，不可能漏记。
 */

const { num } = require('./config.js');

/** 把用户想表达的思考档位翻译成接口要的形式。 */
function thinkingPayload(cfg) {
  if (cfg.thinking === 'off') return { type: 'disabled' };
  if (cfg.thinking === 'on') return { type: 'enabled' };
  return { type: 'enabled' }; // 'low'：接口没有"思考预算"这个参数，靠提示词压篇幅
}

function createLlm(opts) {
  const cfg = opts.cfg;
  const log = opts.log || (() => {});
  const onUsage = typeof opts.onUsage === 'function' ? opts.onUsage : () => {};
  const fetchImpl = opts.fetch || globalThis.fetch;

  /** 一次 HTTP 往返。kind 只用于记账，不影响请求本身。 */
  async function post(payload, kind) {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, message: '当前 Node 没有 fetch（需要 Node 18 以上）' };
    }
    let url;
    try {
      url = String(cfg.apiBase).replace(/\/+$/, '') + '/chat/completions';
    } catch (e) {
      return { ok: false, message: 'apiBase 配置有误' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, message: 'API ' + res.status + '：' + String(text).slice(0, 160) };
      }
      let j;
      try {
        j = JSON.parse(text);
      } catch (e) {
        return { ok: false, message: '返回内容解析失败' };
      }
      const m = j && j.choices && j.choices[0] && j.choices[0].message;
      const reply = m && typeof m.content === 'string' ? m.content.trim() : '';
      const u = (j && j.usage) || {};
      const reasoningTokens = Number((u.completion_tokens_details || {}).reasoning_tokens) || 0;
      if (!reply) return { ok: false, message: '模型没有返回内容' };
      onUsage(kind, u);
      return { ok: true, reply, reasoningTokens, usage: u };
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? '请求超时' : (e && e.message) || '网络错误';
      return { ok: false, message: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 一次补全。
   * 'off' 档才真正传 thinking:{type:'disabled'} —— 推理 token 归零，最快最省。
   * 兜底：某些中转/旧模型不认这个字段会回 400/422，这时去掉它按默认模式重发一次，
   * 保证"换个 apiBase 也能用"，不至于因为调档把对话搞挂。
   */
  async function complete(messages, overrides) {
    const o = overrides || {};
    const base = {
      model: o.model || cfg.model,
      messages,
      max_tokens: num(o.maxTokens, cfg.maxTokens, 16, 8192),
      temperature: num(o.temperature, cfg.temperature, 0, 2),
      presence_penalty: num(o.presencePenalty, cfg.presencePenalty, -2, 2),
      stream: false,
    };
    const kind = o.kind || '对话';
    // 单次调用可以覆盖档位：整理日记时强制 'off'（分类判断不需要思考，还更省）
    const think = o.thinking || cfg.thinking;
    if (think !== 'off') {
      return post(Object.assign({}, base, { thinking: thinkingPayload(cfg) }), kind);
    }
    const off = Object.assign({}, base, { thinking: { type: 'disabled' } });
    const r = await post(off, kind);
    const rejected =
      !r.ok && (r.status === 400 || r.status === 422) && /thinking|unknown|unsupported|invalid/i.test(String(r.message));
    if (!rejected) return r;
    log('接口不认 thinking 字段，按默认模式重发');
    return post(base, kind);
  }

  return { complete, post };
}

module.exports = { createLlm };
