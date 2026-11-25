/**
 * 纸条判据的测试。纯函数。
 * 重点：三个时段各自限额、跨零点、间隔跨段共用、窗口内抖动（同一天稳定、跨天变化）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideNote, inWindow, jitterMinute, jitterOffset, parseClock, renderNote, slotEnabled,
  windowSpan, type NoteFacts, type NotePolicy,
} from '../src/note.ts';
import { DEFAULT_NOTE_TEXT, type NoteSlot } from '../src/settings.ts';

const HOUR = 60;
const NOW = Date.UTC(2026, 10, 16, 6, 0, 0);
const DAY = '2026-11-16';

const slot = (from: string, to: string, perDay = 1): NoteSlot => ({ from, to, perDay });
const policy = (slots: NoteSlot[], gapMinutes = 120): NotePolicy => ({ slots, gapMinutes });
const facts = (minuteOfDay: number, over: Partial<NoteFacts> = {}): NoteFacts => ({
  now: NOW, minuteOfDay, day: DAY, lastNoteAt: null, slotPushedToday: [0, 0, 0], ...over,
});

/** 窗口末尾前一分钟：任何抖动点都已过，用来测「名额/间隔」这类和抖动无关的分支。 */
const END9_12 = 12 * HOUR - 1;
const END14_18 = 18 * HOUR - 1;

test('parseClock：9 / 14:30 / 空串 / 写坏', () => {
  assert.equal(parseClock('9'), 540);
  assert.equal(parseClock('09:30'), 570);
  assert.equal(parseClock('23:59'), 1439);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('   '), null);
  assert.equal(parseClock('25'), null);
  assert.equal(parseClock('9:99'), null);
  assert.equal(parseClock('junk'), null);
});

test('slotEnabled：两端都有、perDay > 0 才生效', () => {
  assert.equal(slotEnabled(slot('9', '12')), true);
  assert.equal(slotEnabled(slot('', '12')), false);
  assert.equal(slotEnabled(slot('9', '')), false);
  assert.equal(slotEnabled(slot('9', '12', 0)), false);
});

test('inWindow / windowSpan：普通窗口和跨零点窗口', () => {
  assert.equal(inWindow(9 * HOUR, 9 * HOUR, 12 * HOUR), true);
  assert.equal(inWindow(12 * HOUR, 9 * HOUR, 12 * HOUR), false, '右端不含');
  assert.equal(windowSpan(9 * HOUR, 12 * HOUR), 180);
  assert.equal(windowSpan(22 * HOUR, 2 * HOUR), 240, '跨零点绕一圈');
  assert.equal(inWindow(23 * HOUR, 22 * HOUR, 2 * HOUR), true);
  assert.equal(inWindow(1 * HOUR, 22 * HOUR, 2 * HOUR), true);
  assert.equal(inWindow(12 * HOUR, 22 * HOUR, 2 * HOUR), false);
});

test('jitterOffset：同一天同一段稳定、跨天变化、始终落在窗口内', () => {
  const a = jitterOffset(DAY, 0, 0, 1, 180);
  assert.equal(jitterOffset(DAY, 0, 0, 1, 180), a, '同一天重启不漂');
  assert.ok(a >= 0 && a < 180, `抖动点应在窗口内，实际 ${a}`);
  assert.notEqual(jitterOffset('2026-11-17', 0, 0, 1, 180), a, '隔天换一个点');
  assert.notEqual(jitterOffset(DAY, 1, 0, 1, 180), a, '不同段的点不同');
});

test('jitterOffset：perDay=2 时两张各在窗口的前后半段，不会挤一起', () => {
  const first = jitterOffset(DAY, 0, 0, 2, 180);
  const second = jitterOffset(DAY, 0, 1, 2, 180);
  assert.ok(first < 90 && second >= 90, `第一张 ${first} 应在前半段，第二张 ${second} 应在后半段`);
});

test('jitterMinute：跨零点窗口的抖动点也落在 0–1439', () => {
  const offset = jitterOffset(DAY, 0, 0, 1, windowSpan(22 * HOUR, 2 * HOUR));
  const minute = jitterMinute(22 * HOUR, offset);
  assert.ok(minute >= 0 && minute < 1440);
  assert.equal(minute >= 22 * HOUR || minute < 2 * HOUR, true, '落在 22-2 窗口里');
});

test('decideNote：窗口一开不推，要等到当天抖动点', () => {
  const target = jitterOffset(DAY, 0, 0, 1, 180);
  assert.ok(target > 0, '这一天这一段有抖动（不是 0），否则下面两个断言没意义');
  const before = decideNote(facts(9 * HOUR), policy([slot('9', '12')]));
  assert.equal(before.fire, false);
  assert.match(before.fire === false ? before.note : '', /窗口内抖了一下/);

  const after = decideNote(facts(9 * HOUR + target), policy([slot('9', '12')]));
  assert.deepEqual(after, { fire: true, slot: 0 });
});

test('decideNote：落在窗口里、名额没用完、抖动点过了 → 推对应段', () => {
  assert.deepEqual(decideNote(facts(END9_12), policy([slot('9', '12'), slot('14', '18')])), { fire: true, slot: 0 });
  assert.deepEqual(decideNote(facts(END14_18), policy([slot('9', '12'), slot('14', '18')])), { fire: true, slot: 1 });
});

test('decideNote：不在任何窗口 → 不推', () => {
  const d = decideNote(facts(13 * HOUR), policy([slot('9', '12'), slot('14', '18')]));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /不在任何启用的纸条时段/);
});

test('decideNote：窗口名用完了 → 不推，且和「不在窗口」分得开', () => {
  const d = decideNote(facts(END9_12, { slotPushedToday: [1, 0, 0] }), policy([slot('9', '12'), slot('14', '18')]));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /名额今天用完/);
});

test('decideNote：间隔跨段共用——刚推过一张，换到下一个窗口也不推', () => {
  const d = decideNote(facts(END14_18, { lastNoteAt: NOW - 30 * 60_000 }),
    policy([slot('9', '12'), slot('14', '18')], 120));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /距上一张纸条还差 90 分钟/);

  const ok = decideNote(facts(END14_18, { lastNoteAt: NOW - 121 * 60_000 }),
    policy([slot('9', '12'), slot('14', '18')], 120));
  assert.deepEqual(ok, { fire: true, slot: 1 });
});

test('decideNote：间隔 0 = 关掉这道闸', () => {
  const d = decideNote(facts(END14_18, { lastNoteAt: NOW - 1000 }),
    policy([slot('9', '12'), slot('14', '18'), slot('19', '22')], 0));
  assert.deepEqual(d, { fire: true, slot: 1 });
});

test('decideNote：重叠窗口只推第一段，不会一次推两张', () => {
  const d = decideNote(facts(END9_12), policy([slot('9', '12'), slot('10', '11')]));
  assert.deepEqual(d, { fire: true, slot: 0 });
});

test('renderNote：换 {time}，留空退默认，默认句不诱导气泡回复', () => {
  assert.equal(renderNote('现在{time}啦', '14:00', 'x'), '现在14:00啦');
  assert.equal(renderNote('', '14:00', DEFAULT_NOTE_TEXT), DEFAULT_NOTE_TEXT.replace('{time}', '14:00'));
  assert.match(DEFAULT_NOTE_TEXT, /不是 ta 说的/);
  assert.match(DEFAULT_NOTE_TEXT, /别回这条/);
  assert.doesNotMatch(DEFAULT_NOTE_TEXT, /要不要/);
  assert.match(DEFAULT_NOTE_TEXT, /直接调工具去做/);
});
