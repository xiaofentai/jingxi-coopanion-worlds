import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARE_YOU_THERE_DEFAULTS } from '../src/config.ts';
import { AreYouThereWorld } from '../src/world.ts';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** start() 里的第一次探针没有 await，等它跑完再断言。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup(lockedSequence: boolean[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ayt-smoke-'));
  roots.push(dataDir);
  let index = 0;
  const world = new AreYouThereWorld({
    cfg: { ...ARE_YOU_THERE_DEFAULTS, enabled: true, pollSeconds: 5 },
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
    dataDir,
    runner: async () => {
      const locked = lockedSequence[Math.min(index, lockedSequence.length - 1)]!;
      index += 1;
      return locked ? '"LogonUI.exe","1","Console","1","9 K"' : 'INFO: No tasks are running which match the specified criteria.';
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
    const { world, dataDir, pushed, host, tick } = setup([false, false, true, true, false, false]);
    await world.start(host as never);
    await settle();
    for (let i = 0; i < 5; i += 1) await tick();

    expect(pushed.map((event) => event.type)).toEqual(['are-you-there.changed', 'are-you-there.changed']);
    expect(pushed[0]!.render()).toContain('锁上了');
    expect(pushed[1]!.render()).toContain('解锁了');

    const state = JSON.parse(readFileSync(join(dataDir, 'are-you-there.json'), 'utf8'));
    expect(state.locked).toBe(false);
    expect(state.lastAway.to).toBeGreaterThan(state.lastAway.from);

    const vars = world.envPromptVars();
    expect(vars['here.state']).toContain('在桌前');
    expect(vars['here.lastAway']).toContain('→');
    await world.stop();
  });

  it('ignores a single reading', async () => {
    const { world, pushed, host, tick } = setup([false, false, true]);
    await world.start(host as never);
    await settle();
    pushed.length = 0;
    await tick();
    expect(pushed).toHaveLength(0);
    expect(world.envPromptVars()['here.state']).toContain('在桌前');
    await world.stop();
  });

  it('answers the read tool with the record and a live probe', async () => {
    const { world, host } = setup([false, false]);
    await world.start(host as never);
    await settle();
    const text = (await world.tools()[0]!.handler({}, {} as never)) as string;
    expect(text).toContain('现在');
    expect(text).toContain('刚刚复查');
    expect(text).toContain('解锁');
    await world.stop();
  });
});
