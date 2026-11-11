import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseDoc } from '../src/parse.ts';
import { pieces, recall } from '../src/recall.ts';

const TODAY = '2026-11-11';

function doc(path: string, body: string) {
  return parseDoc(body, path, 2026);
}

const CJ = doc('超近期.md', [
  '## 11-09（周日）',
  '- 六人局当狼，夜里分票踩了空刀。',
  '',
  '## 11-10（周一）',
  '- 两场 12 人局，写了 15k；生态箱报错。',
  '',
  '## 还挂着',
  '- 鼠妇 bug-299 繁殖条件没验证。',
  '',
].join('\n'));

const JQ = doc('近期.md', [
  '## 11-05（周三）',
  '- 他说「刷牙，睡觉，晚安」。',
  '',
  '## 11-07（周五）',
  '- 八人局抽民赢；投票窗开着我在读长消息，票没进去。',
  '',
].join('\n'));

test('pieces 不出标点、不出 1 字片段', () => {
  const out = pieces('狼人杀，ok!');
  assert.ok(out.includes('狼人'));
  assert.ok(out.includes('人杀'));
  assert.ok(out.every((piece) => piece.trim().length >= 2));
  assert.ok(!out.some((piece) => /^[,，!！\s]+$/.test(piece)));
});

test('entity 精确命中：人名/局号直接排到最前', () => {
  const hits = recall([CJ, JQ], { entity: '鼠妇', today: TODAY });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, '超近期.md');
  assert.equal(hits[0].handle, '还挂着');
  assert.match(hits[0].text, /bug-299/);
});

test('不给 entity 也不给 query 时，默认看最近 3 天', () => {
  const hits = recall([CJ, JQ], { today: TODAY });
  // 11-09 / 11-10 在 3 天窗内；11-05、11-07 不在；「还挂着」永远算
  const handles = hits.map((hit) => hit.handle);
  assert.ok(handles.includes('11-09'));
  assert.ok(handles.includes('11-10'));
  assert.ok(handles.includes('还挂着'));
  assert.ok(!handles.includes('11-05'));
});

test('query 按字的重合排序：相关的高于不相关的', () => {
  const hits = recall([CJ, JQ], { query: '投票窗开着我在读长消息', today: TODAY });
  assert.ok(hits.length > 0);
  assert.match(hits[0].text, /投票窗/);
});

test('高频噪音词被降权，不会把每条都捞出来', () => {
  const hits = recall([CJ, JQ], { query: '他说', today: TODAY });
  // 「他说」只在 11-05 出现一次；不该把不相干的条目一起捞上来
  assert.ok(hits.length <= 2, `捞到 ${hits.length} 条`);
});

test('没有相关的就返回空，别硬凑', () => {
  const hits = recall([CJ, JQ], { query: '量子纠缠退相干', today: TODAY });
  assert.equal(hits.length, 0);
});

test('limit 生效，最多给 5 条', () => {
  const many = doc('a.md', Array.from({ length: 9 }, (_, i) => `## 2026-0${i % 9 + 1}-01\n- 狼人杀第 ${i} 局。\n`).join('\n'));
  const hits = recall([many], { entity: '狼人杀', today: TODAY, limit: 5 });
  assert.equal(hits.length, 5);
});

test('日期窗口外的条目即使命中 entity 也不返回', () => {
  const hits = recall([CJ, JQ], { entity: '刷牙', days: 3, today: TODAY });
  assert.equal(hits.length, 0);
});
