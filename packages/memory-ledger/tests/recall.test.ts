import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseDoc } from '../src/parse.ts';
import { extractDates, recall, tokenize } from '../src/recall.ts';

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

test('tokenize 只在短语内切二元组，英文数字整词，不跨标点', () => {
  const out = tokenize('狼人杀，ok! bug-299');
  assert.ok(out.includes('狼人'));
  assert.ok(out.includes('人杀'));
  assert.ok(out.includes('ok'));
  assert.ok(out.includes('bug'));
  assert.ok(out.includes('299'));
  assert.ok(out.every((token) => token.length >= 2));
  // 跨标点的碎片不该出现
  assert.ok(!out.includes('杀o'));
  assert.ok(!out.includes('k b'));
});

test('两档：实词对上算 strong，只撞口水词算 weak', () => {
  const strong = recall([CJ, JQ], { query: '投票窗开着我在读长消息', today: TODAY });
  assert.equal(strong[0].tier, 'strong');
  assert.ok(strong[0].bigrams >= 1);

  const weak = recall([CJ, JQ], { query: '他说', today: TODAY });
  assert.ok(weak.length >= 1);
  assert.ok(weak.every((hit) => hit.tier === 'weak'), '只撞「他说」不该有明显的强命中');
});

test('日期从文本里摘出来单独走，不当字面线索', () => {
  const { dates, rest } = extractDates('11-06 那天我们聊了什么', TODAY);
  assert.deepEqual(dates, ['2026-11-06']);
  assert.ok(!rest.includes('11-06'));
  assert.ok(!rest.includes('11'), rest);
});

test('日期通道能把那天的条目顶上来', () => {
  const hits = recall([CJ, JQ], { query: '11-07 那局怎么样', today: TODAY });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].date, '2026-11-07');
  assert.equal(hits[0].tier, 'strong');
});

test('「昨天」也走日期通道', () => {
  assert.deepEqual(extractDates('昨天那个局', TODAY).dates, ['2026-11-10']);
});

test('关掉日期通道：只写一个日期就什么也找不到', () => {
  // 默认会靠日期把 11-05 那天捞出来
  assert.ok(recall([CJ, JQ], { query: '11-05', today: TODAY }).length > 0);
  // 关掉之后，日期只是几个没人认识的数字
  assert.equal(recall([CJ, JQ], { query: '11-05', today: TODAY, useDates: false }).length, 0);
});

test('关掉日期通道不影响正文命中', () => {
  const on = recall([CJ, JQ], { query: '投票窗开着我在读长消息', today: TODAY });
  const off = recall([CJ, JQ], { query: '投票窗开着我在读长消息', today: TODAY, useDates: false });
  assert.equal(off[0]?.text, on[0]?.text);
  assert.equal(off[0]?.tier, 'strong');
});

const MIXED = parseDoc(
  [
    '# a',
    '',
    '## 11-09（周一）',
    '- 那天他教我看前缀。',
    '- 下午打牌输了，还踩了空刀。',
    '',
    '## 2026-10',
    '- **10-14**：第一次见面。',
    '- **10-20**：升版本，气泡能跳过了。',
    '',
  ].join('\n'),
  'a.md',
  2026,
);

test('按块比时，日块只拿首行——条目里的细节不参选', () => {
  assert.ok(recall([MIXED], { query: '下午打牌', today: TODAY }).length > 0, '按条目时能命中');
  assert.equal(
    recall([MIXED], { query: '下午打牌', today: TODAY, level: 'block' }).length,
    0,
    '按块时那一条不在候选里',
  );
  const head = recall([MIXED], { query: '教我看前缀', today: TODAY, level: 'block' });
  assert.equal(head[0]?.handle, '11-09');
  assert.equal(head[0]?.text, '那天他教我看前缀。');
});

test('按块比时，大事记的每一条都还算数（它本来就是一行一件事）', () => {
  const hits = recall([MIXED], { query: '升版本', today: TODAY, level: 'block' });
  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.handle, '2026-10');
  assert.match(hits[0]?.text ?? '', /10-20/);
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
