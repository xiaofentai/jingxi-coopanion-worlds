/**
 * 早晚安判据的测试。纯函数。
 * 重点：时刻留空不启用、双向抖动当天稳定隔天换、一天一次、窗口过了不补、正文占位符。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GREETING_HINT, decideGreeting, greetingEnabled, greetingTarget, renderGreeting,
  type GreetingFacts, type GreetingPolicy,
} from '../src/greeting.ts';
import { type GreetingSlot } from '../src/settings.ts';

const DAY = '2026-11-25';
const NOW = Date.UTC(2026, 10, 25, 1, 0, 0); // 本地 09:00

const slot = (time: string, jitter = 20): GreetingSlot => ({ time, jitter });
const policy = (slots: GreetingSlot[]): GreetingPolicy => ({ slots });
const facts = (minuteOfDay: number, over: Partial<GreetingFacts> = {}): GreetingFacts => ({
  now: NOW, minuteOfDay, day: DAY, sentToday: [false, false], ...over,
});

test('greetingEnabled：时刻留空不启用，写坏不启用，0 点合法', () => {
  assert.equal(greetingEnabled(slot('7:30')), true);
  assert.equal(greetingEnabled(slot('0')), true);
  assert.equal(greetingEnabled(slot('')), false);
  assert.equal(greetingEnabled(slot('junk')), false);
});

test('greetingTarget：落在点±幅度内、当天稳定、隔天换', () => {
  const target = greetingTarget(DAY, 0, slot('7:30', 20));
  assert.ok(target >= 7 * 60 + 10 && target <= 7 * 60 + 50, `应落在 7:10–7:50，实际 ${target}`);
  assert.equal(greetingTarget(DAY, 0, slot('7:30', 20)), target, '同一天稳定');
  assert.notEqual(greetingTarget('2026-11-26', 0, slot('7:30', 20)), target, '隔天换点');
});

test('greetingTarget：跨零点也落在 0–1439', () => {
  const target = greetingTarget(DAY, 1, slot('0:10', 20));
  assert.ok(target >= 0 && target < 1440);
  assert.ok(target >= 23 * 60 + 50 || target <= 30, '落在 23:50–00:30');
});

test('decideGreeting：时刻留空 / 开关没填 → 不推并说清楚', () => {
  const d = decideGreeting(facts(7 * 60 + 30), policy([slot(''), slot('')]));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /没填问候时刻/);
});

test('decideGreeting：目标没到 → 不推，报约在几点', () => {
  const target = greetingTarget(DAY, 0, slot('7:30', 20));
  assert.ok(target > 7 * 60, '这一天早点的抖动点晚于 7:00，否则下面断言没意义');
  const d = decideGreeting(facts(7 * 60), policy([slot('7:30', 20), slot('')]));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /还有 \d+ 分钟/);
});

test('decideGreeting：目标到了 → 推，带早安/晚安标签', () => {
  const target = greetingTarget(DAY, 0, slot('7:30', 20));
  const d = decideGreeting(facts(target), policy([slot('7:30', 20), slot('22:30', 20)]));
  assert.deepEqual(d, { fire: true, slot: 0, label: '早安' });

  const e = greetingTarget(DAY, 1, slot('22:30', 20));
  const d2 = decideGreeting(facts(e, { sentToday: [true, false] }),
    policy([slot('7:30', 20), slot('22:30', 20)]));
  assert.deepEqual(d2, { fire: true, slot: 1, label: '晚安' });
});

test('decideGreeting：今天发过了就不重发', () => {
  const d = decideGreeting(facts(7 * 60 + 30, { sentToday: [true, true] }),
    policy([slot('7:30', 20), slot('22:30', 20)]));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /都发过了/);
});

test('decideGreeting：窗口过了很久不补（不会半夜补一条晚安）', () => {
  // 晚安 22:30 ±20，窗口 22:10–22:50，过了 60 分钟以上（23:55）就不补
  const d = decideGreeting(facts(23 * 60 + 55), policy([slot(''), slot('22:30', 20)]));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /窗口已过/);
});

test('decideGreeting：按行认早晚安——17 点早安 / 3 点晚安 也各发各的', () => {
  const slots = [slot('17', 0), slot('3', 0)];
  assert.deepEqual(decideGreeting(facts(17 * 60), policy(slots)), { fire: true, slot: 0, label: '早安' });
  assert.deepEqual(decideGreeting(facts(3 * 60), policy(slots)), { fire: true, slot: 1, label: '晚安' });
});

test('decideGreeting：早安没发过也不挡晚安（到点照样推晚安）', () => {
  const slots = [slot('7:30', 20), slot('22:30', 20)];
  const target = greetingTarget(DAY, 1, slots[1]!);
  const d = decideGreeting(facts(target), policy(slots));
  assert.deepEqual(d, { fire: true, slot: 1, label: '晚安' });
});

test('decideGreeting：早安错过之后，晚上报的是晚安的时间，不是「早安还有 545 分钟」', () => {
  const d = decideGreeting(facts(21 * 60), policy([slot('7:30', 20), slot('22:30', 20)]));
  assert.equal(d.fire, false);
  const note = d.fire === false ? d.note : '';
  assert.match(note, /晚安/);
  assert.doesNotMatch(note, /早安/);
  assert.doesNotMatch(note, /还有 \d{3,} 分钟/, '别把今天的早安说成还有几百分钟');
});

test('decideGreeting：19:36 之后早早过去的早安算错过，不报「还有 N 分钟」', () => {
  const d = decideGreeting(facts(19 * 60 + 36), policy([slot('7:30', 20), slot('')]));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /窗口已过/);
});

test('decideGreeting：跨日那一拍不会把晚间目标当成「刚过去」（23:12 推过，00:00 不再推）', () => {
  const slots = [slot('', 20), slot('23:30', 20)];
  const target = greetingTarget('2026-11-25', 1, slots[1]!); // 23:10–23:50
  const first = decideGreeting(facts(target, { day: '2026-11-25' }), policy(slots));
  assert.deepEqual(first, { fire: true, slot: 1, label: '晚安' });

  // 跨到第二天 00:00：world 每天把 sentToday 清零，目标按新日期重算
  const after = decideGreeting(facts(0, { day: '2026-11-26' }), policy(slots));
  assert.equal(after.fire, false, '新一天的那条该在今晚 23 点，不是 00:00');
  assert.match(after.fire === false ? after.note : '', /晚安/);
});

test('decideGreeting：只开了一条时，文案说「今天的晚安已经发过了」', () => {
  const d = decideGreeting(facts(23 * 60 + 40, { sentToday: [false, true] }),
    policy([slot('', 20), slot('23:30', 20)]));
  assert.equal(d.fire, false);
  assert.match(d.fire === false ? d.note : '', /今天的晚安已经发过了/);
});

test('renderGreeting：固定由头替换 {time} / {who}，不替她写话、不绑定通道', () => {
  const text = renderGreeting('22:10', '晚安');
  assert.equal(text, GREETING_HINT.replaceAll('{time}', '22:10').replaceAll('{who}', '晚安'));
  assert.match(text, /22:10/);
  assert.match(text, /晚安/);
  assert.doesNotMatch(text, /\{time\}|\{who\}/);
  assert.match(GREETING_HINT, /别回这条/);
  assert.match(GREETING_HINT, /用你自己的话/);
  assert.doesNotMatch(GREETING_HINT, /常驻/);
});
