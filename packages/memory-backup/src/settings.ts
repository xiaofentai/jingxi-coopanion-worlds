/**
 * A World's settings live in the deployment's `config.json` under `worlds.<id>`. Restoring the
 * package without them brings back the code but not the plugin the person configured, so a restore
 * takes each section the snapshot holds — except this World's own, whose section would let a
 * rollback switch off the tool performing it.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface WorldsMerge {
  /** Ids whose section comes from the snapshot. */
  restored: string[];
  /** Ids the snapshot did not hold; their sections go away, as they did not exist then. */
  removed: string[];
  /** Ids left alone. */
  kept: string[];
  /** False when the snapshot holds no settings at all, in which case nothing is written. */
  applicable: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readObject(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** The `worlds` object of a config file; empty when it has none. */
export function readWorlds(file: string): Record<string, unknown> {
  const worlds = readObject(file).worlds;
  return isRecord(worlds) ? worlds : {};
}

function plan(live: Record<string, unknown>, from: Record<string, unknown>, keep: readonly string[]): WorldsMerge {
  const merge: WorldsMerge = { restored: [], removed: [], kept: [], applicable: Object.keys(from).length > 0 };
  for (const id of Object.keys(from)) {
    if (keep.includes(id)) merge.kept.push(id);
    else merge.restored.push(id);
  }
  for (const id of Object.keys(live)) {
    if (keep.includes(id) || id in from) continue;
    merge.removed.push(id);
  }
  return merge;
}

/** What a restore would do to the settings, without writing anything. */
export function planWorlds(liveFile: string, snapshotFile: string, keep: readonly string[] = []): WorldsMerge {
  return plan(readWorlds(liveFile), readWorlds(snapshotFile), keep);
}

/** Writes the snapshot's world sections over the live ones; the file is replaced whole, as the app does. */
export function mergeWorlds(liveFile: string, snapshotFile: string, keep: readonly string[] = []): WorldsMerge {
  const live = readObject(liveFile);
  const current = isRecord(live.worlds) ? live.worlds : {};
  const from = readWorlds(snapshotFile);
  const merge = plan(current, from, keep);
  if (!merge.applicable) return merge;

  const worlds: Record<string, unknown> = {};
  for (const [id, section] of Object.entries(current)) {
    if (keep.includes(id) || id in from) worlds[id] = section;
  }
  for (const id of merge.restored) worlds[id] = from[id];

  const tmp = `${liveFile}.memory-backup-tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...live, worlds }, null, 2)}\n`, 'utf8');
  renameSync(tmp, liveFile);
  return merge;
}
