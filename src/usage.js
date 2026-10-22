'use strict';
/**
 * token 用量记账。
 *
 * 以前程序只在控制台打一行推理 token，账面上看不见「今天到底花了多少」——
 * 想核对只能靠价格表反推，而反推总会漏掉整理、复核、预热这些隐形调用。
 * 这里把接口返回的真实 usage 逐笔落盘，一天一个文件：
 *
 *   memory/usage-2026-10-20.jsonl
 *   {"t":"2026-10-20T18:02:11+08:00","kind":"对话","prompt":1864,"cached":1664,"completion":54}
 *
 * 只记接口真的返回了的数字，不猜、不估。宿主查询当天用量时读当天这份文件求和，
 * 用气泡把总数报出来（读本地文件，不联网、不花钱）。
 *
 * prompt = 输入（含命中缓存的部分），cached = 其中命中缓存的部分（仅供参考，不影响总数）。
 * total = prompt + completion —— 即「今天一共消耗了多少 token」。
 */

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 90; // 只留三个月的账，够查，也不会越滚越大

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function stamp(d) {
  const off = Math.abs(d.getTimezoneOffset());
  return (
    ymd(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    (d.getTimezoneOffset() > 0 ? '-' : '+') +
    pad2(Math.floor(off / 60)) + ':' + pad2(off % 60)
  );
}

function createUsage(opts) {
  const o = opts || {};
  const dir = o.dir;
  const now = o.now || (() => Date.now());
  const log = o.log || (() => {});
  const keepDays = Number(o.keepDays) > 0 ? Number(o.keepDays) : KEEP_DAYS;

  function fileOf(d) {
    return path.join(dir, 'usage-' + ymd(d) + '.jsonl');
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 删掉太老的账。只在启动时跑一次，出错就算了（不能为了清账把程序搞挂）。
  function prune() {
    try {
      const cutoff = ymd(new Date(now() - keepDays * 86400000));
      for (const f of fs.readdirSync(dir)) {
        const m = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, f));
      }
    } catch (e) {
      /* 清不掉就留着，不影响记账 */
    }
  }

  /**
   * 记一笔。字段全部来自接口的 usage，缺的当 0。
   * 返回写入的那一行（调试/单测用）；写盘失败也不抛 —— 记账坏了不能连累对话。
   */
  function add(entry) {
    const e = entry || {};
    const at = Number(e.t) > 0 ? Number(e.t) : now();
    const prompt = Math.max(0, Math.round(Number(e.prompt) || 0));
    const completion = Math.max(0, Math.round(Number(e.completion) || 0));
    const cached = Math.min(prompt, Math.max(0, Math.round(Number(e.cached) || 0)));
    const row = { t: stamp(new Date(at)), kind: String(e.kind || '其它'), prompt, cached, completion };
    try {
      ensureDir();
      fs.appendFileSync(fileOf(new Date(at)), JSON.stringify(row) + '\n', 'utf8');
    } catch (err) {
      log('用量记账失败：' + ((err && err.message) || err));
    }
    return row;
  }

  /** 某一天的合计。读不到文件 = 那天没花过钱，返回全 0。 */
  function day(date) {
    const d = date || new Date(now());
    let text = '';
    try {
      text = fs.readFileSync(fileOf(d), 'utf8');
    } catch (e) {
      text = '';
    }
    const out = { ok: true, day: ymd(d), calls: 0, prompt: 0, cached: 0, completion: 0, total: 0, byKind: {} };
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let r;
      try {
        r = JSON.parse(s);
      } catch (e) {
        continue; // 半行（写到一半断电）就跳过，不影响其它行
      }
      const p = Math.max(0, Number(r.prompt) || 0);
      const c = Math.max(0, Number(r.completion) || 0);
      out.calls += 1;
      out.prompt += p;
      out.cached += Math.max(0, Number(r.cached) || 0);
      out.completion += c;
      out.total += p + c;
      const k = String(r.kind || '其它');
      if (!out.byKind[k]) out.byKind[k] = { calls: 0, total: 0 };
      out.byKind[k].calls += 1;
      out.byKind[k].total += p + c;
    }
    return out;
  }

  return {
    add,
    day,
    today: () => day(new Date(now())),
    prune,
  };
}

module.exports = { createUsage };
