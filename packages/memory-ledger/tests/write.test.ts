import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseDoc } from '../src/parse.ts';
import { appendBullets, deleteInBlock, editInBlock, ensureDayBlock, findBlocks, handleOf, moveBlock, tidy, withoutBlock } from '../src/write.ts';

const CJ = [
  '# 超近期（只留最近 2 天）',
  '',
  '本文件持有：今天、昨天的事。',
  '',
  '## 11-09（周一）',
  '- 早上 10:04 打招呼。',
  '- 18:00 六人局，我 6 号平民。',
  '',
  '## 11-10（周二）',
  '- 13:00 生态箱同步报错。',
  '',
  '## 还挂着',
  '- 备份拷到不联网盘。',
  '',
].join('\n');

const JQ = [
  '# 近期（只留 7 天）',
  '',
  '## 11-06（周五）',
  '- 客厅升到 0.36.9。',
  '',
  '## 11-07（周六）',
  '- 08:47 六人狼人杀，我赢了。',
  '',
].join('\n');

const cj = () => parseDoc(CJ, '超近期.md', 2026);
const jq = () => parseDoc(JQ, '近期.md', 2026);

test('句柄：日块给日期，特殊块给标题', () => {
  assert.deepEqual(cj().blocks.map(handleOf), ['2026-11-09', '2026-11-10', '还挂着']);
  assert.equal(findBlocks(cj(), '11-09').length, 1);
  assert.equal(findBlocks(cj(), '还挂着').length, 1);
});

test('搬 11-08：目标接上，源里一天都不少（今天那个错的反例）', () => {
  const source = parseDoc(
    ['# 超近期', '', '## 11-08（周日）', '- 06:00 巡箱。', '- 11:03 排进匹配。', '', '## 11-09（周一）', '- 18:00 六人局。', ''].join('\n'),
    '超近期.md',
    2026,
  );
  const result = moveBlock(source, '11-08', jq());
  assert.ok(!('error' in result), 'error' in result ? result.error : '');

  const target = parseDoc(result.target, '近期.md', 2026);
  assert.deepEqual(target.blocks.map(handleOf), ['2026-11-06', '2026-11-07', '2026-11-08']);
  // 搬过去的块内容完整
  const moved = findBlocks(target, '11-08')[0];
  assert.match(moved.body, /06:00 巡箱/);
  assert.match(moved.body, /11:03 排进匹配/);

  const after = parseDoc(result.source, '超近期.md', 2026);
  assert.deepEqual(after.blocks.map(handleOf), ['2026-11-09']);
  // 关键：11-09 的内容一条都没被带走
  assert.match(findBlocks(after, '11-09')[0].body, /18:00 六人局/);
  assert.equal(findBlocks(after, '11-09')[0].entries.length, 1);
});

test('目标里已有同一天时拒绝，不会悄悄造出两份', () => {
  const target = parseDoc(['# 近期', '', '## 11-08（周日）', '- 旧的。', ''].join('\n'), '近期.md', 2026);
  const source = parseDoc(['# 超近期', '', '## 11-08（周日）', '- 新写的。', ''].join('\n'), '超近期.md', 2026);
  const result = moveBlock(source, '11-08', target);
  assert.ok('error' in result);
  assert.match(result.error, /已经有「2026-11-08」/);
});

test('特殊块不搬', () => {
  const result = moveBlock(cj(), '还挂着', jq());
  assert.ok('error' in result);
  assert.match(result.error, /特殊块/);
});

test('删掉最后一块后文件依然干净', () => {
  const doc = parseDoc(['# a', '', '## 11-08', '- x', '', '## 11-09', '- y', ''].join('\n'), 'a.md', 2026);
  const text = withoutBlock(doc, findBlocks(doc, '11-09')[0]);
  assert.equal(text, '# a\n\n## 11-08\n- x\n');
});

test('新块按日期插在正确位置，不排到特殊块后面', () => {
  const doc = parseDoc(
    ['# 超近期', '', '## 11-09（周一）', '- a', '', '## 11-10（周二）', '- b', '', '## 还挂着', '- c', ''].join('\n'),
    '超近期.md',
    2026,
  );
  const created = ensureDayBlock(doc, '2026-11-08', 2026);
  assert.equal(created.created, true);
  const after = parseDoc(created.text, '超近期.md', 2026);
  assert.deepEqual(after.blocks.map(handleOf), ['2026-11-08', '2026-11-09', '2026-11-10', '还挂着']);
  assert.match(after.text, /## 11-08（周日）/);
});

test('同一天已有块时不新建', () => {
  const created = ensureDayBlock(cj(), '2026-11-10', 2026);
  assert.equal(created.created, false);
  assert.equal(created.text, cj().text);
});

test('追加条目落在本块末尾，不越到下一天', () => {
  const result = appendBullets(cj(), '11-09', ['22:30 定下新口径。']);
  assert.ok(!('error' in result));
  const after = parseDoc(result.text, '超近期.md', 2026);
  const block = findBlocks(after, '11-09')[0];
  assert.equal(block.entries.length, 3);
  assert.match(block.entries[2].text, /22:30 定下新口径/);
  // 11-10 没被动
  assert.equal(findBlocks(after, '11-10')[0].entries.length, 1);
});

test('追加到一个不存在的块里会报错，不会自己建', () => {
  const result = appendBullets(cj(), '11-01', ['x']);
  assert.ok('error' in result);
  assert.match(result.error, /没找到/);
});

test('tidy：压空行、去行尾空白、结尾一个换行', () => {
  assert.equal(tidy('a\n\n\n\nb  \n'), 'a\n\nb\n');
  assert.equal(tidy('a'), 'a\n');
});

test('ml_edit 那类：块内唯一的一段能换掉，别的块不动', () => {
  const result = editInBlock(cj(), '还挂着', '备份拷到不联网盘', '备份已经同步到群晖了');
  assert.ok(!('error' in result), 'error' in result ? result.error : '');
  const after = parseDoc(result.text, '超近期.md', 2026);
  assert.match(findBlocks(after, '还挂着')[0].body, /备份已经同步到群晖了/);
  assert.doesNotMatch(after.text, /拷贝到不联网盘|拷到不联网盘/);
  // 日期块一字未动
  assert.match(findBlocks(after, '11-09')[0].body, /早上 10:04 打招呼/);
});

test('ml_edit 撞到两处相同的原文时拒绝', () => {
  const doc = parseDoc(['# a', '', '## 11-10', '- 同一句。', '- 同一句。', ''].join('\n'), 'a.md', 2026);
  const result = editInBlock(doc, '11-10', '同一句', '改掉');
  assert.ok('error' in result);
  assert.match(result.error, /出现 2 次/);
});

test('ml_edit 找不到原文时拒绝，且不给新内容为空', () => {
  const missing = editInBlock(cj(), '还挂着', '不存在的句子', 'x');
  assert.ok('error' in missing);
  assert.match(missing.error, /里没有/);
  const empty = editInBlock(cj(), '还挂着', '备份拷到不联网盘', '   ');
  assert.ok('error' in empty);
  assert.match(empty.error, /ml_delete/);
});

test('ml_delete 删整条，含续行一起走', () => {
  const doc = parseDoc(
    ['# a', '', '## 11-10', '- 第一条，', '  续行还在。', '- 第二条。', ''].join('\n'),
    'a.md',
    2026,
  );
  assert.equal(findBlocks(doc, '11-10')[0].entries.length, 2);
  const result = deleteInBlock(doc, '11-10', '第一条');
  assert.ok(!('error' in result), 'error' in result ? result.error : '');
  const after = parseDoc(result.text, 'a.md', 2026);
  assert.equal(findBlocks(after, '11-10')[0].entries.length, 1);
  assert.doesNotMatch(after.text, /续行还在/);
  assert.match(after.text, /第二条/);
});

test('ml_delete 命中两条时拒绝，不乱删', () => {
  const doc = parseDoc(['# a', '', '## 11-10', '- 测试一条。', '- 测试两条。', ''].join('\n'), 'a.md', 2026);
  const result = deleteInBlock(doc, '11-10', '测试');
  assert.ok('error' in result);
  assert.match(result.error, /2 条/);
});

test('文件头不属于任何块：block 写「文件头」就能改，块一个不动', () => {
  const result = editInBlock(cj(), '文件头', '本文件持有：今天、昨天的事。', '本文件持有：今天、昨天、还挂着的判断。');
  assert.ok(!('error' in result), 'error' in result ? result.error : '');
  const after = parseDoc(result.text, '超近期.md', 2026);
  assert.match(after.front, /还挂着的判断/);
  assert.deepEqual(after.blocks.map(handleOf), ['2026-11-09', '2026-11-10', '还挂着']);
  assert.match(findBlocks(after, '11-09')[0].body, /早上 10:04 打招呼/);
});

test('文件头里找不到原文时，把文件头现在的内容一起给回来', () => {
  const result = editInBlock(cj(), '文件头', '没有这一句', 'x');
  assert.ok('error' in result);
  assert.match(result.error, /文件头里没有/);
  assert.match(result.hint ?? '', /本文件持有/);
});

test('old 抄错时，回执带上这一块现有的前三条', () => {
  const doc = parseDoc(['# a', '', '## 还挂着', '- 一。', '- 二。', '- 三。', '- 四。', ''].join('\n'), 'a.md', 2026);
  const result = editInBlock(doc, '还挂着', '找不到的', 'x');
  assert.ok('error' in result);
  assert.match(result.hint ?? '', /共 4 条，只列前 3 条/);
  assert.match(result.hint ?? '', /- 一。/);
  assert.doesNotMatch(result.hint ?? '', /- 四。/);
});

test('块名写错时，回执列出这份文件里有哪些块', () => {
  const result = editInBlock(cj(), '头', 'x', 'y');
  assert.ok('error' in result);
  assert.match(result.error, /没找到「头」/);
  assert.match(result.hint ?? '', /这份文件里有：2026-11-09/);
});
