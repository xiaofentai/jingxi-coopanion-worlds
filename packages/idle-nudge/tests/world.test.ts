/**
 * World 层的集成测试：两套判据真的互不干扰、纸条优先。
 * 用注入的 clock / usageMtime / push，不碰磁盘上的真配置（settings 从临时目录读）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  greetingEnabled?: boolean;
  greetings?: Array<{ time: string; jitter: number }>;
  /** 这些事件 type 的推送会失败，用来看降级链。 */
  failTypes?: string[];
  /** 假的宿主事件库：给 `range()` 一个固定返回值，用来验「今天推过没有」的跨重启判据。 */
  events?: Array<{ type: string; ts: string; senderKey?: string }>;
} = {} as any) {
  const dir = mkdtempSync(join(tmpdir(), 'idle-nudge-world-'));
  const settings = {
    heartbeatEnabled: opts.heartbeatEnabled ?? true,
    noteEnabled: opts.noteEnabled ?? true,
    greetingEnabled: opts.greetingEnabled ?? false,
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
    greetings: opts.greetings ?? [{ time: '', jitter: 20 }, { time: '', jitter: 20 }],
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    worlds: { 'idle-nudge': { enabled: true, settings } },
  }), 'utf8');

  const pushed: Array<{ type: string; text: string; key?: string }> = [];
  const fail = new Set(opts.failTypes ?? []);
  const world = new IdleNudgeWorld({
    cfg: { enabled: true },
    timezone: 'Asia/Shanghai',
    botDir: dir,
    dataDir: dir,
    clock: () => opts.now,
    usageMtime: () => opts.usageMtime ?? null,
    push: async (type, text, key) => {
      if (fail.has(type)) return false;
      pushed.push({ type, text, key });
      return true;
    },
  });
  // tick() 要求先挂到宿主上；给一个最小的假 host（push 被注入了，不会真用它）。
  // 传 events 时它自带一个只剩 range() 的事件库，模拟「重启后还能查到今天推过什么」。
  // start() 起的定时器已 unref，不会阻塞测试退出；这里只手动驱动 tick。
  let storeCalls = 0;
  const store = opts.events
    ? { range: () => { storeCalls += 1; return opts.events; } }
    : undefined;
  await world.start({ store } as never);
  // 注入"上一张纸条"的时刻到 world 内部状态（tick 读的是这个，不是 harness 的局部变量）。
  if (opts.lastNoteAt != null) {
    (world as unknown as { lastNoteAt: number }).lastNoteAt = opts.lastNoteAt;
  }
  return { world, pushed, dir, storeCalls: () => storeCalls };
}

// 2026-11-16 11:59 +08 = 03:59 UTC，第一段 9-12 的末尾（当天抖动点已过）
const MORNING = Date.UTC(2026, 10, 16, 3, 59, 0);
// 17:59 +08，第二段 14-18 的末尾
const AFTERNOON = Date.UTC(2026, 10, 16, 9, 59, 0);
// 13:00 +08，不在任何段
const OUTSIDE = Date.UTC(2026, 10, 16, 5, 0, 0);

async function tickOnce(world: IdleNudgeWorld) {
  // tick() 是 private；用类型断言从外部驱动一拍（测试专用，和宿主调 start 后定时器走同一条路）
  await (world as unknown as { tick(): Promise<void> }).tick();
}

test('纸条和心跳同一拍都满足时，只推纸条，并把心跳计时记成现在', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.note');
  const st = h.world.status();
  assert.equal(st.beatToday, 0, '纸条那一拍不算心跳');
  assert.equal(st.noteToday.reduce((a, b) => a + b, 0), 1);
  assert.equal(st.lastBeatAt, MORNING, '缓存已续，别再补心跳');
});

test('不在纸条时段时走心跳，纸条状态不动', async () => {
  const h = await harness({ now: OUTSIDE, usageMtime: OUTSIDE - 41 * MIN });
  await tickOnce(h.world);
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
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 1, '只有心跳推了');
  assert.equal(h.pushed[0]!.type, 'idle-nudge.beat');
  assert.match(h.world.status().noteNote, /距上一张纸条还差/);
});

test('关掉插件总开关：两套都不推', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN });
  (h.world as unknown as { cfg: { enabled: boolean } }).cfg.enabled = false;
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 0);
});

test('关掉小纸条：心跳照常推', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN, noteEnabled: false });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.beat');
});

test('关掉静默心跳：纸条照常推', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN, heartbeatEnabled: false });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.note');
});

test('问候优先于纸条和心跳：到点只推问候，把心跳计时记成现在', async () => {
  const h = await harness({
    now: MORNING,
    usageMtime: MORNING - 41 * MIN,
    greetingEnabled: true,
    // 幅度 0：目标就是 11:59，正好落在纸条窗口末尾（MORNING）
    greetings: [{ time: '11:59', jitter: 0 }, { time: '', jitter: 20 }],
  });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.greeting');
  assert.match(h.pushed[0]!.text, /早安/);
  const st = h.world.status();
  assert.equal(st.greetingToday[0], true);
  assert.equal(st.noteToday.reduce((a, b) => a + b, 0), 0, '同一拍不再推纸条');
  assert.equal(st.lastBeatAt, MORNING, '问候那一拍也续了缓存');
});

test('问候关掉时不影响纸条和心跳', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN, greetingEnabled: false });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.note');
});

test('问候正文走 {who} / {time} 占位符', async () => {
  const h = await harness({
    now: MORNING,
    usageMtime: MORNING - 41 * MIN,
    greetingEnabled: true,
    greetings: [{ time: '11:59', jitter: 0 }, { time: '', jitter: 20 }],
  });
  // 用自定义模板再建一个 harness 不方便，这里断言默认句已替换两个占位符
  await tickOnce(h.world);
  assert.match(h.pushed[0]!.text, /11:59/);
  assert.doesNotMatch(h.pushed[0]!.text, /\{time\}/);
  assert.doesNotMatch(h.pushed[0]!.text, /\{who\}/);
});

test('纸条正文带身份标记（防止她当成 ta 的搭话后用气泡回复）', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN });
  await tickOnce(h.world);
  assert.match(h.pushed[0]!.text, /不是 ta 说的/);
  assert.match(h.pushed[0]!.text, /不用回这条/);
  assert.match(h.pushed[0]!.text, /11:59/, '{time} 换成本地时刻');
});

test('纸条推不出去时降级到心跳，不让一个失败的判据把缓存饿死', async () => {
  const h = await harness({
    now: MORNING,
    usageMtime: MORNING - 41 * MIN,
    failTypes: ['idle-nudge.note'],
  });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.beat', '纸条失败了，心跳照样补上');
  assert.match(h.world.status().noteNote, /推送失败/);
});

test('问候推不出去时降到纸条，纸条也失败再退到心跳', async () => {
  const h = await harness({
    now: MORNING,
    usageMtime: MORNING - 41 * MIN,
    greetingEnabled: true,
    greetings: [{ time: '11:59', jitter: 0 }, { time: '', jitter: 20 }],
    failTypes: ['idle-nudge.greeting', 'idle-nudge.note'],
  });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.beat');
  assert.match(h.world.status().greetingNote, /推送失败/);
  assert.match(h.world.status().noteNote, /推送失败/);
});

test('设置页提交不规范的值：报错、整份不落盘；规范的值照常存', async () => {
  const h = await harness({ now: MORNING, usageMtime: null });
  const file = join(h.dir, 'config.json');
  const before = readFileSync(file, 'utf8');
  const invoke = h.world.webUi().invoke!;

  await assert.rejects(
    async () => { await invoke('settings', 'save', [{ slot0: { range: '9-25', perDay: 1 } }]); },
    /没有保存：时段 1写坏了/,
  );
  assert.equal(readFileSync(file, 'utf8'), before, '写坏了就一个字都不写');

  await invoke('settings', 'save', [{ slot0: { range: '8-10', perDay: 2 } }]);
  const after = readFileSync(file, 'utf8');
  assert.match(after, /"from": "8"/);
  assert.match(after, /"to": "10"/);
});

test('config.json 坏了：保存报错、文件原样不动（不拿空对象重建）', async () => {
  const h = await harness({ now: MORNING, usageMtime: null });
  const file = join(h.dir, 'config.json');
  const broken = '{ "worlds": { "starpost": { "enabled": true, "tokenSecret": "x" ';
  writeFileSync(file, broken, 'utf8');
  await assert.rejects(
    async () => { await h.world.webUi().invoke!('settings', 'save', [{ tickSeconds: 20 }]); },
    /没有保存：config\.json 解析失败/,
  );
  assert.equal(readFileSync(file, 'utf8'), broken, '别的 world 的段一个字都没动');
});

test('重启后不重复递纸条：事件库里今天已有这一段的记录', async () => {
  const h = await harness({
    now: MORNING,
    usageMtime: MORNING - 41 * MIN,
    heartbeatEnabled: false,
    // 11:49 推过一张 note:0（本地日 2026-11-16）；重启后内存清零，但库里查得到
    events: [{ type: 'idle-nudge.note', ts: new Date(MORNING - 10 * MIN).toISOString(), senderKey: 'note:0' }],
  });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 0, '这一段今天的名额已经用掉了');
  assert.match(h.world.status().noteNote, /名额今天用完/);
});

test('晚开机但今天还没推过：照常推，不再因为「抖动点早过了」白丢一天', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN, events: [] });
  await tickOnce(h.world);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.note');
  assert.equal(h.pushed[0]!.key, 'note:0', '落库用的 senderKey 要带上段号，回头才能查');
});

test('没到点就不查事件库：三套判据都不推的那一拍，一次都不该查', async () => {
  // 13:00 不在任何纸条时段；距上次调用 5 分钟（没到 40）；问候关着
  const h = await harness({ now: OUTSIDE, usageMtime: OUTSIDE - 5 * MIN, events: [] });
  await tickOnce(h.world);
  assert.equal(h.pushed.length, 0);
  assert.equal(h.storeCalls(), 0, '只在「要推」时才查库');
});

test('要推时只查一次事件库（查完写回内存，不会每拍重查）', async () => {
  const h = await harness({ now: MORNING, usageMtime: MORNING - 41 * MIN, events: [] });
  await tickOnce(h.world);
  assert.equal(h.pushed[0]!.type, 'idle-nudge.note');
  assert.equal(h.storeCalls(), 1);
  await tickOnce(h.world); // 第二拍：内存里已有今天的记录，不该再查
  assert.equal(h.storeCalls(), 1);
});

test('问候：事件库里今天已有这条，就不再发（重启也不重发）', async () => {
  const h = await harness({
    now: MORNING,
    usageMtime: MORNING - 41 * MIN,
    greetingEnabled: true,
    greetings: [{ time: '11:59', jitter: 0 }, { time: '', jitter: 20 }],
    events: [{ type: 'idle-nudge.greeting', ts: new Date(MORNING).toISOString(), senderKey: 'greeting:0' }],
  });
  await tickOnce(h.world);
  assert.equal(h.pushed.some((x) => x.type === 'idle-nudge.greeting'), false);
  assert.match(h.world.status().greetingNote, /已经发过了/);
});
