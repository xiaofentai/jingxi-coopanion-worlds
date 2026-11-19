import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { audit } from '../src/audit.ts';
import { buildBoard } from '../src/board.ts';

/** 造一个临时目录，用完删掉。文件名里带 `/` 时会建子目录。 */
function withFolder(files: Record<string, string>, run: (folder: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'memory-ledger-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const full = join(folder, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body, 'utf8');
    }
    run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function board(folder: string, rules: string, today: string, archiveFile = '') {
  return buildBoard({
    folder,
    rules,
    archiveFile,
    listOthers: false,
    listMax: 8,
    exclude: ['.git'],
    stamp: '11-10 18:00',
    today,
    language: 'zh',
  });
}

test('覆盖连续时没有缺口', () => {
  const files = {
    '超近期.md': '## 11-09\\n- a\\n\\n## 11-10\\n- b\\n'.replaceAll('\\n', '\n'),
    '近期.md': '## 11-08\\n- c\\n'.replaceAll('\\n', '\n'),
  };
  withFolder(files, (folder) => {
    const result = board(folder, '超近期.md|catalog|4|; 近期.md|catalog|21|', '2026-11-10');
    assert.deepEqual(result.cover.missing, []);
    assert.deepEqual(result.cover.duplicates, []);
    assert.match(result.card, /记忆覆盖 11-08 ~ 11-10，没有缺口/);
  });
});

test('缺的那天会被点名', () => {
  const files = {
    '超近期.md': '## 11-10\n- b\n'.replaceAll('\\n', '\n'),
    '近期.md': '## 11-08\n- c\n'.replaceAll('\\n', '\n'),
  };
  withFolder(files, (folder) => {
    const result = board(folder, '超近期.md|catalog|4|; 近期.md|catalog|21|', '2026-11-10');
    assert.deepEqual(result.cover.missing, ['2026-11-09']);
    assert.match(result.card, /缺 11-09/);
    assert.match(result.meta, /缺 1 天/);
  });
});

test('同一天出现在两份文件里会被点名（11-09 被劈开那种）', () => {
  const files = {
    '超近期.md': '## 11-09\n- 18:00 起\\n\n## 11-10\n- b\n'.replaceAll('\\n', '\n'),
    '近期.md': '## 11-08\n- c\n\n## 11-09\n- 早上 10:04\n'.replaceAll('\\n', '\n'),
  };
  withFolder(files, (folder) => {
    const result = board(folder, '超近期.md|catalog|4|; 近期.md|catalog|21|', '2026-11-10');
    assert.equal(result.cover.duplicates.length, 1);
    assert.equal(result.cover.duplicates[0].date, '2026-11-09');
    assert.deepEqual(result.cover.duplicates[0].files, ['超近期.md', '近期.md']);
    assert.match(result.card, /11-09 同时出现在 超近期\.md 与 近期\.md/);
  });
});

test('跨年：元旦出卡，上个月的天还是去年的，覆盖不会爆成整年缺口', () => {
  const files = {
    '超近期.md': '## 12-30\n- a\n\n## 12-31\n- b\n',
    '近期.md': '## 12-20\n- c\n',
  };
  withFolder(files, (folder) => {
    const result = board(folder, '超近期.md|catalog|4|; 近期.md|catalog|21|', '2027-01-01');
    assert.equal(result.cover.from, '2026-12-20');
    assert.equal(result.cover.to, '2027-01-01');
    assert.ok(result.cover.missing.length < 20, `不该有整年缺口，实际 ${result.cover.missing.length} 天`);
    assert.ok(!result.cover.missing.includes('2026-12-30'));
  });
});

test('文件停在昨天也算缺口', () => {
  const files = { '超近期.md': '## 11-08\n- a\n'.replaceAll('\\n', '\n') };
  withFolder(files, (folder) => {
    const result = board(folder, '超近期.md|catalog|4|', '2026-11-10');
    assert.deepEqual(result.cover.missing, ['2026-11-09', '2026-11-10']);
  });
});

test('ledger 只出目录：整份长正文不进卡，卡也不列整份模式', () => {
  const body = `## 11-08\n- ${'甲'.repeat(200)}\n\n## 11-09\n- 乙\n`;
  withFolder({ 'a.md': body }, (folder) => {
    const result = board(folder, 'a.md|catalog||', '2026-11-09');
    assert.doesNotMatch(result.card, /甲{200}/);
    assert.match(result.card, /11-08 甲{50}…/);
    assert.match(result.card, /11-09 乙/);
    assert.doesNotMatch(result.card, /未上卡的块/);
  });
});

test('规则写错只跳过那一行，不抛异常', () => {
  withFolder({ 'a.md': '## 11-10\n- a\n'.replaceAll('\\n', '\n') }, (folder) => {
    const result = board(folder, 'a.md|catalog||600x; a.md|catalog||', '2026-11-10');
    assert.match(result.card, /规则写错了/);
    assert.equal(result.loaded.length, 1);
  });
});

test('目录读不到时给说明，不抛异常', () => {
  const result = board(join(tmpdir(), 'no-such-folder-xyz'), 'a.md|catalog|4|', '2026-11-10');
  assert.match(result.card, /目录读不到/);
});

const CAT = [
  '# 超近期',
  '',
  '## 11-08（周六）',
  '- 早上他打招呼，说 5:34 才睡。',
  '- 细节一。',
  '',
  '## 11-09（周日）',
  '- 两场 12 人局，写了 15k。',
  '',
  '## 还挂着',
  '- 备份拷到不联网盘。',
  '',
].join('\n');

test('catalog 每个块只出一行：短日期 + 首行，细节不进目录', () => {
  withFolder({ '超近期.md': CAT }, (folder) => {
    const result = board(folder, '超近期.md|catalog|4|', '2026-11-09');
    assert.match(result.card, /11-08 早上他打招呼，说 5:34 才睡。/);
    assert.match(result.card, /11-09 两场 12 人局，写了 15k。/);
    assert.match(result.card, /还挂着 备份拷到不联网盘。/);
    assert.doesNotMatch(result.card, /细节一/);
  });
});

test('catalog 一行超过 50 字（首行上限）就截断，不整段搬进来', () => {
  withFolder({ 'a.md': `## 11-09\n- ${'长'.repeat(80)}\n` }, (folder) => {
    const result = board(folder, 'a.md|catalog|4|', '2026-11-09');
    assert.match(result.card, /11-09 长{50}…/);
  });
});

test('catalog 全部上卡：窗口外的天也留在卡上，只是报进「该整理的」', () => {
  const body = [
    '## 11-02', '- 一', '',
    '## 11-03', '- 二', '',
    '## 11-05', '- 四', '',
    '## 11-06', '- 五', '',
  ].join('\n');
  withFolder({ 'a.md': body }, (folder) => {
    // 窗口 3 块：文件里 4 块，超出的**只有 11-02 一块**
    const result = board(folder, 'a.md|catalog|3|', '2026-11-06');
    // 一行都没有丢
    assert.match(result.card, /11-02 一/);
    assert.match(result.card, /11-03 二/);
    assert.match(result.card, /11-06 五/);
    // 该整理的只点最旧的那一块（不是「所有日期差超过窗口的」）
    assert.match(result.card, /该整理的/);
    assert.match(result.card, /11-02 已第 5 天（窗口 3 天）/);
    assert.doesNotMatch(result.card, /11-03 已第/);
    assert.match(result.meta, /该整理 1 处/);
    assert.doesNotMatch(result.card, /未上卡的块/);
  });
});

test('条目到上限的 80% 就进「该整理的」，卡上一行不少', () => {
  const body = '## 2026-11\n- 甲\n- 乙\n- 丙\n';
  withFolder({ '大事记.md': body }, (folder) => {
    const result = board(folder, '大事记.md|catalog||2', '2026-11-06');
    assert.match(result.card, /2026-11（3 件）/);
    assert.match(result.card, /已到 3\/2 条（150%）/);
    assert.match(result.meta, /该整理 1 处/);
  });
});

test('覆盖把归档算进来：中间某天搬走了，不算缺口', () => {
  const live = '## 11-04\n- 四\n\n## 11-06\n- 六\n';
  const archive = '## 11-05\n- 五\n';
  withFolder({ 'a.md': live, 'archive/流水.md': archive }, (folder) => {
    // 不传归档：11-05 看起来缺了
    assert.match(board(folder, 'a.md|catalog|30|', '2026-11-06').card, /缺 11-05/);
    // 传了归档：11-05 是搬走了，不是丢了
    const withArchive = board(folder, 'a.md|catalog|30|', '2026-11-06', 'archive/流水.md');
    assert.doesNotMatch(withArchive.card, /缺 11-05/);
    assert.match(withArchive.card, /没有缺口/);
  });
});

test('catalog 的第四段是条目数：到 80% 报账，目录仍只一行', () => {
  const body = ['## 2026-11', '- 甲', '- 乙', '- 丙', '- 丁', ''].join('\n');
  withFolder({ '大事记.md': body }, (folder) => {
    const result = board(folder, '大事记.md|catalog|3650|5', '2026-11-06');
    assert.match(result.card, /2026-11（4 件）/);
    assert.match(result.card, /已到 4\/5 条（80%）/);
    assert.match(result.meta, /该整理 1 处/);
  });
});

test('月块那一行只给件数，不拿首行凑：它没有「一个月的一句话」', () => {
  const body = '## 2026-11\n- 甲\n- 乙\n- 丙\n\n## 11-05\n- 丁\n';
  withFolder({ '大事记.md': body }, (folder) => {
    const result = board(folder, '大事记.md|catalog||', '2026-11-06');
    assert.match(result.card, /2026-11（3 件）/);
    assert.doesNotMatch(result.card, /2026-11 甲/);
    // 日块照旧：首行 + 不加条数
    assert.match(result.card, /11-05 丁/);
    assert.ok(!result.card.includes('11-05 丁（'));
  });
});

test('catalog 让某一天写很长，也只占一行，不挤掉别天', () => {
  const short = '## 11-08\n- 甲\n\n## 11-09\n- 乙\n\n## 11-10\n- 丙\n';
  const long = `## 11-08\n- 甲\n\n## 11-09\n- ${'乙'.repeat(3000)}\n\n## 11-10\n- 丙\n`;
  withFolder({ 'short.md': short, 'long.md': long }, (folder) => {
    const a = board(folder, 'short.md|catalog|7|', '2026-11-10');
    const b = board(folder, 'long.md|catalog|7|', '2026-11-10');
    assert.equal(a.loaded[0].blocks, 3);
    assert.equal(b.loaded[0].blocks, 3);
    assert.ok(Math.abs(a.loaded[0].kept - b.loaded[0].kept) < 100, `${a.loaded[0].kept} vs ${b.loaded[0].kept}`);
  });
});

test('catalog 的窗口两边都算：卡和体检说的是同一块', () => {
  // 3 块、窗口 2 → 最旧的 11-01 该走
  withFolder({ 'a.md': '## 11-01\n- x\n\n## 11-08\n- y\n\n## 11-09\n- z\n' }, (folder) => {
    const rules = 'a.md|catalog|2|';
    assert.match(board(folder, rules, '2026-11-10').card, /11-01 已第 10 天（窗口 2 天）/);
    // 体检里的句柄是全日期（2026-11-01），卡上是短日期（11-01）——措辞可以不同
    const item = audit(folder, rules, '2026-11-10').tidy.find((entry) => entry.handle === '2026-11-01');
    assert.match(item?.reason ?? '', /已第 10 天/);
  });
});

test('catalog 兜底：超过 100 行才截断，并且明说是异常', () => {
  const rows = Array.from({ length: 120 }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
    return `## 2025-${month}-${day}\n- 第 ${i} 天\n`;
  });
  withFolder({ 'a.md': rows.join('\n') }, (folder) => {
    const result = board(folder, 'a.md|catalog||', '2026-11-06');
    assert.equal(result.loaded[0].blocks, 100);
    assert.match(result.card, /异常：目录 20 行没有显示/);
  });
});
