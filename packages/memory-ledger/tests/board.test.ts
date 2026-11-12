import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBoard } from '../src/board.ts';

/** 造一个临时目录，用完删掉。 */
function withFolder(files: Record<string, string>, run: (folder: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'memory-ledger-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(folder, name), body, 'utf8');
    run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function board(folder: string, rules: string, today: string) {
  return buildBoard({
    folder,
    rules,
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
    const result = board(folder, '超近期.md|whole||4000; 近期.md|whole||4000', '2026-11-10');
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
    const result = board(folder, '超近期.md|whole||4000; 近期.md|whole||4000', '2026-11-10');
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
    const result = board(folder, '超近期.md|whole||4000; 近期.md|whole||4000', '2026-11-10');
    assert.equal(result.cover.duplicates.length, 1);
    assert.equal(result.cover.duplicates[0].date, '2026-11-09');
    assert.deepEqual(result.cover.duplicates[0].files, ['超近期.md', '近期.md']);
    assert.match(result.card, /11-09 同时出现在 超近期\.md 与 近期\.md/);
  });
});

test('文件停在昨天也算缺口', () => {
  const files = { '超近期.md': '## 11-08\n- a\n'.replaceAll('\\n', '\n') };
  withFolder(files, (folder) => {
    const result = board(folder, '超近期.md|whole||4000', '2026-11-10');
    assert.deepEqual(result.cover.missing, ['2026-11-09', '2026-11-10']);
  });
});

test('whole 不截断：超过第四段给的数字，照样整份上卡，只提一句', () => {
  const body = `## 11-08\n- ${'甲'.repeat(60)}\n\n## 11-09\n- ${'乙'.repeat(150)}\n`;
  withFolder({ 'a.md': body }, (folder) => {
    const result = board(folder, 'a.md|whole||80', '2026-11-09');
    // 甲乙都在
    assert.match(result.card, /甲{60}/);
    assert.match(result.card, /乙{150}/);
    // 提醒线触发，但话里明说不截断
    assert.match(result.card, /超过提醒线 80/);
    assert.match(result.card, /不截断/);
    assert.match(result.meta, /1 份偏长/);
    assert.doesNotMatch(result.card, /已截断/);
  });
});

test('whole 第四段留空 = 不提醒、不截断', () => {
  const body = `## 11-08\n- ${'甲'.repeat(200)}\n`;
  withFolder({ 'a.md': body }, (folder) => {
    const result = board(folder, 'a.md|whole||', '2026-11-09');
    assert.match(result.card, /甲{200}/);
    assert.doesNotMatch(result.card, /提醒线/);
    assert.doesNotMatch(result.meta, /偏长/);
  });
});

test('marker 也不截断：标记之前那一段整段上卡', () => {
  const body = `## 名字\n- ${'甲'.repeat(200)}\n\n## 按需\n- 不该进来\n`;
  withFolder({ 'a.md': body }, (folder) => {
    const result = board(folder, 'a.md|marker|## 按需|50', '2026-11-09');
    assert.match(result.card, /甲{200}/);
    assert.doesNotMatch(result.card, /不该进来/);
    assert.match(result.card, /超过提醒线 50/);
  });
});

test('marker 取到某个标题之前', () => {
  const body = '## 名字\n- 鲸汐\n\n## 按需\n- 环境路径\n';
  withFolder({ 'a.md': body }, (folder) => {
    const result = board(folder, 'a.md|marker|## 按需|4000', '2026-11-09');
    assert.match(result.card, /鲸汐/);
    assert.doesNotMatch(result.card, /环境路径/);
  });
});

test('newest 只取最新两块，其余进未上卡清单', () => {
  const body = '## 11-02\n- 旧\n\n## 11-08\n- 中\n\n## 11-10\n- 新\n';
  withFolder({ 'a.md': body }, (folder) => {
    const result = board(folder, 'a.md|newest|2|4000', '2026-11-10');
    assert.match(result.card, /新/);
    assert.match(result.card, /中/);
    assert.doesNotMatch(result.card, /旧/);
    assert.match(result.card, /未上卡的块/);
    assert.match(result.card, /- a\.md：11-02 \d+ 字/);
  });
});

test('规则写错只跳过那一行，不抛异常', () => {
  withFolder({ 'a.md': '## 11-10\n- a\n'.replaceAll('\\n', '\n') }, (folder) => {
    const result = board(folder, 'a.md|whole||600x; a.md|whole||2000', '2026-11-10');
    assert.match(result.card, /规则写错了/);
    assert.equal(result.loaded.length, 1);
  });
});

test('目录读不到时给说明，不抛异常', () => {
  const result = board(join(tmpdir(), 'no-such-folder-xyz'), 'a.md|whole||100', '2026-11-10');
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

test('catalog 一行超过 40 字就截断，不整段搬进来', () => {
  withFolder({ 'a.md': `## 11-09\n- ${'长'.repeat(80)}\n` }, (folder) => {
    const result = board(folder, 'a.md|catalog|4|', '2026-11-09');
    assert.match(result.card, /11-09 长{40}…/);
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
    // 窗口 3 天：11-02 已是第 5 天、11-03 第 4 天
    const result = board(folder, 'a.md|catalog|3|', '2026-11-06');
    // 一行都没有丢
    assert.match(result.card, /11-02 一/);
    assert.match(result.card, /11-03 二/);
    assert.match(result.card, /11-06 五/);
    // 该整理的里点名了窗口外的两天
    assert.match(result.card, /该整理的/);
    assert.match(result.card, /11-02 已第 5 天（窗口 3 天）/);
    assert.match(result.card, /11-03 已第 4 天（窗口 3 天）/);
    assert.match(result.meta, /该整理 2 处/);
    assert.doesNotMatch(result.card, /未上卡的块/);
  });
});

test('catalog 条目超额进「该整理的」，卡上一行不少', () => {
  const body = '## 2026-11\n- 甲\n- 乙\n- 丙\n';
  withFolder({ '大事记.md': body }, (folder) => {
    const result = board(folder, '大事记.md|catalog||2', '2026-11-06');
    assert.match(result.card, /2026-11 甲/);
    assert.match(result.card, /共 3 条（上限 2）/);
    assert.match(result.meta, /该整理 1 处/);
  });
});

test('月块那一行带条数：藏着的那些得有个量感', () => {
  const body = '## 2026-11\n- 甲\n- 乙\n- 丙\n\n## 11-05\n- 丁\n';
  withFolder({ '大事记.md': body }, (folder) => {
    const result = board(folder, '大事记.md|catalog||', '2026-11-06');
    assert.match(result.card, /2026-11 甲（3 件）/);
    // 日块不加条数
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
