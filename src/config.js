'use strict';
/**
 * 配置：默认值 + JSONC 读取 + 归一化。
 *
 * 一条原则贯穿到底：**坏值一律回默认，绝不抛错**。
 * 配置是给人手改的，手改就会写错（多一个逗号、把 0 写成空串）。
 * 一个字段写错不该让整个程序起不来，也不该让对话莫名其妙变哑。
 */

const fs = require('node:fs');

const DEFAULTS = {
  // ---- 接口 ----
  apiBase: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',

  // ---- 人设 ----
  // 留空 = 用内置的人设（persona.js 里的鲸鱼娘）。要换成自己的角色，填这一整段。
  persona: '',

  // ---- 采样 ----
  maxTokens: 400,
  temperature: 1.2,
  // 重复用词惩罚：抑制口头禅堆积。0 = 关，0.2~0.4 是舒适区
  presencePenalty: 0.25,

  // ---- 上下文 ----
  // 只保留最近 N 轮原文（一轮 = 用户说 + 它答）。更早的压成一行提要。
  // 这是"省钱"最有效的一个旋钮：2 轮和 6 轮的成本差将近一倍，观感差别很小。
  historyTurns: 2,
  timeoutMs: 30000,

  // 'off' 不思考 / 'low' 少量思考（默认）/ 'on' 正常思考
  // 关掉思考不只为省钱：它同时减少"我要不要提醒他一下"这类多余的自我审查，
  // 让回答更接近一个随口说话的人，而不是一个在权衡措辞的助手。
  thinking: 'low',

  // ---- 动作 ----
  // 说话时偶尔带一句括号旁白（「（尾巴动了一下）」），原样显示在回复里。
  // false = 提示词里就不提动作这件事（省几个 token，也不会有括号）。
  action: true,

  // ---- 记忆 ----
  memory: true,
  // 聊完静默多久后整理成日记（分钟）
  memoryIdleMinutes: 10,
  // 注入最近几天的日记（默认 3）
  memoryInjectDays: 3,
  // 注入的记忆最多占多少字（默认 1400，约 700~800 token）
  // 其中约 25% 是留给周/月摘要的保底额度，近期日记挤不掉它
  memoryMaxChars: 1400,
  // 检索窗口：只在最近这么多天的日记里翻旧事（默认 365，按日期算不按文件个数算）
  memoryRetentionDays: 365,
  // 周摘要保留几份（每份约两周，默认 26 ≈ 一年）
  memoryWeeklyKeep: 26,
  // 月摘要保留几份（每份一个月，默认 12）—— 比周摘要更粗，用来撑住一年以上的跨度
  memoryMonthlyKeep: 12,

  // ---- 主动开口 ----
  initiative: true,
  initiativeSpeakPerDay: 6,
  initiativeGapMin: 90,
  initiativeGapMax: 180,
  // 静默时段：这段时间内完全不主动（0 点到 6 点）。起止相同 = 不设静默
  initiativeQuietStart: 0,
  initiativeQuietEnd: 6,
};

/** 去掉 JSONC 里的 // 与 /* *\/ 注释（字符串内部不动）。 */
function stripJsonc(text) {
  const src = String(text || '');
  let out = '';
  let inStr = false;
  let esc = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 读一个 JSONC 文件；不存在或解析失败都返回 {}。 */
function readJsonc(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const j = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 数值归一化。
 * 注意 Number('') === 0 —— 直接转会把"没填"当成 0，这个坑踩过一次，
 * 所以空串/空值先单独判掉。
 */
function num(v, def, lo, hi) {
  if (v === '' || v === null || v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : def;
}

/** 把用户配置合并进默认值，并把每个字段压到合法区间。 */
function normalize(raw) {
  const user = raw && typeof raw === 'object' ? raw : {};
  const cfg = Object.assign({}, DEFAULTS, user);

  cfg.model = String(cfg.model || '').trim() || DEFAULTS.model;
  cfg.apiBase = String(cfg.apiBase || '').trim() || DEFAULTS.apiBase;
  cfg.apiKey = String(cfg.apiKey || '').trim();
  cfg.maxTokens = Math.max(16, num(cfg.maxTokens, DEFAULTS.maxTokens, 16, 8192));
  cfg.temperature = num(cfg.temperature, DEFAULTS.temperature, 0, 2);
  cfg.presencePenalty = num(cfg.presencePenalty, DEFAULTS.presencePenalty, -2, 2);
  cfg.historyTurns = num(cfg.historyTurns, DEFAULTS.historyTurns, 0, 20);
  cfg.timeoutMs = num(cfg.timeoutMs, DEFAULTS.timeoutMs, 3000, 300000);

  // 思考档位：认 'off'/'low'/'on'，也兼容 true/false 与 "true"/"false"
  {
    const t = cfg.thinking;
    if (t === false || t === 'off' || t === 'false' || t === 0) cfg.thinking = 'off';
    else if (t === true || t === 'on' || t === 'true' || t === 1) cfg.thinking = 'on';
    else cfg.thinking = 'low';
  }

  // 开关类：只有显式 false 才关（缺省是开）
  cfg.memory = cfg.memory !== false;
  cfg.initiative = cfg.initiative !== false;
  cfg.action = cfg.action !== false;

  cfg.memoryIdleMinutes = num(cfg.memoryIdleMinutes, DEFAULTS.memoryIdleMinutes, 0.5, 1440);
  cfg.memoryInjectDays = num(cfg.memoryInjectDays, DEFAULTS.memoryInjectDays, 1, 30);
  cfg.memoryMaxChars = num(cfg.memoryMaxChars, DEFAULTS.memoryMaxChars, 200, 4000);
  cfg.memoryRetentionDays = num(cfg.memoryRetentionDays, DEFAULTS.memoryRetentionDays, 3, 3650);
  cfg.memoryWeeklyKeep = num(cfg.memoryWeeklyKeep, DEFAULTS.memoryWeeklyKeep, 1, 104);
  cfg.memoryMonthlyKeep = num(cfg.memoryMonthlyKeep, DEFAULTS.memoryMonthlyKeep, 1, 120);
  cfg.initiativeSpeakPerDay = num(cfg.initiativeSpeakPerDay, DEFAULTS.initiativeSpeakPerDay, 0, 48);
  cfg.initiativeGapMin = num(cfg.initiativeGapMin, DEFAULTS.initiativeGapMin, 10, 1440);
  cfg.initiativeGapMax = num(cfg.initiativeGapMax, DEFAULTS.initiativeGapMax, cfg.initiativeGapMin, 2880);
  cfg.initiativeQuietStart = num(cfg.initiativeQuietStart, DEFAULTS.initiativeQuietStart, 0, 23);
  cfg.initiativeQuietEnd = num(cfg.initiativeQuietEnd, DEFAULTS.initiativeQuietEnd, 0, 23);
  return cfg;
}

/** 从文件读配置（不存在就当空配置）。 */
function loadConfig(file) {
  return normalize(file ? readJsonc(file) : {});
}

module.exports = { DEFAULTS, stripJsonc, readJsonc, normalize, loadConfig, num };
