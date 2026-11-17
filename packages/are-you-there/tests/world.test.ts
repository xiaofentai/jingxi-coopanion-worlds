import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARE_YOU_THERE_DEFAULTS } from '../src/config.ts';
import type { ForegroundInfo } from '../src/confirm.ts';
import type { IdleReading } from '../src/idle.ts';
import { emptyRadarReading, type RadarReading } from '../src/radar.ts';
import { AreYouThereWorld } from '../src/world.ts';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** start() 里的第一次探针没有 await，等它跑完再断言。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

interface Setup {
  locked?: boolean[];
  /** 每次读到空闲值时按顺序往前取；不传就是一直有输入。 */
  idle?: number[];
  idleMinutes?: number;
  checkLock?: boolean;
  checkForeground?: boolean;
  checkScreen?: boolean;
  foreground?: ForegroundInfo | null;
  screen?: number | null;
  /** 给了就打开雷达，用这份读数冒充硬件。 */
  radar?: { absentMs?: number; presentMs?: number; streakMs?: number };
  radarQuietSeconds?: number;
  radarBackSeconds?: number;
}

/** 一份「刚刚」的雷达读数：`absentMs` 之前见过人、当前这一帧在 79 厘米处。 */
function radarReading(opts: { absentMs?: number; presentMs?: number; streakMs?: number }): RadarReading {
  const now = Date.now();
  return {
    ...emptyRadarReading(),
    linked: true,
    port: 'COM5',
    at: now,
    connectedAt: now - 60_000,
    cm: 79,
    sawNear: true,
    lastPresentAt: now - (opts.absentMs ?? 0),
    presentSince: opts.presentMs === undefined ? null : now - opts.presentMs,
    ...(opts.streakMs === undefined ? {} : { streakMs: opts.streakMs, streakEndedAt: now - 500 }),
  };
}

function setup(opts: Setup = {}) {
  const lockedSequence = opts.locked ?? [false];
  const idleSequence = opts.idle ?? [];
  const dataDir = mkdtempSync(join(tmpdir(), 'ayt-smoke-'));
  roots.push(dataDir);
  let lockIndex = 0;
  let idleIndex = 0;
  let idleReading: IdleReading = { idleMs: 0, at: Date.now() };
  const radar = opts.radar === undefined ? null : radarReading(opts.radar);
  /** 换一份雷达读数，用来模拟「刚才还在、现在走了」。 */
  const setRadar = (next: { absentMs?: number; presentMs?: number; streakMs?: number }) => {
    radarState.current = radarReading(next);
  };
  const radarState: { current: RadarReading | null } = { current: radar };
  const world = new AreYouThereWorld({
    cfg: {
      ...ARE_YOU_THERE_DEFAULTS,
      enabled: true,
      pollSeconds: 5,
      idleMinutes: opts.idleMinutes ?? 10,
      checkLock: opts.checkLock ?? true,
      checkForeground: opts.checkForeground ?? true,
      checkScreen: opts.checkScreen ?? false,
      radarEnabled: radar !== null,
      ...(opts.radarQuietSeconds === undefined ? {} : { radarQuietSeconds: opts.radarQuietSeconds }),
      ...(opts.radarBackSeconds === undefined ? {} : { radarBackSeconds: opts.radarBackSeconds }),
    },
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
    dataDir,
    runner: async () => {
      const locked = lockedSequence[Math.min(lockIndex, lockedSequence.length - 1)]!;
      lockIndex += 1;
      return locked ? '"LogonUI.exe","1","Console","1","9 K"' : 'INFO: No tasks are running which match the specified criteria.';
    },
    idle: {
      latest: () => {
        const ms = idleSequence.length ? idleSequence[Math.min(idleIndex, idleSequence.length - 1)]! : 0;
        idleIndex += 1;
        idleReading = { idleMs: ms, at: Date.now() };
        return idleReading;
      },
    },
    radar: radar === null ? undefined : { latest: () => radarState.current },
    confirm: {
      foreground: async () => (opts.foreground === undefined ? null : opts.foreground),
      screen: async () => (opts.screen === undefined ? null : opts.screen),
    },
  });
  const pushed: Array<{ type: string; render: () => string | null }> = [];
  const host = {
    pushDeferred: (event: { type: string; render: () => string | null }) => {
      pushed.push(event);
    },
  };
  const tick = () => (world as unknown as { tick: () => Promise<void> }).tick();
  return { world, dataDir, pushed, host, tick, setRadar };
}

describe('world', () => {
  it('walks unlocked -> locked -> unlocked and narrates each change', async () => {
    const { world, dataDir, pushed, host, tick } = setup({ locked: [false, false, true, true, false, false] });
    await world.start(host as never);
    await settle();
    for (let i = 0; i < 5; i += 1) await tick();

    expect(pushed.map((event) => event.type)).toEqual(['are-you-there.changed', 'are-you-there.changed']);
    expect(pushed[0]!.render()).toContain('锁上了');
    expect(pushed[1]!.render()).toContain('ta 回来了');

    const state = JSON.parse(readFileSync(join(dataDir, 'are-you-there.json'), 'utf8'));
    expect(state.away).toBe(false);
    expect(state.lastAway.to).toBeGreaterThan(state.lastAway.from);

    const vars = world.envPromptVars();
    expect(vars['here.state']).toContain('在桌前');
    expect(vars['here.lastAway']).toContain('→');
    await world.stop();
  });

  it('does not look at the lock at all when checkLock is off', async () => {
    const { world, host, tick } = setup({ locked: [true, true], checkLock: false });
    await world.start(host as never);
    await settle();
    await tick();
    expect(world.envPromptVars()['here.state']).toContain('在桌前');
    await world.stop();
  });

  it('counts a long idle stretch as away when nothing says otherwise', async () => {
    const { world, pushed, host, tick } = setup({
      idle: [0, 0, 11 * 60_000, 11 * 60_000],
      foreground: null,
      checkScreen: true,
      screen: 0.4,
    });
    await world.start(host as never);
    await settle();
    pushed.length = 0;
    for (let i = 0; i < 3; i += 1) await tick();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.render()).toContain('没有动静');
    expect(pushed[0]!.render()).toContain('屏幕也没在变');
    expect(world.envPromptVars()['here.state']).toContain('键盘鼠标久无输入');
    await world.stop();
  });

  it('stays present when the foreground window looks like a video', async () => {
    const { world, pushed, host, tick } = setup({
      idle: [0, 0, 11 * 60_000, 11 * 60_000],
      foreground: { process: 'chrome', title: '哔哩哔哩 (゜-゜)つロ 干杯~' },
    });
    await world.start(host as never);
    await settle();
    pushed.length = 0;
    for (let i = 0; i < 3; i += 1) await tick();

    expect(pushed).toHaveLength(0);
    expect(world.envPromptVars()['here.state']).toContain('在桌前');
    await world.stop();
  });

  it('stays present when the screen is changing', async () => {
    const { world, pushed, host, tick } = setup({
      idle: [0, 0, 11 * 60_000, 11 * 60_000],
      foreground: { process: 'chrome', title: '某个页面' },
      checkScreen: true,
      screen: 12.5,
    });
    await world.start(host as never);
    await settle();
    pushed.length = 0;
    for (let i = 0; i < 3; i += 1) await tick();

    expect(pushed).toHaveLength(0);
    expect(world.envPromptVars()['here.state']).toContain('在桌前');
    await world.stop();
  });

  it('ignores a single reading', async () => {
    const { world, pushed, host, tick } = setup({ locked: [false, false, true] });
    await world.start(host as never);
    await settle();
    pushed.length = 0;
    await tick();
    expect(pushed).toHaveLength(0);
    expect(world.envPromptVars()['here.state']).toContain('在桌前');
    await world.stop();
  });

  it('answers the read tool with the record, the idle time, the verdict and a live probe', async () => {
    const { world, host } = setup({ locked: [false, false] });
    await world.start(host as never);
    await settle();
    const text = (await world.tools()[0]!.handler({}, {} as never)) as string;
    expect(text).toContain('现在');
    expect(text).toContain('空闲');
    expect(text).toContain('判定');
    expect(text).toContain('刚刚复查');
    await world.stop();
  });

  it('says the idle signal is off when the threshold is 0', async () => {
    const { world, host } = setup({ idleMinutes: 0 });
    await world.start(host as never);
    await settle();
    const text = (await world.tools()[0]!.handler({}, {} as never)) as string;
    expect(text).toContain('不看空闲');
    await world.stop();
  });

  it('calls it away as soon as the radar stops seeing anyone', async () => {
    // 键鼠刚动过：键鼠那一路还没到阈值，只有雷达能在这个时刻给出结论
    const { world, pushed, host, tick, setRadar } = setup({ radar: { presentMs: 60_000 }, radarQuietSeconds: 0 });
    await world.start(host as never);
    await settle();
    pushed.length = 0;
    setRadar({ absentMs: 9_000 });
    await tick();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.render()).toContain('雷达已经');
    expect(pushed[0]!.render()).toContain('79 厘米');
    expect(world.envPromptVars()['here.state']).toContain('雷达没测到人');
    await world.stop();
  });

  it('does not believe a radar absence while the keyboard is still warm', async () => {
    // 坐着敲字、雷达漏检：键鼠刚动过，不能判离开
    const { world, pushed, host, tick, setRadar } = setup({
      radar: { presentMs: 60_000 },
      idle: [2_000],
      radarQuietSeconds: 60,
    });
    await world.start(host as never);
    await settle();
    pushed.length = 0;
    setRadar({ absentMs: 9_000 });
    await tick();

    expect(pushed).toHaveLength(0);
    expect(world.envPromptVars()['here.state']).toContain('在桌前');
    await world.stop();
  });

  it('narrates a brief sighting as a pass-by instead of a return', async () => {
    const { world, pushed, host, tick, setRadar } = setup({
      radar: { presentMs: 60_000 },
      radarQuietSeconds: 0,
      radarBackSeconds: 10,
    });
    await world.start(host as never);
    await settle();
    setRadar({ absentMs: 9_000 });
    await tick();
    pushed.length = 0;

    // 有人从桌边走过：出现 3 秒又没了
    setRadar({ absentMs: 300, streakMs: 3_000 });
    await tick();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.render()).toContain('有人经过');
    expect(world.envPromptVars()['here.state']).toContain('雷达没测到人');
    await world.stop();
  });

  it('lets the radar veto a long idle stretch', async () => {
    const { world, pushed, host, tick } = setup({
      idle: [11 * 60_000, 11 * 60_000, 11 * 60_000],
      radar: { presentMs: 50_000 },
    });
    await world.start(host as never);
    await settle();
    pushed.length = 0;
    for (let i = 0; i < 3; i += 1) await tick();

    expect(pushed).toHaveLength(0);
    const state = world.envPromptVars()['here.state'];
    expect(state).toContain('在桌前');
    expect(state).toContain('79 厘米');
    await world.stop();
  });

  it('reports the radar state in the read tool', async () => {
    const { world, host } = setup({ radar: { absentMs: 9_000 } });
    await world.start(host as never);
    await settle();
    const text = (await world.tools()[0]!.handler({}, {} as never)) as string;
    expect(text).toContain('雷达：');
    expect(text).toContain('没测到人');
    await world.stop();
  });
});
