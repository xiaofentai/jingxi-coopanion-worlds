/**
 * `memory-backup.json` in the deployment's data directory: when the next reminder is due, the last
 * tidy, and the last snapshot. Written whole to a temporary file and renamed, so a crash leaves the
 * old record or the new one; content that cannot be read is kept beside the file and the World starts
 * from an empty record.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** The file name inside `ctx.dataDir`; it starts with the World id so it cannot collide with another World's. */
export const STATE_FILE = 'memory-backup.json';

export interface SnapshotRecord {
  id: string;
  /** When the copy started, epoch ms. */
  at: number;
  /** The snapshot directory, absolute. */
  path: string;
  files: number;
  bytes: number;
}

/** What the last restore replaced, and where the state before it was saved. */
export interface RestoreRecord {
  at: number;
  /** The snapshot it came from. */
  from: string;
  target: string;
  files: number;
  /** The safety snapshot taken right before, absolute; empty when it could not be taken and the restore was refused. */
  safety: string;
}

export interface MemoryBackupState {
  /** When the next reminder is due, epoch ms; null while the reminder is off or not yet scheduled. */
  nextDueAt: number | null;
  lastTidyAt: number | null;
  lastTidyNote: string;
  lastSnapshot: SnapshotRecord | null;
  lastRestore: RestoreRecord | null;
}

export function emptyState(): MemoryBackupState {
  return { nextDueAt: null, lastTidyAt: null, lastTidyNote: '', lastSnapshot: null, lastRestore: null };
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function snapshotRecord(value: unknown): SnapshotRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.path !== 'string' || !isNumber(r.at)) return null;
  return { id: r.id, at: r.at, path: r.path, files: isNumber(r.files) ? r.files : 0, bytes: isNumber(r.bytes) ? r.bytes : 0 };
}

function restoreRecord(value: unknown): RestoreRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!isNumber(r.at) || typeof r.from !== 'string') return null;
  return {
    at: r.at,
    from: r.from,
    target: typeof r.target === 'string' ? r.target : '',
    files: isNumber(r.files) ? r.files : 0,
    safety: typeof r.safety === 'string' ? r.safety : '',
  };
}

export function readState(file: string): MemoryBackupState {
  if (!existsSync(file)) return emptyState();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.warn('[memory-backup] could not read the record', file, error);
    return emptyState();
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const state = emptyState();
    state.nextDueAt = isNumber(raw.nextDueAt) ? raw.nextDueAt : null;
    state.lastTidyAt = isNumber(raw.lastTidyAt) ? raw.lastTidyAt : null;
    state.lastTidyNote = typeof raw.lastTidyNote === 'string' ? raw.lastTidyNote : '';
    state.lastSnapshot = snapshotRecord(raw.lastSnapshot);
    state.lastRestore = restoreRecord(raw.lastRestore);
    return state;
  } catch (error) {
    console.warn('[memory-backup] unreadable record, keeping it as .bad', file, error);
    try {
      renameSync(file, `${file}.bad`);
    } catch { /* the next save writes a fresh one */ }
    return emptyState();
  }
}

export function writeState(file: string, state: MemoryBackupState): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
