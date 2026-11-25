/**
 * 心跳判据的测试。纯函数，不碰磁盘、不碰宿主。
 * 重点：跨天清零由 world 管（这里只测判据）、0 = 不限、读不到 usage 照样推。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IDLE_MINUTES, DEFAULT_TEMPLATE_EN, DEFAULT_TEMPLATE_ZH, DEFAULT_TICK_SECONDS,
  clampIdleMinutes, clampMaxPerDay, clampTickSeconds, decideBeat, formatClock,
  localDay, localHour, localMinuteOfDay, minutesOf, renderHeartbeat,
  type BeatFacts, type BeatPolicy,
} from '../src/beat.ts';

const NOW = Date.UTC(2026, 10, 16, 6, 0, 0);
const MIN = 60_000;

const policy = (over: Partial<BeatPolicy> = {}): BeatPolicy => ({
  idleMinutes: 40, maxPerDay: 48, ...over,
});

const facts = (over: Partial<BeatFacts> = {}): BeatFacts => ({
  now: NOW, lastCallAt: NOW - 41 * MIN, lastBeatAt: null, pushedToday: 0, ...over,
});

test('clampIdleMinutes：1–1440，写坏退默认', () => {
  assert.equal(clampIdleMinutes(40), 40);
  assert.equal(clampIdleMinutes(600), 600, '上限放开到一天，填 600 就给 600');
  assert.equal(clampIdleMinutes(0), 1);
  assert.equal(clampIdleMinutes(Number.NaN), DEFAULT_IDLE_MINUTES);
  assert.equal(clampIdleMinutes('40'), DEFAULT_IDLE_MINUTES);
});

test('clampTickSeconds / clampMaxPerDay：范围和 0 = 不限', () => {
  assert.equal(clampTickSeconds(15), 15);
  assert.equal(clampTickSeconds(1), 5);
  assert.equal(clampTickSeconds(9999), 300);
  assert.equal(clampTickSeconds(undefined), DEFAULT_TICK_SECONDS);
  assert.equal(clampMaxPerDay(0), 0);
  assert.equal(clampMaxPerDay(-3), 0);
  assert.equal(clampMaxPerDay(9999), 240);
});

test('decideBeat：空档够了才补，上一拍刚推过不补', () => {
  assert.equal(decideBeat(facts(), policy()).fire, true);
  const early = decideBeat(facts({ lastCallAt: NOW - 39 * MIN }), policy());
  assert.equal(early.fire, false);
  assert.match(early.fire === false ? early.note : '', /还没到 40/);
  const fresh = decideBeat(facts({ lastBeatAt: NOW - 5 * MIN }), policy());
  assert.equal(fresh.fire, false);
  assert.match(fresh.fire === false ? fresh.note : '', /上一拍刚推过/);
});

test('decideBeat：日上限 0 = 不限', () => {
  assert.equal(decideBeat(facts({ pushedToday: 48 }), policy({ maxPerDay: 48 })).fire, false);
  assert.equal(decideBeat(facts({ pushedToday: 48 }), policy({ maxPerDay: 0 })).fire, true);
});

test('decideBeat：读不到 usage 账照样推', () => {
  const d = decideBeat(facts({ lastCallAt: null }), policy());
  assert.equal(d.fire, true);
  assert.equal(d.fire === true ? d.gapMinutes : 0, -1);
});

test('renderHeartbeat：换 {time}，留空退默认', () => {
  assert.equal(renderHeartbeat('（静默心跳：{time}）', '14:00', 'x'), '（静默心跳：14:00）');
  assert.equal(renderHeartbeat('{time} / {time}', '09:05', 'x'), '09:05 / 09:05');
  assert.equal(renderHeartbeat('没有占位符', '14:00', 'x'), '没有占位符');
  assert.equal(renderHeartbeat('', '14:00', DEFAULT_TEMPLATE_ZH), '静默心跳14:00，无需回复。');
  assert.equal(renderHeartbeat(undefined, '14:00', DEFAULT_TEMPLATE_EN).startsWith('(Silent heartbeat'), true);
});

test('时区与当天分钟数：上海的时刻、跨日', () => {
  assert.equal(formatClock('Asia/Shanghai', NOW), '14:00');
  assert.equal(localHour('Asia/Shanghai', NOW), 14);
  assert.equal(localMinuteOfDay('Asia/Shanghai', NOW), 14 * 60);
  assert.equal(localDay('Asia/Shanghai', NOW), '2026-11-16');
  const late = Date.UTC(2026, 10, 16, 16, 0, 0);
  assert.equal(localDay('Asia/Shanghai', late), '2026-11-17');
  assert.equal(localMinuteOfDay('Asia/Shanghai', late), 0);
});

test('minutesOf：非有限报 -1，负数归 0', () => {
  assert.equal(minutesOf(41 * MIN), 41);
  assert.equal(minutesOf(Number.POSITIVE_INFINITY), -1);
  assert.equal(minutesOf(-5000), 0);
});
