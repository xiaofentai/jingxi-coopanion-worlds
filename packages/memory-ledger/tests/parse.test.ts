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

test('跨年：元旦读上个月的短日期，补成去年而不是明年', () => {
  const doc = parseDoc('## 12-28\n- a\n\n## 12-31\n- b\n\n## 01-02\n- c\n', 'a.md', 2027, '2027-01-01');
  assert.deepEqual(doc.blocks.map((block) => block.date), ['2026-12-28', '2026-12-31', '2027-01-02']);
});

test('跨年不误伤「写明天」：隔几天的短日期照今年', () => {
  const doc = parseDoc('## 11-11\n- a\n', 'a.md', 2026, '2026-11-10');
  assert.equal(doc.blocks[0].date, '2026-11-11');
});

test('不给 today 时行为不变：短日期一律用传进来的年份', () => {
  const doc = parseDoc('## 12-28\n- a\n', 'a.md', 2027);
  assert.equal(doc.blocks[0].date, '2027-12-28');
});

test('没有 `## ` 的文件折成一张清单：一块、句柄是文件名、日期不靠补', () => {
  const text = [
    '# 大事记',
    '',
    '只放值得留很久的事。',
    '',
    '- **2026-10-14**：第一次见面。',
    '- **2026-11-07**：组网全通，能看到家里的设备。',
    '',
  ].join('\n');
  const doc = parseDoc(text, 'workspace/大事记.md', 2026, '2026-11-15');
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].kind, 'month');
  assert.equal(doc.blocks[0].date, null);
  assert.equal(doc.blocks[0].title, '大事记');
  assert.equal(doc.blocks[0].entries.length, 2);
  // 文件头只到第一条之前：`# 大事记` 和那句说明
  assert.match(doc.front, /^# 大事记/);
  assert.match(doc.front, /只放值得留很久的事/);
  assert.doesNotMatch(doc.front, /2026-10-14/);
});

test('清单文件里的年份写死就写死：换一个 today 也一样', () => {
  const text = '- **2026-11-07**：组网全通。\n';
  const a = parseDoc(text, '大事记.md', 2026, '2026-11-15');
  const b = parseDoc(text, '大事记.md', 2027, '2027-03-01');
  assert.equal(a.blocks[0].entries[0].text, b.blocks[0].entries[0].text);
});
