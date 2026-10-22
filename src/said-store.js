// 它主动说过的话（搭话 / 留言 / 随笔 / 小物件）的存放位置与旧版迁移。
//
// 为什么单独一个模块：这段是纯文件操作（搬目录、拼接、删旧文件），
// 塞在入口文件里没法单测 —— 而"迁移"恰好是最怕出错的地方（搬错=丢档）。
//
// 目录约定：
//   memory/said/YYYY-MM-DD.md      给人翻的流水
//   memory/self/YYYY-MM-DD.jsonl   给它自己接话头（另一套，不在这里）
const fs = require('node:fs');
const path = require('node:path');

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayOf(d) {
  const date = d instanceof Date ? d : new Date();
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function saidDir(root) {
  return path.join(root, 'said');
}

function saidPath(root, d) {
  return path.join(saidDir(root), dayOf(d) + '.md');
}

// 旧版把 said-*.md 平铺在 memory 根目录。只认 said-YYYY-MM-DD.md 这一种名字，
// 别的东西一概不碰；幂等（第二次跑没东西可搬）。
// 目标已存在时（同一天先新版后旧版）：把旧文件里的条目接在后面再删旧文件，不覆盖。
function migrate(root) {
  let n = 0;
  try {
    if (!root || !fs.existsSync(root)) return 0;
    const olds = fs
      .readdirSync(root)
      .filter((f) => /^said-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .filter((f) => {
        try {
          return fs.statSync(path.join(root, f)).isFile();
        } catch (e) {
          return false;
        }
      });
    if (!olds.length) return 0;
    fs.mkdirSync(saidDir(root), { recursive: true });
    for (const f of olds) {
      const from = path.join(root, f);
      const to = path.join(saidDir(root), f.replace(/^said-/, ''));
      try {
        if (fs.existsSync(to)) {
          const body = fs
            .readFileSync(from, 'utf8')
            .split(/\r?\n/)
            .filter((l) => /^- /.test(l.trim()))
            .join('\n');
          if (body) fs.appendFileSync(to, body + '\n', 'utf8');
          fs.unlinkSync(from);
        } else {
          fs.renameSync(from, to);
        }
        n += 1;
      } catch (e) {
        /* 单个文件失败：留着，下次启动再试 */
      }
    }
  } catch (e) {
    return n;
  }
  return n;
}

module.exports = { saidDir, saidPath, migrate, dayOf };
