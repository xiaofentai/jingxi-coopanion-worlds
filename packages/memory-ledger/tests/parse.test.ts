import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dayDates, parseDoc, shiftDate } from '../src/parse.ts';

const sample = [
  '# 超近期（只留最近 2 天）',
  '',
  '本文件持有：还挂着，今天、昨天的事。',
  '',
  '## 还挂着',
  '- 他要给记忆备份插件上架。',
  '',
  '## 11-08（周日）',
  '- 06:00 清晨巡箱，补了 19 格。',
  '- 11:03 排进 8 人匹配，',
  '  队友 12 号小亓鱼，空刀。',
  '',
  '## 11-09（周一）',
  '- 18:00 六人局，我 6 号平民。',
  '',
].join('\n');

test('文件头进 front，不进任何块', () => {
  const doc = parseDoc(sample, '超近期.md', 2026);
  assert.match(doc.front, /本文件持有/);
  assert.equal(doc.blocks.length, 3);
});

test('月块不被当成日块：`## 2026-11` 是 2026-11，不是 11-26', () => {
  const doc = parseDoc('# 大事记\n\n## 2026-11\n- 11-01 开始打星邮狼人杀。\n', '大事记.md', 2026);
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].kind, 'month');
  assert.equal(doc.blocks[0].date, '2026-11');
  assert.equal(doc.blocks[0].key, 20261100);
});

test('日块取当年年份，特殊块没有日期', () => {
  const doc = parseDoc(sample, '超近期.md', 2026);
  assert.deepEqual(doc.blocks.map((b) => [b.kind, b.date]), [
    ['special', null],
    ['day', '2026-11-08'],
    ['day', '2026-11-09'],
  ]);
});

test('代码围栏里的 ## 不算块标题', () => {
  const text = ['## 11-08', '- 他让我这样做：', '  ```md', '  ## 这不是标题', '  ```', '- 完。', ''].join('\n');
  const doc = parseDoc(text, 'x.md', 2026);
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].entries.length, 2);
});

test('续行并进上一条，不拆成两条', () => {
  const doc = parseDoc(sample, '超近期.md', 2026);
  const day = doc.blocks.find((b) => b.date === '2026-11-08');
  assert.ok(day);
  assert.equal(day.entries.length, 2);
  assert.match(day.entries[1].text, /队友 12 号小亓鱼，空刀/);
  assert.equal(day.entries[1].lines.length, 2);
});

test('dayDates 排序去重，特殊块与月块不算', () => {
  const doc = parseDoc(sample, '超近期.md', 2026);
  assert.deepEqual(dayDates(doc), ['2026-11-08', '2026-11-09']);
  const month = parseDoc('## 2026-11\n- x\n\n## 11-02\n- y\n\n## 11-02\n- z\n', 'm.md', 2026);
  assert.deepEqual(dayDates(month), ['2026-11-02']);
});

test('shiftDate 跨月跨年', () => {
  assert.equal(shiftDate('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2026-11-10', 0), '2026-11-10');
});
