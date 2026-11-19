import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_SENDERS, pickRecent, readRecent, type SayEvent } from '../src/recent.ts';

const NOW = Date.UTC(2026, 10, 13, 14, 0, 0);

/** 一条「他说的」事件：形状照 `GET /api/events` 的实测结果。 */
function say(at: number, text: string, cursor = at, type = 'clawbot.message'): SayEvent {
  return { origin: 'external', type, senderKey: 'desktop-pet.chat', ts: new Date(at).toISOString(), text, cursor };
}

test('取最新那一句，并带回游标', () => {
  const events = [say(NOW - 120_000, '早啊'), say(NOW - 60_000, '今晚什么时候打狼人杀呀', 42), say(NOW - 30_000, '好')];
  const got = pickRecent(events, { now: NOW });
  assert.equal(got?.text, '今晚什么时候打狼人杀呀');
  assert.equal(got?.cursor, 42);
});

test('太旧的句子不算「刚说的」', () => {
  assert.equal(pickRecent([say(NOW - 11 * 60_000, '昨晚那局怎么样')], { now: NOW }), null);
});

test('太短的不算一句话', () => {
  assert.equal(pickRecent([say(NOW - 1000, '嗯好')], { now: NOW }), null);
  assert.equal(pickRecent([say(NOW - 1000, '嗯好')], { now: NOW, minChars: 2 })?.text, '嗯好');
});

test('三个真实渠道都算「他说的」', () => {
  for (const type of ['clawbot.message', 'desktop-pet.message', 'starpost.owner_message']) {
    const got = pickRecent([say(NOW - 1000, '今晚打不打', 7, type)], { now: NOW });
    assert.equal(got?.text, '今晚打不打', type);
    assert.ok(DEFAULT_SENDERS.test(type), type);
  }
});

test('external 但不是他说话的不算：通知摘要、牌局视图、交接笔记', () => {
  const events: SayEvent[] = [
    say(NOW - 1000, '星邮有 3 条新通知', 1, 'starpost.notification_digest'),
    say(NOW - 2000, '牌桌 D1 有人出局', 2, 'starpost.game_view'),
    say(NOW - 3000, '这一段交接写完了', 3, 'handoff-note'),
  ];
  assert.equal(pickRecent(events, { now: NOW }), null);
});

test('宿主自己的事件（origin=internal）一律不算', () => {
  const events: SayEvent[] = [
    { origin: 'internal', type: 'parlor.started', senderKey: 'parlor', ts: new Date(NOW - 1000).toISOString(), text: '客厅已连接，席位小鲸汐' },
    { origin: 'internal', type: 'notice', ts: new Date(NOW - 2000).toISOString(), text: '现在该睡觉了，停止闲聊' },
  ];
  assert.equal(pickRecent(events, { now: NOW }), null);
});

test('新渠道只要类型也叫 xxx.message 就自动算进来', () => {
  assert.equal(pickRecent([say(NOW - 1000, '我看到你的帖子了', 9, 'weibo.message')], { now: NOW })?.text, '我看到你的帖子了');
});

test('没给游标就是 -1；带 g 的正则不会因为 lastIndex 漏第二条', () => {
  const events: SayEvent[] = [
    { origin: 'external', type: 'parlor.message', ts: new Date(NOW - 1000).toISOString(), text: '在吗，今天怎么样' },
  ];
  assert.equal(pickRecent(events, { now: NOW })?.cursor, -1);

  const twice = [say(NOW - 5000, '第一句'), say(NOW - 1000, '第二句话')];
  const re = /\.message$/g;
  assert.equal(pickRecent(twice, { now: NOW, senders: re })?.text, '第二句话');
  assert.equal(pickRecent(twice, { now: NOW, senders: re })?.text, '第二句话');
});

test('拿不到事件库时返回 null，不抛', () => {
  assert.equal(readRecent(undefined, { now: NOW }), null);
  assert.equal(readRecent({}, { now: NOW }), null);
  assert.equal(
    readRecent({ range: () => { throw new Error('boom'); } }, { now: NOW }),
    null,
  );
  assert.equal(readRecent({ range: () => 'not an array' }, { now: NOW }), null);
});

test('有事件库时按 external 读，并挑出最新一句', () => {
  const asked: Array<Record<string, unknown>> = [];
  const store = {
    range(query: { origin?: string; limit?: number }) {
      asked.push(query);
      return [say(NOW - 90_000, '整理了吗'), say(NOW - 20_000, '鼠妇繁殖了没')];
    },
  };
  assert.equal(readRecent(store, { now: NOW })?.text, '鼠妇繁殖了没');
  assert.deepEqual(asked[0], { origin: 'external', limit: 60 });
});
