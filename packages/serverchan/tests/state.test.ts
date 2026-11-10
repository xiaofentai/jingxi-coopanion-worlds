import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bodyHash, dayKey, emptyState, readState, recordSend, todayCount, writeState } from '../src/state.ts';

const TIMEZONE = 'Asia/Shanghai';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sc-state-'));
}

test('dayKey 按时区算日子：UTC 的下午已经是东八区的第二天', () => {
  const at = Date.parse('2026-11-11T16:30:00Z');
  assert.equal(dayKey(TIMEZONE, at), '2026-11-12');
  assert.equal(dayKey('UTC', at), '2026-11-11');
});

test('时区写错就退回 UTC，不抛', () => {
  const at = Date.parse('2026-11-11T16:30:00Z');
  assert.equal(dayKey('Not/AZone', at), '2026-11-11');
});

test('只有成功的那次进计数', () => {
  let state = emptyState();
  const at = Date.parse('2026-11-11T10:00:00Z');

  state = recordSend(state, { at, ok: false, channel: 'turbo', title: '失败的', hash: 'h', error: '连不上' }, TIMEZONE);
  assert.equal(state.today, 0);
  assert.equal(state.total, 0);

  state = recordSend(state, { at, ok: true, channel: 'turbo', title: '成功的', hash: 'h', error: null }, TIMEZONE);
  assert.equal(state.today, 1);
  assert.equal(state.total, 1);
  assert.equal(state.last?.title, '成功的');
});

test('换了一天 today 归零，total 继续累', () => {
  const day1 = Date.parse('2026-11-11T02:00:00Z');
  const day2 = Date.parse('2026-11-12T02:00:00Z');
  let state = emptyState();
  state = recordSend(state, { at: day1, ok: true, channel: 'sc3', title: 'a', hash: 'h', error: null }, TIMEZONE);
  state = recordSend(state, { at: day1, ok: true, channel: 'sc3', title: 'b', hash: 'h', error: null }, TIMEZONE);
  assert.equal(todayCount(state, TIMEZONE, day1), 2);

  state = recordSend(state, { at: day2, ok: true, channel: 'sc3', title: 'c', hash: 'h', error: null }, TIMEZONE);
  assert.equal(todayCount(state, TIMEZONE, day2), 1);
  assert.equal(state.total, 3);
});

test('写下去再读回来是同一份记录', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'serverchan.json');
    assert.deepEqual(readState(file), emptyState());

    const at = Date.parse('2026-11-11T10:00:00Z');
    const saved = recordSend(emptyState(), { at, ok: true, channel: 'sc3', title: '标题', hash: 'abc', error: null }, TIMEZONE);
    writeState(file, saved);
    assert.deepEqual(readState(file), saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏掉的记录改名为 .bad，从空状态开始', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'serverchan.json');
    writeFileSync(file, '{ not json');
    assert.deepEqual(readState(file), emptyState());
    assert.ok(readState(file + '.bad'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bodyHash 稳定、定长，不同的正文不一样', () => {
  assert.equal(bodyHash('同样的正文'), bodyHash('同样的正文'));
  assert.equal(bodyHash('同样的正文').length, 16);
  assert.notEqual(bodyHash('甲'), bodyHash('乙'));
});
