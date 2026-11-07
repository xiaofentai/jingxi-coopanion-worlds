import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_FILE, clearSnapshots, listSnapshots, restoreSnapshot, takeSnapshot } from '../src/backup.ts';
import { MEMORY_BACKUP_DEFAULTS } from '../src/config.ts';
import { APP_DATA_ENTRIES } from '../src/paths.ts';

/**
 * A data directory shaped like Coopanion's: `home/` holds the deployment, the shared endpoints and
 * the models; `extensions/` and `logs/` sit beside it; `tmp/` is scratch.
 */
function dataDir(): string {
  // one directory per test, so the default `<root>/../memory-backups` is never shared
  const data = join(mkdtempSync(join(tmpdir(), 'mb-backup-')), 'data');
  const deploy = join(data, 'home', 'companion');
  mkdirSync(join(deploy, 'workspace', 'notes'), { recursive: true });
  mkdirSync(join(deploy, 'data', 'runs', '2026-10-27T04-00-00'), { recursive: true });
  mkdirSync(join(data, 'home', 'providers', 'deepseek'), { recursive: true });
  mkdirSync(join(data, 'home', 'models', 'asr'), { recursive: true });
  mkdirSync(join(data, 'extensions', 'cortico-world-x'), { recursive: true });
  mkdirSync(join(data, 'logs'), { recursive: true });
  mkdirSync(join(data, 'tmp'), { recursive: true });
  writeFileSync(join(deploy, 'config.json'), '{ "language": "zh" }\n');
  writeFileSync(join(deploy, 'workspace', 'PARTNER.md'), 'tea\n');
  writeFileSync(join(deploy, 'workspace', 'notes', 'today.md'), 'tidied\n');
  writeFileSync(join(deploy, 'data', 'runs', '2026-10-27T04-00-00', 'events.jsonl'), '{"cursor":1}\n{"cursor":2}\n{"cur');
  writeFileSync(join(deploy, 'data', 'download.partial'), 'unfinished');
  writeFileSync(join(deploy, 'data', 'config.json.tmp-123'), 'half');
  writeFileSync(join(deploy, 'data', 'index.lock'), '');
  writeFileSync(join(data, 'home', 'providers', 'deepseek', '.env'), 'COO_KEY=k\n', { mode: 0o600 });
  writeFileSync(join(data, 'home', 'models', 'asr', 'model.onnx'), Buffer.alloc(2048));
  writeFileSync(join(data, 'extensions', 'cortico-world-x', 'package.json'), '{}\n');
  writeFileSync(join(data, 'logs', 'core.log'), 'started\n');
  writeFileSync(join(data, 'tmp', 'scratch.txt'), 'junk');
  return data;
}

function options(root: string, extra: {
  backupDir?: string;
  skipDirs?: string[];
  only?: readonly string[];
  now?: number;
  maxBackups?: number;
} = {}) {
  return {
    root,
    backupDir: extra.backupDir ?? join(root, '..', 'memory-backups'),
    timezone: 'UTC',
    maxBackups: extra.maxBackups ?? MEMORY_BACKUP_DEFAULTS.maxBackups,
    note: '',
    now: extra.now,
    ...(extra.skipDirs ? { skipDirs: extra.skipDirs } : {}),
    ...(extra.only ? { only: extra.only } : {}),
  };
}

describe('a snapshot', () => {
  it('copies the directory whole and records what it did', async () => {
    const data = dataDir();
    const result = await takeSnapshot({ ...options(data), note: '合并了笔记' });

    expect(readFileSync(join(result.path, 'home', 'companion', 'workspace', 'notes', 'today.md'), 'utf8')).toBe('tidied\n');
    expect(readFileSync(join(result.path, 'home', 'companion', 'config.json'), 'utf8')).toBe('{ "language": "zh" }\n');
    const manifest = JSON.parse(readFileSync(join(result.path, MANIFEST_FILE), 'utf8'));
    expect(manifest).toMatchObject({ root: data, note: '合并了笔记' });
    expect(manifest.files).toBeGreaterThan(0);
    expect(manifest.bytes).toBeGreaterThan(2048);
    expect(result.manifest.changed).toEqual([]);
  });

  it('cuts an append-only file back to its last complete line', async () => {
    const data = dataDir();
    const result = await takeSnapshot(options(data));
    const copied = join(result.path, 'home', 'companion', 'data', 'runs', '2026-10-27T04-00-00', 'events.jsonl');

    expect(readFileSync(copied, 'utf8')).toBe('{"cursor":1}\n{"cursor":2}\n');
    expect(result.manifest.repaired).toEqual([join('home', 'companion', 'data', 'runs', '2026-10-27T04-00-00', 'events.jsonl')]);
  });

  it('leaves out partial downloads, temporary files and locks', async () => {
    const data = dataDir();
    const result = await takeSnapshot(options(data));

    expect(existsSync(join(result.path, 'home', 'companion', 'data', 'download.partial'))).toBe(false);
    expect(existsSync(join(result.path, 'home', 'companion', 'data', 'config.json.tmp-123'))).toBe(false);
    expect(existsSync(join(result.path, 'home', 'companion', 'data', 'index.lock'))).toBe(false);
    expect(result.manifest.skipped).toBeGreaterThanOrEqual(3);
  });

  it('copies a directory link as the directory it points at, and leaves pnpm\'s store out', async () => {
    const data = dataDir();
    const store = join(data, 'extensions', 'node_modules', '.pnpm', 'ext@1.0.0', 'node_modules', 'ext');
    mkdirSync(join(store, 'lib'), { recursive: true });
    writeFileSync(join(store, 'package.json'), '{ "name": "ext" }\n');
    writeFileSync(join(store, 'lib', 'index.js'), 'export default 1;\n');
    symlinkSync(store, join(data, 'extensions', 'node_modules', 'ext'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await takeSnapshot(options(data));
    const copied = join(result.path, 'extensions', 'node_modules', 'ext');

    expect(lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(copied, 'lib', 'index.js'), 'utf8')).toBe('export default 1;\n');
    expect(existsSync(join(result.path, 'extensions', 'node_modules', '.pnpm'))).toBe(false);
    expect(result.manifest.linked).toEqual([join('extensions', 'node_modules', 'ext')]);
  });

  it('does not follow a link back into a directory it came through', async () => {
    const data = dataDir();
    const deploy = join(data, 'home', 'companion');
    symlinkSync(data, join(deploy, 'data', 'loop'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await takeSnapshot(options(data));

    expect(existsSync(join(result.path, 'home', 'companion', 'data', 'loop'))).toBe(false);
    expect(result.manifest.linked).toEqual([]);
    expect(result.manifest.skipped).toBeGreaterThanOrEqual(4);
  });

  it('copies only the named entries of a directory that also holds caches', async () => {
    const data = dataDir();
    const result = await takeSnapshot(options(data, { only: APP_DATA_ENTRIES }));

    expect(existsSync(join(result.path, 'home', 'companion', 'workspace', 'PARTNER.md'))).toBe(true);
    expect(existsSync(join(result.path, 'extensions', 'cortico-world-x', 'package.json'))).toBe(true);
    expect(existsSync(join(result.path, 'logs', 'core.log'))).toBe(true);
    expect(existsSync(join(result.path, 'tmp'))).toBe(false);
  });

  it('leaves out the directories it is told to', async () => {
    const data = dataDir();
    mkdirSync(join(data, 'home', 'runtimes', 'sherpa'), { recursive: true });
    writeFileSync(join(data, 'home', 'runtimes', 'sherpa', 'lib.dll'), 'binary');

    const kept = await takeSnapshot(options(data, { backupDir: join(data, '..', 'a'), now: 1_000 }));
    const skipped = await takeSnapshot(options(data, {
      backupDir: join(data, '..', 'b'),
      skipDirs: [join(data, 'home', 'models'), join(data, 'home', 'runtimes')],
      now: 1_000,
    }));

    expect(existsSync(join(kept.path, 'home', 'models', 'asr', 'model.onnx'))).toBe(true);
    expect(existsSync(join(kept.path, 'home', 'runtimes', 'sherpa', 'lib.dll'))).toBe(true);
    expect(existsSync(join(skipped.path, 'home', 'models'))).toBe(false);
    expect(existsSync(join(skipped.path, 'home', 'runtimes'))).toBe(false);
    expect(existsSync(join(skipped.path, 'home', 'companion', 'workspace', 'PARTNER.md'))).toBe(true);
  });

  it('keeps the newest snapshots and leaves everything else in the directory alone', async () => {
    const data = dataDir();
    const backupDir = join(data, '..', 'memory-backups');
    mkdirSync(join(backupDir, 'someone-elses-folder'), { recursive: true });

    for (const now of [1_000_000, 2_000_000, 3_000_000]) {
      await takeSnapshot(options(data, { backupDir, maxBackups: 2, now }));
    }

    expect(listSnapshots(backupDir)).toHaveLength(2);
    expect(existsSync(join(backupDir, 'someone-elses-folder'))).toBe(true);
  });

  it('does not copy a backup directory that sits inside the copied tree', async () => {
    const data = dataDir();
    const backupDir = join(data, 'home', 'backups');

    await takeSnapshot(options(data, { backupDir }));
    const second = await takeSnapshot(options(data, { backupDir, now: Date.now() + 1000 }));

    expect(readdirSync(backupDir).filter((name) => name.endsWith('.partial'))).toEqual([]);
    expect(existsSync(join(second.path, 'home', 'backups'))).toBe(false);
    expect(listSnapshots(backupDir)).toHaveLength(2);
  });

  it('is deleted whole by clearSnapshots, and only then', async () => {
    const data = dataDir();
    const backupDir = join(data, '..', 'memory-backups');
    mkdirSync(join(backupDir, 'someone-elses-folder'), { recursive: true });
    const result = await takeSnapshot(options(data, { backupDir }));

    expect(clearSnapshots(backupDir)).toEqual({ count: 1, bytes: result.manifest.bytes });
    expect(listSnapshots(backupDir)).toEqual([]);
    expect(existsSync(join(backupDir, 'someone-elses-folder'))).toBe(true);
  });
});

describe('a restore', () => {
  it('writes the snapshot back over the live tree and takes away what it does not hold', async () => {
    const data = dataDir();
    const workspace = join(data, 'home', 'companion', 'workspace');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, '.git', 'HEAD'), 'old\n');
    const snapshot = await takeSnapshot(options(data));

    writeFileSync(join(workspace, 'notes', 'today.md'), 'changed later\n');
    writeFileSync(join(workspace, 'later.md'), 'new\n');
    writeFileSync(join(workspace, '.git', 'HEAD'), 'new\n');

    const result = await restoreSnapshot({
      snapshot: snapshot.path,
      root: data,
      entries: [join('home', 'companion', 'workspace')],
      mirror: true,
      keepInside: [join(workspace, '.git')],
    });

    expect(readFileSync(join(workspace, 'notes', 'today.md'), 'utf8')).toBe('tidied\n');
    expect(existsSync(join(workspace, 'later.md'))).toBe(false);
    // the Git history is neither written over nor deleted: the restore is a change waiting to be committed
    expect(readFileSync(join(workspace, '.git', 'HEAD'), 'utf8')).toBe('new\n');
    expect(result.removed).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('restores a snapshot taken where the data directory was somewhere else', async () => {
    const data = dataDir();
    const snapshot = await takeSnapshot(options(data));
    const manifestFile = join(snapshot.path, MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    // as if the snapshot had been carried over from another machine
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, root: join(data, 'another', 'place') }));
    const workspace = join(data, 'home', 'companion', 'workspace');
    writeFileSync(join(workspace, 'later.md'), 'new\n');

    await restoreSnapshot({
      snapshot: snapshot.path,
      root: data,
      entries: [join('home', 'companion', 'workspace')],
      mirror: true,
    });

    expect(existsSync(join(workspace, 'later.md'))).toBe(false);
    expect(readFileSync(join(workspace, 'PARTNER.md'), 'utf8')).toBe('tea\n');
  });

  it('replaces a live link with the snapshot\'s real directory and leaves the store alone', async () => {
    const data = dataDir();
    const store = join(data, 'extensions', 'node_modules', '.pnpm', 'ext@1.0.0', 'node_modules', 'ext');
    const live = join(data, 'extensions', 'node_modules', 'ext');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'package.json'), '{}\n');
    const snapshot = await takeSnapshot(options(data));

    // after the snapshot the package was reinstalled from pnpm: the live entry is now a link
    rmSync(live, { recursive: true, force: true });
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'package.json'), '{ "v": 2 }\n');
    symlinkSync(store, live, process.platform === 'win32' ? 'junction' : 'dir');

    await restoreSnapshot({ snapshot: snapshot.path, root: data, entries: [join('extensions')] });

    expect(lstatSync(live).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(live, 'package.json'), 'utf8')).toBe('{}\n');
    expect(readFileSync(join(store, 'package.json'), 'utf8')).toBe('{ "v": 2 }\n');
  });

  it('brings a package\'s dependencies along, the way pnpm keeps them beside it', async () => {
    const data = dataDir();
    const store = join(data, 'extensions', 'node_modules', '.pnpm');
    const pkg = join(store, 'ext@1.0.0', 'node_modules', 'ext');
    const dep = join(store, 'dep@2.0.0', 'node_modules', 'dep');
    mkdirSync(pkg, { recursive: true });
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(pkg, 'index.js'), "import 'dep';\n");
    writeFileSync(join(dep, 'index.js'), 'export default 1;\n');
    symlinkSync(dep, join(store, 'ext@1.0.0', 'node_modules', 'dep'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(pkg, join(data, 'extensions', 'node_modules', 'ext'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await takeSnapshot(options(data));

    expect(readFileSync(join(result.path, 'extensions', 'node_modules', 'ext', 'node_modules', 'dep', 'index.js'), 'utf8'))
      .toBe('export default 1;\n');
    expect(existsSync(join(result.path, 'extensions', 'node_modules', '.pnpm'))).toBe(false);
    expect(result.manifest.linked).toContain(join('extensions', 'node_modules', 'ext'));
  });

  it('leaves a path it is told to keep, and takes a package it is told to keep out of the write', async () => {
    const data = dataDir();
    const own = join(data, 'extensions', 'node_modules', 'coopanion-world-memory-backup');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'package.json'), '{ "v": "live" }\n');
    const snapshot = await takeSnapshot(options(data));
    writeFileSync(join(own, 'package.json'), '{ "v": "changed" }\n');

    await restoreSnapshot({ snapshot: snapshot.path, root: data, entries: [join('extensions')], keep: [own] });

    expect(readFileSync(join(own, 'package.json'), 'utf8')).toBe('{ "v": "changed" }\n');
  });

  it('refuses a folder that is not one of its snapshots', async () => {
    const data = dataDir();
    await expect(restoreSnapshot({ snapshot: data, root: data, entries: [join('extensions')] }))
      .rejects.toThrow(/not a snapshot/);
  });
});
