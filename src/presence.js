'use strict';
/**
 * 「人在不在电脑前」判定。
 *
 * 规则：鼠标 5 秒内动过 = 在，否则当不在。键盘也算 —— 敲代码时鼠标能放半天，
 * 但人明明坐在那儿，所以系统空闲秒数（键鼠任一输入）也算一条证据。
 *
 * 实现：每 1 秒采样一次光标坐标，位置变了就记时间；系统空闲秒数兜底。
 * 为什么不用系统级空闲时间 API 一把梭：
 *   1) 它只回答"距离上一次任意输入过了几秒"，给不出"鼠标刚才动没动"；
 *   2) 锁屏恢复 / 远程桌面下它偶尔给一个很大的数，光标采样能兜住。
 *
 * 这个模块不依赖任何 GUI 运行时：光标位置、空闲秒数都由调用方注入，方便脱离界面单测。
 */

const DEFAULTS = {
  hereMs: 5000, // 5 秒内有动静 = 在
  awayMs: 5 * 60000, // 静止超过 5 分钟再动 = 算"离开又回来"
};

function createPresence(opts) {
  const o = opts || {};
  const getCursor = o.getCursor || (() => null);
  const getIdleSec = o.getIdleSec || (() => null);
  const now = o.now || (() => Date.now());
  const hereMs = Number(o.hereMs) > 0 ? Number(o.hereMs) : DEFAULTS.hereMs;
  const awayMs = Number(o.awayMs) > 0 ? Number(o.awayMs) : DEFAULTS.awayMs;

  let x = null;
  let y = null;
  let lastMoveAt = now(); // 启动时先当"刚动过"，否则一开机就被判成不在
  let returnedAt = 0;
  let lastAwayMs = 0; // 上一次"离开又回来"时，离开了多久
  let samples = 0;
  let moves = 0;
  let cursorOk = false; // 光标 API 到底能不能用（Wayland 之类可能拿不到）

  // 采一次样。返回 true = 这一次发现鼠标动了。
  function sample() {
    samples += 1;
    let p = null;
    try {
      p = getCursor();
    } catch (e) {
      p = null;
    }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    cursorOk = true;
    const t = now();
    if (x === null) {
      // 第一次只记基线：不能把"启动那一刻的光标"当成一次移动
      x = p.x;
      y = p.y;
      lastMoveAt = t;
      return false;
    }
    if (p.x === x && p.y === y) return false;
    if (t - lastMoveAt >= awayMs) {
      returnedAt = t; // 离开够久又动了 = 回来了
      lastAwayMs = t - lastMoveAt;
    }
    x = p.x;
    y = p.y;
    lastMoveAt = t;
    moves += 1;
    return true;
  }

  // 距离"最后一次看得出人在"过了多少毫秒。永远有值：光标和系统空闲取更小的那个
  // （更小 = 更近的一次动静，代表更可能还在）。
  function stillMs() {
    const t = now();
    const byCursor = t - lastMoveAt;
    let byIdle = null;
    try {
      const s = Number(getIdleSec());
      if (Number.isFinite(s) && s >= 0) byIdle = s * 1000;
    } catch (e) {
      byIdle = null;
    }
    if (!cursorOk) return byIdle === null ? 0 : byIdle; // 光标拿不到就只信系统空闲
    if (byIdle === null) return byCursor;
    return Math.min(byCursor, byIdle);
  }

  return {
    sample,
    stillMs,
    idleSec: () => Math.max(0, Math.round(stillMs() / 1000)),
    isHere: () => stillMs() <= hereMs,
    // 刚才是不是"离开几分钟后回来了"（60 秒内），给以后要用的地方留个口子
    takeReturned: (withinMs) => {
      const win = Number(withinMs) > 0 ? Number(withinMs) : 60000;
      if (returnedAt && now() - returnedAt <= win) {
        returnedAt = 0;
        return true;
      }
      return false;
    },
    // 不会消费的版本：60 秒内回来过就返回 { awayMs, at }，否则 null。
    // 「离开多久」只有这里知道（系统空闲秒数在你回来的那一刻就归零了）。
    returnedInfo: (withinMs) => {
      const win = Number(withinMs) > 0 ? Number(withinMs) : 60000;
      if (returnedAt && now() - returnedAt <= win) return { awayMs: lastAwayMs, at: returnedAt };
      return null;
    },
    state: () => ({
      here: stillMs() <= hereMs,
      idleSec: Math.max(0, Math.round(stillMs() / 1000)),
      cursorOk,
      moves,
      samples,
      x,
      y,
    }),
  };
}

module.exports = { createPresence, PRESENCE_DEFAULTS: DEFAULTS };
