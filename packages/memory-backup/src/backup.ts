/**
 * One snapshot: the configured directory copied into `<backupDir>/<id>/`, file by file.
 *
 * The copy runs while the bot waits on the tool call that started it, so the bot writes nothing
 * into the tree meanwhile. What still moves — run logs, the event store, a setting saved from the
 * settings window — is either renamed into place (config, secrets, Memory files, wake-up and notice
 * records) or appended line by line. A file that changes while it is copied is copied again; an
 * append-only file whose last line was half-written is cut back to its last complete line.
 *
 * A snapshot appears under its own name only after its manifest is written, and carries
 * `.memory-backup.json` so later runs can tell their own folders from anything else in the same
 * directory. Only folders holding that manifest are ever deleted.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { localStamp } from './schedule.ts';

/** Names a folder as this World's snapshot and records what the copy did. */
export const MANIFEST_FILE = '.memory-backup.json';
/** A snapshot's folder name: the local time the copy started. */
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
/** A file that is still moving after this many copies keeps the last one, reported as `changed`. */
const COPY_ATTEMPTS = 3;
/** How far back a torn tail is looked for a line break. */
const TAIL_WINDOW = 64 * 1024;
/** A copy that never reached its rename is dropped after this long. */
const PARTIAL_LIFETIME_MS = 24 * 60 * 60_000;
/** How many links deep a copied tree may go before the rest is skipped, for a layout that links in a circle. */
const MAX_LINK_DEPTH = 16;
/** pnpm's own copy of every package; what links point at is copied instead, so this would only repeat it. */
const PNPM_STORE = '.pnpm';

/** Windows resolves paths without case; a link back to the same directory must be recognised as one. */
const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export interface SnapshotManifest {
  id: string;
  /** When the copy started, epoch ms. */
  at: number;
  /** The directory copied, absolute. */
  root: string;
  files: number;
  bytes: number;
  /** Relative paths of files still changing when the last copy was taken: the copy is a prefix. */
  changed: string[];
  /** Relative paths of append-only files whose unfinished last line was cut. */
  repaired: string[];
  /** Relative paths that could not be copied: a file another program holds open, for one. */
  failed: string[];
  /** Relative paths of links copied as the directories they point at, so the snapshot needs no package manager. */
  linked: string[];
  /** Entries left out: partial downloads, temporary and lock files, links to files, skipped folders. */
  skipped: number;
  /** What the bot wrote about this snapshot. */
  note: string;
}

export interface SnapshotOptions {
  /** The directory copied, absolute. */
  root: string;
  /** Where the dated folders go, absolute. */
  backupDir: string;
  timezone: string;
  maxBackups: number;
  /** Absolute directories left out whole: models and runtimes, which download again when needed. */
  skipDirs?: readonly string[];
  /** Top-level entry names to copy, when the rest of the directory holds caches rather than content. */
  only?: readonly string[];
  note: string;
  /** Defaults to now. */
  now?: number;
  signal?: AbortSignal;
}

export interface SnapshotResult {
  manifest: SnapshotManifest;
  /** The snapshot folder, absolute. */
  path: string;
  /** Ids of snapshots deleted to stay within `maxBackups`. */
  removed: string[];
}

interface WalkOptions {
  root: string;
  backupDir: string;
  skipDirs: readonly string[];
  only: readonly string[] | null;
  /** Real paths of the directories this walk came through, so a link that leads back is not walked twice. */
  ancestors: readonly string[];
  signal?: AbortSignal;
  depth: number;
}

interface Counters {
  files: number;
  bytes: number;
  skipped: number;
  changed: string[];
  repaired: string[];
  failed: string[];
  linked: string[];
}

/** Partial downloads, files caught mid-rename and lock files: not content of the data directory. */
const isTransient = (name: string): boolean =>
  name.endsWith('.partial') || name.includes('.tmp-') || name.includes('.bak-') || name.endsWith('.lock');

/** Files written by appending one line at a time: the only ones whose tail can be half a record. */
const isAppendOnly = (name: string): boolean => name.endsWith('.jsonl') || name.endsWith('.log');

export async function takeSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const root = resolve(options.root);
  if (root === resolve(join(root, '..'))) throw new Error(`${root} is a filesystem root`);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${root} is not a directory`);

  const backupDir = resolve(options.backupDir);
  await mkdir(backupDir, { recursive: true });
  const at = options.now ?? Date.now();
  const id = freeId(backupDir, localStamp(options.timezone, at));
  const partial = join(backupDir, `${id}.partial`);
  const final = join(backupDir, id);
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });

  const counters: Counters = { files: 0, bytes: 0, skipped: 0, changed: [], repaired: [], failed: [], linked: [] };
  try {
    await copyTree(root, partial, {
      root,
      backupDir,
      skipDirs: (options.skipDirs ?? []).map((dir) => resolve(dir)),
      only: options.only ?? null,
      ancestors: [await realpath(root).catch(() => root)],
      signal: options.signal,
      depth: 0,
    }, counters);
    options.signal?.throwIfAborted();
    const manifest: SnapshotManifest = {
      id, at, root,
      files: counters.files,
      bytes: Math.max(0, counters.bytes),
      changed: counters.changed,
      repaired: counters.repaired,
      failed: counters.failed,
      linked: counters.linked,
      skipped: counters.skipped,
      note: options.note,
    };
    await writeFile(join(partial, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(partial, final);
    const removed = await pruneSnapshots(backupDir, options.maxBackups, at);
    return { manifest, path: final, removed };
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => { /* nothing to keep */ });
    throw error;
  }
}

async function copyTree(src: string, dst: string, o: WalkOptions, counters: Counters): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch (error) {
    // the root itself has to be readable: a snapshot of nothing is not a backup
    if (o.depth === 0) throw error;
    counters.skipped += 1;
    return;
  }
  for (const entry of entries) {
    o.signal?.throwIfAborted();
    const from = join(src, entry.name);
    // a backup directory inside the copied tree, configured by hand, would grow with every snapshot
    if (from === o.backupDir || from.startsWith(o.backupDir + sep)) continue;
    if (o.depth === 0 && o.only && !o.only.includes(entry.name)) {
      counters.skipped += 1;
      continue;
    }
    if (o.skipDirs.includes(from)) {
      counters.skipped += 1;
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === PNPM_STORE) {
        counters.skipped += 1;
        continue;
      }
      const to = join(dst, entry.name);
      await mkdir(to);
      await copyTree(from, to, { ...o, depth: o.depth + 1 }, counters);
      continue;
    }
    if (entry.isSymbolicLink()) {
      await copyLink(from, join(dst, entry.name), o, counters);
      continue;
    }
    if (!entry.isFile() || isTransient(entry.name)) {
      counters.skipped += 1;
      continue;
    }
    await copyFileWithRetry(from, join(dst, entry.name), o, counters);
  }
}

/**
 * A link to a directory is copied as that directory: pnpm keeps every package in its own store and
 * links the names to it, so following the links is what makes an installed extension usable in the
 * snapshot without pnpm or a network. A link to a file, and one that leads back to a directory the
 * walk came through, is skipped.
 */
async function copyLink(from: string, to: string, o: WalkOptions, counters: Counters): Promise<void> {
  let target: Stats;
  try {
    target = await stat(from);
  } catch {
    counters.skipped += 1;
    return;
  }
  if (!target.isDirectory()) {
    counters.skipped += 1;
    return;
  }
  const real = await realpath(from).catch(() => from);
  if (o.ancestors.some((ancestor) => samePath(ancestor, real)) || o.ancestors.length > MAX_LINK_DEPTH) {
    counters.skipped += 1;
    return;
  }
  counters.linked.push(relative(o.root, from));
  await mkdir(to, { recursive: true });
  const nested: WalkOptions = { ...o, depth: o.depth + 1, ancestors: [...o.ancestors, real] };
  await copyTree(from, to, nested, counters);
  await copyDependencies(real, to, nested, counters);
}

/**
 * pnpm keeps a package's dependencies beside it in the store, not inside it
 * (`.pnpm/foo@1/node_modules/` holds `foo` and links to `bar`, `baz`). Copying only `foo` leaves
 * the snapshot unable to import them, so they come along under `<copied foo>/node_modules/`.
 * Each of those is itself copied through its own store folder, so their dependencies follow too.
 */
async function copyDependencies(real: string, to: string, o: WalkOptions, counters: Counters): Promise<void> {
  if (!real.includes(`${sep}.pnpm${sep}`)) return;
  const self = basename(real);
  // a scope folder (`@scope`) holds the linked packages themselves; each is copied through its own store folder
  if (self.startsWith('@')) return;
  const store = dirname(real);
  let entries: Dirent[];
  try {
    entries = await readdir(store, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === self || entry.name === '.bin' || entry.name === 'node_modules') continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await copyLink(join(store, entry.name), join(to, 'node_modules', entry.name), o, counters);
  }
}

async function copyFileWithRetry(from: string, to: string, o: WalkOptions, counters: Counters): Promise<void> {
  try {
    let settled = false;
    for (let attempt = 0; attempt < COPY_ATTEMPTS && !settled; attempt += 1) {
      const before = await stat(from);
      await copyFile(from, to);
      const after = await stat(from);
      const copied = await stat(to);
      settled = before.size === after.size && before.mtimeMs === after.mtimeMs && copied.size === after.size;
    }
    const copied = await stat(to);
    if (!settled) counters.changed.push(relative(o.root, from));
    // a file only its owner may read (an endpoint's key) keeps that mode in the copy
    const source = await stat(from);
    if ((source.mode & 0o077) === 0) await chmod(to, source.mode).catch(() => { /* Windows modes */ });
    counters.files += 1;
    counters.bytes += copied.size;
    if (isAppendOnly(from)) await cutTornTail(to, from, o, counters);
  } catch {
    // one held-open file does not cost the rest of the snapshot
    counters.failed.push(relative(o.root, from));
  }
}

/** Drops an unfinished last line from `file`, leaving every complete line as it was copied. */
async function cutTornTail(file: string, source: string, o: WalkOptions, counters: Counters): Promise<void> {
  const { size } = await stat(file);
  if (size === 0) return;
  let cut = 0;
  const handle = await open(file, 'r');
  try {
    let end = size;
    while (end > 0 && cut === 0) {
      const length = Math.min(end, TAIL_WINDOW);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, end - length);
      const index = chunk.lastIndexOf(0x0a);
      if (index >= 0) cut = end - length + index + 1;
      else end -= length;
    }
  } finally {
    await handle.close();
  }
  if (cut === size) return;
  await truncate(file, cut);
  counters.bytes -= size - cut;
  counters.repaired.push(relative(o.root, source));
}

function freeId(dir: string, stamp: string): string {
  if (!existsSync(join(dir, stamp))) return stamp;
  for (let n = 2; ; n += 1) {
    const id = `${stamp}-${n}`;
    if (!existsSync(join(dir, id))) return id;
  }
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The snapshots in `dir`, newest first. Folders without this World's manifest, or named otherwise, are not listed. */
export function listSnapshots(dir: string): SnapshotManifest[] {
  const snapshots: SnapshotManifest[] = [];
  for (const entry of readEntries(dir)) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry.name, MANIFEST_FILE), 'utf8')) as Partial<SnapshotManifest>;
      if (typeof raw.at !== 'number' || typeof raw.files !== 'number') continue;
      snapshots.push({
        id: entry.name,
        at: raw.at,
        root: typeof raw.root === 'string' ? raw.root : '',
        files: raw.files,
        bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
        changed: Array.isArray(raw.changed) ? raw.changed : [],
        repaired: Array.isArray(raw.repaired) ? raw.repaired : [],
        failed: Array.isArray(raw.failed) ? raw.failed : [],
        linked: Array.isArray(raw.linked) ? raw.linked : [],
        skipped: typeof raw.skipped === 'number' ? raw.skipped : 0,
        note: typeof raw.note === 'string' ? raw.note : '',
      });
    } catch { /* not a snapshot of this World */ }
  }
  return snapshots.sort((a, b) => b.at - a.at);
}

/** Deletes the oldest snapshots beyond `maxBackups`; returns their ids. */
export async function pruneSnapshots(dir: string, maxBackups: number, now = Date.now()): Promise<string[]> {
  const keep = Math.max(1, Math.floor(maxBackups));
  const removed: string[] = [];
  for (const snapshot of listSnapshots(dir).slice(keep)) {
    await rm(join(dir, snapshot.id), { recursive: true, force: true });
    removed.push(snapshot.id);
  }
  for (const entry of readEntries(dir)) {
    if (!entry.isDirectory() || !entry.name.endsWith('.partial')) continue;
    const info = await stat(join(dir, entry.name)).catch(() => null);
    if (info && now - info.mtimeMs > PARTIAL_LIFETIME_MS) {
      await rm(join(dir, entry.name), { recursive: true, force: true }).catch(() => { /* next time */ });
    }
  }
  return removed;
}

/** Deletes every snapshot in `dir`; returns how many went and how many bytes they held. */
export function clearSnapshots(dir: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const snapshot of listSnapshots(dir)) {
    try {
      rmSync(join(dir, snapshot.id), { recursive: true, force: true });
      count += 1;
      bytes += snapshot.bytes;
    } catch (error) {
      console.warn('[memory-backup] could not delete a snapshot', snapshot.id, error);
    }
  }
  return { count, bytes };
}

/** The manifest of the snapshot in `dir`, or null when that folder is not one of this World's snapshots. */
export function readManifest(dir: string): SnapshotManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as Partial<SnapshotManifest>;
    if (typeof raw.at !== 'number') return null;
    return {
      id: typeof raw.id === 'string' ? raw.id : '',
      at: raw.at,
      root: typeof raw.root === 'string' ? raw.root : '',
      files: typeof raw.files === 'number' ? raw.files : 0,
      bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
      changed: Array.isArray(raw.changed) ? raw.changed : [],
      repaired: Array.isArray(raw.repaired) ? raw.repaired : [],
      failed: Array.isArray(raw.failed) ? raw.failed : [],
      linked: Array.isArray(raw.linked) ? raw.linked : [],
      skipped: typeof raw.skipped === 'number' ? raw.skipped : 0,
      note: typeof raw.note === 'string' ? raw.note : '',
    };
  } catch {
    return null;
  }
}

export interface RestoreOptions {
  /** The snapshot folder, absolute. */
  snapshot: string;
  /** The data directory the snapshot was taken from; entries are relative to it. */
  root: string;
  /** Relative paths taken from the snapshot, each written over the same path under `root`. */
  entries: readonly string[];
  /** Absolute paths left as they are, such as this World's own package. */
  keep?: readonly string[];
  /** Remove what the snapshot does not hold, so the tree comes back as it was then. */
  mirror?: boolean;
  /** Inside a restored tree, absolute paths neither written over nor deleted: the workspace's Git history, for one. */
  keepInside?: readonly string[];
  /** Destination paths ending in one of these are left alone: `*.jsonl` holds the conversation and usage logs. */
  skipSuffix?: readonly string[];
  signal?: AbortSignal;
}

export interface RestoreResult {
  files: number;
  bytes: number;
  /** Paths removed because the snapshot did not hold them; only with `mirror`. */
  removed: number;
  /** Paths left as they were. */
  kept: number;
  /** Live paths that could not be written, absolute. */
  failed: string[];
}

/**
 * Writes a snapshot back over the live directory. A live link is removed and replaced by what the
 * snapshot holds, so a package pnpm linked in comes back as a real directory; nothing outside the
 * listed entries is touched, and without `mirror` nothing is deleted.
 */
export async function restoreSnapshot(options: RestoreOptions): Promise<RestoreResult> {
  const snapshot = resolve(options.snapshot);
  if (!readManifest(snapshot)) throw new Error(`${snapshot} is not a snapshot of this World`);
  const root = resolve(options.root);
  const counters: RestoreResult = { files: 0, bytes: 0, removed: 0, kept: 0, failed: [] };
  const walk: RestoreWalk = {
    root,
    keep: (options.keep ?? []).map((path) => resolve(path)),
    keepInside: (options.keepInside ?? []).map((path) => resolve(path)),
    skipSuffix: options.skipSuffix ?? [],
    mirror: options.mirror === true,
    signal: options.signal,
  };
  for (const entry of options.entries) {
    const from = join(snapshot, entry);
    if (!existsSync(from)) continue;
    await restoreTree(from, join(root, entry), walk, counters);
  }
  return counters;
}

interface RestoreWalk {
  root: string;
  keep: readonly string[];
  keepInside: readonly string[];
  skipSuffix: readonly string[];
  mirror: boolean;
  signal?: AbortSignal;
}

async function restoreTree(src: string, dst: string, o: RestoreWalk, counters: RestoreResult): Promise<void> {
  o.signal?.throwIfAborted();
  if (o.keep.some((path) => samePath(path, dst)) || o.skipSuffix.some((suffix) => dst.endsWith(suffix))) {
    counters.kept += 1;
    return;
  }
  const source = await stat(src).catch(() => null);
  if (!source) return;
  // an entry may be a single file: the deployment's `.env` holds the plugins' secrets
  if (source.isFile()) {
    await restoreFile(src, dst, counters);
    return;
  }
  // what stands here now may be a link pnpm made, or a file: the snapshot's own directory replaces it
  const live = await lstat(dst).catch(() => null);
  if (live?.isSymbolicLink()) await unlink(dst).catch(() => { /* replaced below */ });
  else if (live && !live.isDirectory()) await rm(dst, { force: true });
  await mkdir(dst, { recursive: true });

  const names = new Set<string>();
  for (const entry of await readdir(src, { withFileTypes: true })) {
    o.signal?.throwIfAborted();
    names.add(entry.name);
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (o.keep.some((path) => samePath(path, to))) {
      counters.kept += 1;
      continue;
    }
    if (o.keepInside.some((kept) => samePath(kept, to) || to.startsWith(kept + sep))) {
      counters.kept += 1;
      continue;
    }
    if (o.skipSuffix.some((suffix) => to.endsWith(suffix))) {
      counters.kept += 1;
      continue;
    }
    if (entry.isDirectory()) {
      await restoreTree(from, to, o, counters);
      continue;
    }
    if (entry.isFile()) await restoreFile(from, to, counters);
    else counters.kept += 1;
  }
  if (!o.mirror) return;
  for (const entry of await readdir(dst, { withFileTypes: true })) {
    if (names.has(entry.name)) continue;
    const path = join(dst, entry.name);
    if (o.keepInside.some((kept) => samePath(kept, path) || path.startsWith(kept + sep))
      || o.skipSuffix.some((suffix) => path.endsWith(suffix))) {
      counters.kept += 1;
      continue;
    }
    try {
      const info = await lstat(path).catch(() => null);
      if (info?.isSymbolicLink()) await unlink(path);
      else await rm(path, { recursive: true, force: true });
      counters.removed += 1;
    } catch {
      counters.failed.push(path);
    }
  }
}

async function restoreFile(from: string, to: string, counters: RestoreResult): Promise<void> {
  try {
    await mkdir(dirname(to), { recursive: true });
    const live = await lstat(to).catch(() => null);
    if (live?.isSymbolicLink()) await unlink(to);
    else if (live?.isDirectory()) await rm(to, { recursive: true, force: true });
    await copyFile(from, to);
    counters.files += 1;
    counters.bytes += (await stat(to)).size;
  } catch {
    counters.failed.push(to);
  }
}

