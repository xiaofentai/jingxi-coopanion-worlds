/**
 * 补拍判据的测试。全是纯函数，所以不碰磁盘、不碰宿主。
 *
 * 重点盯四处：**跨零点窗口**、**0 = 不限**、**读不到使用账时照样推**、
 * **正文模板留空时退回默认**（这四条都属于「写错了不会报错，只会默默多花钱或少保温」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AFTER_MINUTES, DEFAULT_TEMPLATE_EN, DEFAULT_TEMPLATE_ZH, DEFAULT_TICK_SECONDS,
  clampAfterMinutes, clampMaxPerDay, clampTickSeconds, decideBeat, formatClock,
  inQuietWindow, localDay, localHour, minutesOf, parseQuietHours, renderHeartbeat,
  type BeatFacts, type BeatPolicy,
} from '../src/beat.ts';

const NOW = Date.UTC(2026, 10, 16, 6, 0, 0); // 2026-11-16 14:00 +08
const MIN = 60_000;

const policy = (over: Partial<BeatPolicy> = {}): BeatPolicy => ({
  afterMinutes: 40,
  quiet: null,
  maxPerDay: 48,
  ...over,
});

const facts = (over: Partial<BeatFacts> = {}): BeatFacts => ({
  now: NOW,
  lastCallAt: NOW - 41 * MIN,
  lastBeatAt: null,
  pushedToday: 0,
  hour: 14,
  ...over,
});

test('parseQuietHours：空串表示全天都补', () => {
  assert.equal(parseQuietHours(''), null);
  assert.equal(parseQuietHours('   '), null);
  assert.deepEqual(parseQuietHours('2-7'), { from: 2, to: 7 });
  assert.deepEqual(parseQuietHours(' 23 - 7 '), { from: 23, to: 7 });
  assert.deepEqual(parseQuietHours('2–7'), { from: 2, to: 7 });
});

test('parseQuietHours：写坏了当空串，宁可多推一拍也别整个关掉', () => {
  assert.equal(parseQuietHours('junk'), null);
  assert.equal(parseQuietHours('25-3'), null);
  assert.equal(parseQuietHours('2-24'), null);
  assert.equal(parseQuietHours('5-5'), null, '起止相同等于没有窗口，不能读成一整天都不补');
  assert.equal(parseQuietHours(42), null);
});

test('inQuietWindow：普通窗口与跨零点窗口', () => {
  assert.equal(inQuietWindow(3, { from: 2, to: 7 }), true);
  assert.equal(inQuietWindow(7, { from: 2, to: 7 }), false);
  assert.equal(inQuietWindow(2, { from: 2, to: 7 }), true);
  assert.equal(inQuietWindow(14, null), false);
  // 跨零点
  assert.equal(inQuietWindow(23, { from: 23, to: 7 }), true);
  assert.equal(inQuietWindow(0, { from: 23, to: 7 }), true);
  assert.equal(inQuietWindow(6, { from: 23, to: 7 }), true);
  assert.equal(inQuietWindow(7, { from: 23, to: 7 }), false);
  assert.equal(inQuietWindow(12, { from: 23, to: 7 }), false);
});

test('clampAfterMinutes：整段可调，写坏了退默认', () => {
  assert.equal(clampAfterMinutes(40), 40);
  assert.equal(clampAfterMinutes(1), 1);
  assert.equal(clampAfterMinutes(600), 600, '上限放开到一天：填 600 就给 600');
  assert.equal(clampAfterMinutes(0), 1);
  assert.equal(clampAfterMinutes(Number.NaN), DEFAULT_AFTER_MINUTES);
  assert.equal(clampAfterMinutes('40'), DEFAULT_AFTER_MINUTES);
});

test('clampTickSeconds：5–300 秒，写坏了退默认', () => {
  assert.equal(clampTickSeconds(15), 15);
  assert.equal(clampTickSeconds(1), 5);
  assert.equal(clampTickSeconds(9999), 300);
  assert.equal(clampTickSeconds(undefined), DEFAULT_TICK_SECONDS);
});

test('clampMaxPerDay：0 表示不限，负数归 0', () => {
  assert.equal(clampMaxPerDay(48), 48);
  assert.equal(clampMaxPerDay(0), 0);
  assert.equal(clampMaxPerDay(-3), 0);
  assert.equal(clampMaxPerDay(9999), 240);
});

test('decideBeat：空档够了就补，没够就不补', () => {
  assert.equal(decideBeat(facts({ lastCallAt: NOW - 41 * MIN }), policy()).fire, true);
  const early = decideBeat(facts({ lastCallAt: NOW - 39 * MIN }), policy());
  assert.equal(early.fire, false);
  assert.match(early.fire === false ? early.note : '', /还没到 40/);
});

test('decideBeat：上一拍刚推过就不再推（自己不能把自己催起来）', () => {
  const d = decideBeat(facts({ lastBeatAt: NOW - 5 * MIN }), policy());
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /上一拍刚推过/);
});

test('decideBeat：日上限到顶就停，0 表示不限', () => {
  assert.equal(decideBeat(facts({ pushedToday: 48 }), policy({ maxPerDay: 48 })).fire, false);
  assert.equal(decideBeat(facts({ pushedToday: 48 }), policy({ maxPerDay: 0 })).fire, true);
  assert.equal(decideBeat(facts({ pushedToday: 47 }), policy({ maxPerDay: 48 })).fire, true);
});

test('decideBeat：夜间窗口挡住，留空就挡住', () => {
  assert.equal(decideBeat(facts({ hour: 3 }), policy({ quiet: { from: 2, to: 7 } })).fire, false);
  assert.equal(decideBeat(facts({ hour: 14 }), policy({ quiet: { from: 2, to: 7 } })).fire, true);
  assert.equal(decideBeat(facts({ hour: 3 }), policy({ quiet: null })).fire, true);
});

test('decideBeat：读不到使用账（文件还没有）照样推，并报 -1', () => {
  const d = decideBeat(facts({ lastCallAt: null }), policy());
  assert.equal(d.fire, true);
  assert.equal(d.fire === true ? d.gapMinutes : 0, -1);
});

test('decideBeat：阈值填到 600 就按 600 算，不偷偷夹回 70', () => {
  assert.equal(decideBeat(facts({ lastCallAt: NOW - 300 * MIN }), policy({ afterMinutes: 600 })).fire, false);
  assert.equal(decideBeat(facts({ lastCallAt: NOW - 601 * MIN }), policy({ afterMinutes: 600 })).fire, true);
});

test('renderHeartbeat：换掉 {time}，可以有多个', () => {
  assert.equal(renderHeartbeat('（静默心跳：现在是 {time}）', '14:00', 'x'), '（静默心跳：现在是 14:00）');
  assert.equal(renderHeartbeat('{time} / {time}', '09:05', 'x'), '09:05 / 09:05');
  assert.equal(renderHeartbeat('没有占位符', '14:00', 'x'), '没有占位符', '没写占位符就原样发出去，不硬塞时间');
});

test('renderHeartbeat：留空或写坏了退回默认那句', () => {
  assert.equal(renderHeartbeat('', '14:00', DEFAULT_TEMPLATE_ZH), '（静默心跳：现在是 14:00）');
  assert.equal(renderHeartbeat('   ', '14:00', DEFAULT_TEMPLATE_ZH), '（静默心跳：现在是 14:00）');
  assert.equal(renderHeartbeat(undefined, '14:00', DEFAULT_TEMPLATE_EN), '(Silent heartbeat: it is now 14:00)');
  assert.equal(renderHeartbeat(42, '14:00', DEFAULT_TEMPLATE_ZH), '（静默心跳：现在是 14:00）');
});

test('默认模板本身是可渲染的，且很短', () => {
  const zh = renderHeartbeat('', '14:00', DEFAULT_TEMPLATE_ZH);
  assert.ok(zh.length <= 30, `默认正文太长了：${zh.length} 字`);
  assert.match(zh, /14:00/);
});

test('minutesOf：非有限值报 -1，负数归 0', () => {
  assert.equal(minutesOf(41 * MIN), 41);
  assert.equal(minutesOf(Number.POSITIVE_INFINITY), -1);
  assert.equal(minutesOf(-5000), 0);
});

test('时区：上海的时刻与跨日', () => {
  assert.equal(formatClock('Asia/Shanghai', NOW), '14:00');
  assert.equal(localHour('Asia/Shanghai', NOW), 14);
  assert.equal(localDay('Asia/Shanghai', NOW), '2026-11-16');
  assert.equal(localHour('UTC', NOW), 6);
  // 跨日：UTC 的 16:00 = 上海次日 00:00
  const late = Date.UTC(2026, 10, 16, 16, 0, 0);
  assert.equal(localDay('Asia/Shanghai', late), '2026-11-17');
  assert.equal(localHour('Asia/Shanghai', late), 0);
});
