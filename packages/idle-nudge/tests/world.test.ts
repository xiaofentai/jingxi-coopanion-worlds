/**
 * World 层的集成测试：两套判据真的互不干扰、纸条优先。
 * 用注入的 clock / usageMtime / push，不碰磁盘上的真配置（settings 从临时目录读）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdleNudgeWorld } from '../src/world.ts';

const MIN = 60_000;

async function harness(opts: {
  now: number;
  usageMtime: number | null;
  slots?: Array<{ from: string; to: string; perDay: number }>;
  lastNoteAt?: number | null;
  gapMinutes?: number;
  heartbeatEnabled?: boolean;
  noteEnabled?: boolean;
} = {} as any) {
  const dir = mkdtempSync(join(tmpdir(), 'idle-nudge-world-'));
  const settings = {
    heartbeatEnabled: opts.heartbeatEnabled ?? true,
    noteEnabled: opts.noteEnabled ?? true,
    idleMinutes: 40,
    tickSeconds: 15,
    maxPerDay: 48,
    heartbeatText: '',
    slots: opts.slots ?? [
      { from: '9', to: '12', perDay: 1 },
      { from: '14', to: '18', perDay: 1 },
      { from: '19', to: '22', perDay: 1 },
    ],
    noteGapMinutes: opts.gapMinutes ?? 120,
    noteText: '',
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    worlds: { 'idle-nudge': { enabled: true, settings } },
  }), 'utf8');

  const pushed: Array<{ type: string; text: string }> = [];
  let lastNoteAt = opts.lastNoteAt ?? null;
  const world = new IdleNudgeWorld({
    cfg: { enabled: true },
    timezone: 'Asia/Shanghai',
    botDir: dir,
    dataDir: dir,
    clock: () => opts.now,
    usageMtime: () => opts.usageMtime ?? null,
    push: async (type, text) => { pushed.push({ type, text }); if (type.endsWith('.note')) lastNoteAt = opts.now; return true; },
  });
  // tick() 要求先挂到宿主上；给一个最小的假 host（push 被注入了，不会真用它）。
  // start() 起的定时器已 unref，不会阻塞测试退出；这里只手动驱动 tick。
  await world.start({} as never);
  // 注入"上一张纸条"的时刻到 world 内部状态（tick 读的是这个，不是 harness 的局部变量）。
  if (opts.lastNoteAt != null) {
    (world as unknown as { lastNoteAt: number }).lastNoteAt = opts.lastNoteAt;
  }
  return { world, pushed, dir, getLastNoteAt: () => lastNoteAt };
}

// 2026-11-16 11:59 +08 = 03:59 UTC，第一段 9-12 的末尾（当天抖动点已过）
const MORNING = Date.UTC(2026, 10, 16, 3, 59, 0);
// 17:59 +08，第二段 14-18 的末尾
const AFTERNOON = Date.UTC(2026, 10, 16, 9, 59, 0);
// 13:00 +08，不在任何段
const OUTSIDE = Date.UTC(2026, 10, 16, 5, 0, 0);

async function tickTwice(world: IdleNudgeWorld) {
  // tick() 是 private；用类型断言从外部驱动一拍（测试专用，和宿主调 start 后定时器走同一条路）
  await (world as unknown as { tick(): Promise<void> }).tick();
}

test('纸条和心跳同一拍都满足时，只推纸条，并把心跳计时记成现在', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN });
  await tickTwice(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.note');
  const st = h.world.status();
  assert.equal(st.beatToday, 0, '纸条那一拍不算心跳');
  assert.equal(st.noteToday.reduce((a, b) => a + b, 0), 1);
  assert.equal(st.lastBeatAt, MORNING, '缓存已续，别再补心跳');
});

test('不在纸条时段时走心跳，纸条状态不动', async () => {
  const h = await harness({ now: OUTSIDE, usageMtime: OUTSIDE - 41 * MIN });
  await tickTwice(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.beat');
  const st = h.world.status();
  assert.equal(st.beatToday, 1);
  assert.equal(st.lastNoteAt, null, '心跳那一拍不碰纸条的钟');
});

test('纸条间隔跨段：上午推过，下午仍推不了（mtime 多新都没用）', async () => {
  const h = await harness({
    now: AFTERNOON,
    usageMtime: AFTERNOON - 999 * MIN, // 心跳的条件完全满足
    lastNoteAt: MORNING,                // 但纸条刚推过 5 小时
    gapMinutes: 480,                    // 要求隔 8 小时
  });
  await tickTwice(h.world);
  assert.equal(h.pushed.length, 1, '只有心跳推了');
  assert.equal(h.pushed[0]!.type, 'idle-nudge.beat');
  assert.match(h.world.status().noteNote, /距上一张纸条还差/);
});

test('关掉插件总开关：两套都不推', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN });
  (h.world as unknown as { cfg: { enabled: boolean } }).cfg.enabled = false;
  await tickTwice(h.world);
  assert.equal(h.pushed.length, 0);
});

test('关掉小纸条：心跳照常推', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN, noteEnabled: false });
  await tickTwice(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.beat');
});

test('关掉静默心跳：纸条照常推', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN, heartbeatEnabled: false });
  await tickTwice(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.note');
});

test('纸条正文带身份标记（默认句防止她当成 ta 的搭话）', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN });
  await tickTwice(h.world);
  assert.match(h.pushed[0]!.text, /不是 ta 说的/);
  assert.match(h.pushed[0]!.text, /别回这条/);
  assert.match(h.pushed[0]!.text, /11:59/, '{time} 换成本地时刻');
});
