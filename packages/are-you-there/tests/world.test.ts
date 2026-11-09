import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARE_YOU_THERE_DEFAULTS } from '../src/config.ts';
import type { ForegroundInfo } from '../src/confirm.ts';
import type { IdleReading } from '../src/idle.ts';
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
}

function setup(opts: Setup = {}) {
  const lockedSequence = opts.locked ?? [false];
  const idleSequence = opts.idle ?? [];
  const dataDir = mkdtempSync(join(tmpdir(), 'ayt-smoke-'));
  roots.push(dataDir);
  let lockIndex = 0;
  let idleIndex = 0;
  let idleReading: IdleReading = { idleMs: 0, at: Date.now() };
  const world = new AreYouThereWorld({
    cfg: {
      ...ARE_YOU_THERE_DEFAULTS,
      enabled: true,
      pollSeconds: 5,
      idleMinutes: opts.idleMinutes ?? 10,
      checkLock: opts.checkLock ?? true,
      checkForeground: opts.checkForeground ?? true,
      checkScreen: opts.checkScreen ?? false,
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
  return { world, dataDir, pushed, host, tick };
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
});
