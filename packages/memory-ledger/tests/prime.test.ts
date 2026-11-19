import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PRIME_COOLDOWN_MS, coolEnough, primeHits, primeKey, primeText, withinDailyBudget } from '../src/prime.ts';
import type { RecallHit } from '../src/recall.ts';

function hit(handle: string, text: string, tier: 'strong' | 'weak' = 'strong', file = '近期.md'): RecallHit {
  return { file, handle, date: `2026-${handle}`, text, score: 10, tier, bigrams: 2 };
}

test('只递「对得上」的，沾边的一条都不给', () => {
  const hits = [hit('11-03', '尾巴那件事'), hit('11-05', '刷牙睡觉', 'weak'), hit('11-07', '八人局赢了')];
  const picked = primeHits(hits);
  assert.deepEqual(picked.map((item) => item.handle), ['11-03', '11-07']);
});

test('一次最多两条', () => {
  const hits = ['11-01', '11-02', '11-03', '11-04'].map((handle) => hit(handle, '一件事'));
  assert.equal(primeHits(hits).length, 2);
  assert.equal(primeHits(hits, 3).length, 3);
});

test('冷却按「文件 + 句柄」算，不是按内容', () => {
  const a = hit('11-03', '尾巴');
  const b = hit('11-03', '尾巴', 'strong', '超近期.md');
  assert.notEqual(primeKey(a), primeKey(b));

  const lastAt = new Map([[primeKey(a), 1000]]);
  const now = 1000 + 60_000;
  assert.deepEqual(coolEnough(lastAt, [a, b], now).map((item) => item.file), ['超近期.md']);
});

test('冷却过了就放行，差一毫秒还在冷却里', () => {
  const a = hit('11-03', '尾巴');
  const lastAt = new Map([[primeKey(a), 0]]);
  assert.equal(coolEnough(lastAt, [a], PRIME_COOLDOWN_MS).length, 0, '正好到期那一下还算冷却');
  assert.equal(coolEnough(lastAt, [a], PRIME_COOLDOWN_MS + 1).length, 1, '过了就放行');
});

test('推出去的那段话：先说清不是他刚说的、不用回、要回走原通道', () => {
  const text = primeText([hit('11-03', '为尾巴拌了嘴，这段我记得清楚'), hit('11-07', '八人局赢了', 'strong', '超近期.md')]);
  const lines = text.split('\n');
  assert.match(lines[0], /不是他刚说的/);
  assert.match(lines[0], /不用回这条/);
  assert.match(lines.at(-1), /微信 \/ 气泡/);
  assert.match(lines[1], /^· 11-03（近期）为尾巴拌了嘴/);
  assert.match(lines[2], /^· 11-07（超近期）八人局赢了/);
});

test('日预算：额度内放行，用完就不推，0 表示不限', () => {
  assert.equal(withinDailyBudget(0, 3), true);
  assert.equal(withinDailyBudget(2, 3), true);
  assert.equal(withinDailyBudget(3, 3), false);
  assert.equal(withinDailyBudget(4, 3), false);
  assert.equal(withinDailyBudget(99, 0), true, '0 = 不限');
});

test('长条目截断并标出来；空结果返回空串', () => {
  const text = primeText([hit('11-03', '很长的'.repeat(40))]);
  const line = text.split('\n')[1];
  assert.ok(line.endsWith('…'), line);
  assert.equal(primeText([]), '');
});
