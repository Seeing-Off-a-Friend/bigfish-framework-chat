'use strict';
/**
 * 终端里的最小演示：输入一句话，看它回几条；中途它会自己开口。
 *
 *   set DEEPSEEK_API_KEY=sk-xxxx
 *   node demo/cli.js
 *
 * 命令：
 *   /usage   今天的 token 用量
 *   /state   当前状态（额度、被晾着几次、有没有在赌气）
 *   /speak   立刻让它主动说一句
 *   /quit    退出（会先把没整理的对话整理掉）
 */

const path = require('node:path');
const readline = require('node:readline');
const { createChat } = require('../src/index.js');

const dataDir = process.env.BIGFISH_DATA_DIR || path.join(__dirname, '..', 'memory');
const chat = createChat({
  configFile: process.env.BIGFISH_CONFIG || path.join(__dirname, '..', 'config.jsonc'),
  dataDir,
  log: (m) => process.env.BIGFISH_DEBUG && console.log('[debug] ' + m),
});

// 终端里没有"鼠标动没动"，就用"上一次打字到现在多久"代替：
// 5 分钟内说过话 = 人在，否则当成走开了。这跟真实宿主用系统空闲时间是同一个思路。
let lastInputAt = Date.now();
const isHere = () => Date.now() - lastInputAt < 5 * 60000;
const idleSec = () => Math.round((Date.now() - lastInputAt) / 1000);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// 主动开口：每 60 秒问一次"现在该不该说话"。
// 真实频率由 speakGapMin/Max 控制（默认 90~180 分钟），这里只是轮询。
const timer = setInterval(async () => {
  const r = await chat.tick();
  if (r && r.ok) {
    console.log('\n它（主动）：' + r.text);
    rl.prompt(true);
  }
}, 60000);
timer.unref();

function showUsage() {
  const u = chat.usageToday();
  const kinds = Object.entries(u.byKind || {})
    .map(([k, v]) => k + ' ' + v.total)
    .join('、');
  console.log('今天：' + u.total + ' token（输入 ' + u.prompt + '，其中缓存 ' + u.cached + '，输出 ' + u.completion + '）' +
    (kinds ? '｜' + kinds : ''));
}

console.log('bigfish-framework-chat 演示。数据目录：' + dataDir);
console.log('直接说话就行。命令：/usage /state /speak /quit\n');

rl.setPrompt('你：');
rl.prompt();

rl.on('line', async (line) => {
  const text = String(line || '').trim();
  lastInputAt = Date.now();
  if (!text) {
    rl.prompt();
    return;
  }
  if (text === '/quit' || text === '/exit') {
    console.log('整理对话中……');
    await chat.close();
    rl.close();
    return;
  }
  if (text === '/usage') {
    showUsage();
    rl.prompt();
    return;
  }
  if (text === '/state') {
    console.log(JSON.stringify(chat.state(), null, 1));
    rl.prompt();
    return;
  }
  if (text === '/speak') {
    const r = await chat.forceSpeak();
    console.log(r && r.ok ? '它（主动）：' + r.text : '没说成：' + ((r && (r.reason || r.message)) || '未知'));
    rl.prompt();
    return;
  }

  rl.pause();
  const r = await chat.say(text);
  if (!r.ok) {
    console.log('（失败：' + r.message + '）');
  } else {
    for (let i = 0; i < r.segments.length; i++) {
      if (i) await new Promise((res) => setTimeout(res, 600)); // 一条一条冒出来更像人
      console.log((i ? '　　' : '它：') + r.segments[i]);
    }
    if (process.env.BIGFISH_DEBUG) showUsage();
  }
  rl.resume();
  rl.prompt();
});

rl.on('close', async () => {
  clearInterval(timer);
  await chat.close();
  console.log('\n（对话已整理，下次启动它会记得。）');
  process.exit(0);
});
