import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyPresence } from '../src/presence.ts';
import { readState, writeState } from '../src/state.ts';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function file(name = 'are-you-there.json'): string {
  const root = mkdtempSync(join(tmpdir(), 'are-you-there-'));
  roots.push(root);
  return join(root, name);
}

describe('record', () => {
  it('starts empty when the file is missing', () => {
    expect(readState(file())).toEqual(emptyPresence());
  });

  it('round-trips the state through disk', () => {
    const path = file();
    const state = { away: true, since: 1_000, reason: 'idle' as const, lastAway: { from: 100, to: 900 } };
    writeState(path, state);
    expect(readState(path)).toEqual(state);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('reads a record written by 0.1.0, which said `locked`', () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ locked: true, since: 5_000, lastAway: { from: 1, to: 2 } }), 'utf8');
    expect(readState(path)).toEqual({ away: true, since: 5_000, reason: 'lock', lastAway: { from: 1, to: 2 } });
  });

  it('keeps an unreadable record as .bad and starts empty', () => {
    const path = file();
    writeFileSync(path, '{ not json', 'utf8');
    expect(readState(path)).toEqual(emptyPresence());
    expect(existsSync(`${path}.bad`)).toBe(true);
  });

  it('drops fields of the wrong shape instead of trusting them', () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ away: 'yes', since: 'yesterday', reason: 'sleep', lastAway: { from: 5, to: 1 } }), 'utf8');
    expect(readState(path)).toEqual(emptyPresence());
  });
});
