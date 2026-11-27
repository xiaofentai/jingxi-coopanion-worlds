/**
 * 设置读写测试：写进 config.json 自己的段，别的一个字不动；模板留空是明确选择。
 * 用临时目录，不碰真机配置。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_NOTE_TEXT, clampSettings, parseSlotPair, slotRangeText,
  readSettings, seedSettings, writeSettings, type NudgeSettings,
} from '../src/settings.ts';
import { checkIncoming } from '../src/validate.ts';

function sandbox(initial: unknown = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'idle-nudge-test-'));
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  return dir;
}

test('seedSettings：心跳与问候默认关、纸条默认开', () => {
  const s = seedSettings();
  assert.equal(s.heartbeatEnabled, false);
  assert.equal(s.noteEnabled, true);
  assert.equal(s.greetingEnabled, false);
  assert.deepEqual(s.greetings, [{ time: '', jitter: 20 }, { time: '', jitter: 20 }]);
  assert.equal(s.idleMinutes, 40);
  assert.equal(s.tickSeconds, 15);
  assert.equal(s.maxPerDay, 48);
  assert.equal(s.noteGapMinutes, 120);
  assert.equal(s.slots.length, 3);
  assert.deepEqual(s.slots.map((x) => [x.from, x.to, x.perDay]), [['9', '12', 1], ['14', '18', 1], ['19', '22', 1]]);
  assert.equal(s.heartbeatText, '');
  assert.equal(s.noteText, '');
});

test('clampSettings：模板留空保留为空（用户明确要回默认），不是回退到旧值', () => {
  const fallback = seedSettings();
  const old = { ...fallback, noteText: '旧文案' };
  const next = clampSettings({ noteText: '' }, old);
  assert.equal(next.noteText, '');
  const heartbeat = clampSettings({ heartbeatText: '' }, old);
  assert.equal(heartbeat.heartbeatText, '');
});

test('clampSettings：时段置空 / 写坏 / perDay 夹逼', () => {
  const s = clampSettings({
    slots: [
      { from: '', to: '12', perDay: 1 },
      { from: '9:99', to: 'junk', perDay: 3 },
      { from: '22', to: '2', perDay: 99 },
    ],
  }, seedSettings());
  assert.equal(s.slots[0]!.from, '', '留空就是留空，不补默认值');
  assert.equal(s.slots[1]!.from, '14', '写坏的回退到这一段自己的默认值');
  assert.equal(s.slots[1]!.to, '18');
  assert.equal(s.slots[2]!.perDay, 24);
});

test('时段两个框：range 拆 from/to，留空禁用，写坏退回原值', () => {
  const s = seedSettings();
  assert.equal(slotRangeText(s.slots[0]!), '9-12');
  assert.equal(slotRangeText({ from: '', to: '', perDay: 0 }), '');

  assert.deepEqual(parseSlotPair({ range: '14:30-18', perDay: 2 }, s.slots[0]!), { from: '14:30', to: '18', perDay: 2 });
  assert.deepEqual(parseSlotPair({ range: '', perDay: 0 }, s.slots[0]!), { from: '', to: '', perDay: 0 });
  assert.deepEqual(parseSlotPair({ range: 'junk', perDay: 1 }, s.slots[0]!), s.slots[0], '写坏保留原值');
  assert.deepEqual(parseSlotPair({ range: '22-2', perDay: 1 }, s.slots[0]!), { from: '22', to: '2', perDay: 1 }, '跨零点');
});

test('writeSettings：只改自己的段，enabled 和别人的段一个字不动', () => {
  const dir = sandbox({
    language: 'zh',
    worlds: {
      'idle-nudge': { enabled: true },
      'memory-ledger': { enabled: true, settings: { folder: 'workspace' } },
    },
  });
  const settings = { ...seedSettings(), noteGapMinutes: 90 };
  writeSettings(dir, settings);

  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, any>;
  assert.equal(raw.language, 'zh');
  assert.equal(raw.worlds['idle-nudge'].enabled, true, '开关不能丢');
  assert.deepEqual(raw.worlds['idle-nudge'].settings, settings);
  assert.deepEqual(raw.worlds['memory-ledger'], { enabled: true, settings: { folder: 'workspace' } });
});

test('readSettings：从 settings 段读回；没有段时用 seed；坏段也退回 seed', () => {
  const dir = sandbox({
    worlds: { 'idle-nudge': { enabled: true, settings: { noteGapMinutes: 77, slots: [{ from: '8', to: '10', perDay: 2 }] } } },
  });
  assert.equal(readSettings(dir).noteGapMinutes, 77);
  assert.equal(readSettings(dir).slots[0]!.from, '8');
  assert.equal(readSettings(dir).slots[1]!.from, '14', '没提交的段用默认补齐');

  const empty = sandbox({ worlds: {} });
  assert.deepEqual(readSettings(empty), seedSettings());

  const broken = sandbox({ worlds: { 'idle-nudge': { settings: 'not-an-object' } } });
  assert.deepEqual(readSettings(broken), seedSettings());
});

test('slotRangeText：半填的段原样显示（不让用户以为自己没填过）', () => {
  assert.equal(slotRangeText({ from: '9', to: '', perDay: 1 }), '9-');
  assert.equal(slotRangeText({ from: '', to: '12', perDay: 1 }), '-12');
  assert.equal(slotRangeText({ from: '', to: '', perDay: 1 }), '');
});

test('checkIncoming：不规范的值直接报错（不悄悄改成别的）', () => {
  const cur = seedSettings();
  assert.equal(checkIncoming({ tickSeconds: 15, slot0: { range: '9-12', perDay: 1 } }, cur), null);
  assert.match(checkIncoming({ tickSeconds: 1 }, cur) ?? '', /看表间隔要 5–300 秒/);
  assert.match(checkIncoming({ tickSeconds: 1.5 }, cur) ?? '', /要填整数/);
  assert.match(checkIncoming({ maxPerDay: 999 }, cur) ?? '', /每日上限要 0–240 拍/);
  assert.match(checkIncoming({ noteText: 'x'.repeat(501) }, cur) ?? '', /最多 500 字/);
  assert.match(checkIncoming({ slot0: { range: '9-25', perDay: 1 } }, cur) ?? '', /时段 1写坏了/);
  assert.match(checkIncoming({ slot1: { range: '9-', perDay: 1 } }, cur) ?? '', /时段 2只填了一半/);
  assert.match(checkIncoming({ slot2: { range: '9-9', perDay: 1 } }, cur) ?? '', /时段 3起止相同/);
  assert.match(checkIncoming({ slot0: { range: '9-12', perDay: 99 } }, cur) ?? '', /每天几张」要 0–24/);
  assert.match(checkIncoming({ greeting0: { range: '25:00', perDay: 20 } }, cur) ?? '', /早安时刻写坏了/);
  assert.match(checkIncoming({ greeting1: { range: '22:30', perDay: 999 } }, cur) ?? '', /抖动幅度」要 0–240/);
});

test('checkIncoming：留空＝不启用 / 没提交＝不改，都不算错', () => {
  const cur = seedSettings();
  assert.equal(checkIncoming({}, cur), null);
  assert.equal(checkIncoming({ slot0: { range: '', perDay: 0 } }, cur), null);
  assert.equal(checkIncoming({ slot0: { range: '-', perDay: 0 } }, cur), null, '只留一个减号当清空');
  assert.equal(checkIncoming({ greeting0: { range: '', perDay: 20 } }, cur), null);
});

test('writeSettings：config.json 坏了就拒绝写回，原文一个字不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-nudge-broken-'));
  const file = join(dir, 'config.json');
  const broken = '{ "worlds": { "memory-ledger": { "enabled": true, "settings": { "folder": "workspace" ';
  writeFileSync(file, broken, 'utf8');
  assert.throws(() => writeSettings(dir, seedSettings()), /没有保存：config\.json 解析失败/);
  assert.equal(readFileSync(file, 'utf8'), broken, '坏文件原样留着，等人工修');
  assert.equal(readdirSync(dir).length, 1, '不留临时文件 / 备份文件');
  rmSync(dir, { recursive: true, force: true });
});

test('writeSettings：顶层不是对象也拒绝（否则 JSON.stringify 会写成 []、丢别的键）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-nudge-broken-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, '[]', 'utf8');
  assert.throws(() => writeSettings(dir, seedSettings()), /顶层不是对象/);
  assert.equal(readFileSync(file, 'utf8'), '[]');
  rmSync(dir, { recursive: true, force: true });
});

test('writeSettings：config.json 不存在＝新装，照常建一份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-nudge-fresh-'));
  writeSettings(dir, { ...seedSettings(), noteGapMinutes: 42 });
  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, any>;
  assert.equal(raw.worlds['idle-nudge'].settings.noteGapMinutes, 42);
  rmSync(dir, { recursive: true, force: true });
});

test('writeSettings 落盘后 readSettings 读回同一份（往返）', () => {
  const dir = sandbox();
  const next: NudgeSettings = {
    ...seedSettings(),
    idleMinutes: 55,
    noteText: DEFAULT_NOTE_TEXT,
    slots: [{ from: '', to: '', perDay: 0 }, { from: '10', to: '11:30', perDay: 2 }, { from: '20', to: '22', perDay: 1 }],
  };
  writeSettings(dir, next);
  assert.deepEqual(readSettings(dir), next);
  rmSync(dir, { recursive: true, force: true });
});
