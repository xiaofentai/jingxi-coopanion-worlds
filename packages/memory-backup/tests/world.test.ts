import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { MANIFEST_FILE, listSnapshots } from '../src/backup.ts';
import { MEMORY_BACKUP_DEFAULTS, type MemoryBackupConfigSection } from '../src/config.ts';
import { MEMORY_BACKUP } from '../src/definition.ts';
import { appDataRoot } from '../src/paths.ts';
import { STATE_FILE } from '../src/state.ts';

/**
 * A data directory the way Coopanion lays it out: `home/` holds the deployment, the endpoints and
 * the models; `extensions/`, `logs/` and `tmp/` sit beside it.
 */
function deployment(): { dataRoot: string; botDir: string; dataDir: string; backupDir: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'mb-world-'));
  const botDir = join(dataRoot, 'home', 'companion');
  mkdirSync(join(botDir, 'workspace', 'notes'), { recursive: true });
  mkdirSync(join(botDir, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'extensions', 'cortico-world-x'), { recursive: true });
  mkdirSync(join(dataRoot, 'logs'), { recursive: true });
  mkdirSync(join(dataRoot, 'tmp'), { recursive: true });
  writeFileSync(join(botDir, 'config.json'), JSON.stringify({ language: 'zh' }));
  writeFileSync(join(botDir, 'workspace', 'PARTNER.md'), 'tea\n');
  writeFileSync(join(botDir, 'workspace', 'notes', 'today.md'), 'tidied\n');
  writeFileSync(join(dataRoot, 'extensions', 'cortico-world-x', 'package.json'), '{}\n');
  writeFileSync(join(dataRoot, 'logs', 'core.log'), 'started\n');
  writeFileSync(join(dataRoot, 'tmp', 'scratch.txt'), 'junk');
  return { dataRoot, botDir, dataDir: join(botDir, 'data'), backupDir: join(dataRoot, 'memory-backups') };
}

function mounted(cfg: Partial<MemoryBackupConfigSection> = {}) {
  const d = deployment();
  const section: MemoryBackupConfigSection = {
    ...MEMORY_BACKUP_DEFAULTS,
    enabled: true,
    backupDir: d.backupDir,
    ...cfg,
  };
  const ctx = {
    id: MEMORY_BACKUP.id,
    cfg: section,
    timezone: 'UTC',
    botName: 'Coo',
    botDir: d.botDir,
    packageDir: d.botDir,
    dataDir: d.dataDir,
    repoRoot: d.dataRoot,
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  } as WorldContext<MemoryBackupConfigSection>;
  // the app tells its Core where extensions go; the World takes the data directory from that
  const previous = process.env.CORTICO_EXTENSIONS_DIR;
  process.env.CORTICO_EXTENSIONS_DIR = join(d.dataRoot, 'extensions');
  let world: ReturnType<typeof MEMORY_BACKUP.create>;
  try {
    world = MEMORY_BACKUP.create(ctx);
  } finally {
    if (previous === undefined) delete process.env.CORTICO_EXTENSIONS_DIR;
    else process.env.CORTICO_EXTENSIONS_DIR = previous;
  }
  const pushed: Array<{ type: string; render?: () => string | null }> = [];
  const host = {
    pushDeferred: (event: { type: string; render?: () => string | null }) => { pushed.push(event); },
    pushEvent: async () => ({}),
    store: { get: () => undefined, latestCursor: () => 0 },
    drainPendingEvents: async () => [],
    modelFacts: {},
    blob: () => null,
    reportUsage: () => {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as WorldHost;
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const declaration = world.tools().find((tool) => tool.name === name);
    if (!declaration) throw new Error(`no tool ${name}`);
    return declaration.handler(args, {} as ToolCallContext) as Promise<string | ToolOutcome>;
  };
  return { ...d, section, world, pushed, host, run };
}

const receiptText = (outcome: string | ToolOutcome): string => (typeof outcome === 'string' ? outcome : outcome.text);
const failed = (outcome: string | ToolOutcome): boolean => typeof outcome !== 'string' && outcome.failed === true;

describe('the reminder', () => {
  it('arrives once the stored due time has passed, with the Memory it should tidy', async () => {
    const { world, host, pushed, dataDir, botDir } = mounted({ schedule: 'daily', dailyAt: '04:00' });
    writeFileSync(join(dataDir, STATE_FILE), JSON.stringify({ nextDueAt: Date.now() - 120_000 }));

    await world.start(host);

    expect(pushed.map((event) => event.type)).toEqual(['memory-backup.due']);
    const text = pushed[0].render!();
    expect(text).toContain('该整理记忆了');
    expect(text).toContain('那时应用没开着');
    expect(text).toContain(`记忆目录 ${join(botDir, 'workspace')}:2 个文件`);
    expect(text).toContain('mb_tidy_done');
    await world.stop();
  });

  it('says nothing while it is off', async () => {
    const { world, host, pushed, dataDir } = mounted({ schedule: 'off' });
    writeFileSync(join(dataDir, STATE_FILE), JSON.stringify({ nextDueAt: Date.now() - 120_000 }));

    await world.start(host);

    expect(pushed).toEqual([]);
    expect(JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8')).nextDueAt).toBeNull();
    await world.stop();
  });
});

describe('the tools', () => {
  it('records the tidy and snapshots the data directory in the same call', async () => {
    const { run, backupDir, dataDir, dataRoot } = mounted({ schedule: 'off' });

    const outcome = await run('mb_tidy_done', { note: '合并了笔记' });

    expect(failed(outcome)).toBe(false);
    expect(receiptText(outcome)).toContain('记下这次整理:合并了笔记');
    const snapshots = listSnapshots(backupDir);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].note).toBe('合并了笔记');
    expect(snapshots[0].root).toBe(dataRoot);
    const snapshotPath = join(backupDir, snapshots[0].id);
    expect(existsSync(join(snapshotPath, 'home', 'companion', 'workspace', 'PARTNER.md'))).toBe(true);
    expect(existsSync(join(snapshotPath, 'extensions', 'cortico-world-x', 'package.json'))).toBe(true);
    expect(existsSync(join(snapshotPath, 'logs', 'core.log'))).toBe(true);
    expect(existsSync(join(snapshotPath, 'tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'))).toMatchObject({ lastTidyNote: '合并了笔记' });
    expect(JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8')).lastSnapshot.path).toBe(join(backupDir, snapshots[0].id));
  });

  it('reports the schedule, the last tidy and the snapshots on disk', async () => {
    const { run } = mounted({ schedule: 'interval', intervalMinutes: 60 });
    await run('mb_run', { note: '整理前先留一份' });

    const text = receiptText(await run('mb_status', { limit: 1 }));

    expect(text).toContain('提醒:每隔 60 分钟');
    expect(text).toContain('上次整理:还没有记录');
    expect(text).toContain('磁盘上的备份:');
    expect(text).toContain('整理前先留一份');
    expect(text).not.toContain('还没有备份');
  });

  it('leaves models and runtimes out by default, and copies them when the setting is off', async () => {
    const skipping = mounted({ schedule: 'off' });
    mkdirSync(join(skipping.dataRoot, 'home', 'models', 'asr'), { recursive: true });
    writeFileSync(join(skipping.dataRoot, 'home', 'models', 'asr', 'model.onnx'), 'm');
    await skipping.run('mb_run', {});
    const skipped = listSnapshots(skipping.backupDir)[0];

    expect(existsSync(join(skipping.backupDir, skipped.id, 'home', 'models'))).toBe(false);

    const keeping = mounted({ schedule: 'off', skipModels: false });
    mkdirSync(join(keeping.dataRoot, 'home', 'models', 'asr'), { recursive: true });
    writeFileSync(join(keeping.dataRoot, 'home', 'models', 'asr', 'model.onnx'), 'm');
    await keeping.run('mb_run', {});
    const kept = listSnapshots(keeping.backupDir)[0];

    expect(existsSync(join(keeping.backupDir, kept.id, 'home', 'models', 'asr', 'model.onnx'))).toBe(true);
  });

  it('asks for a note rather than recording an empty tidy', async () => {
    const { run, backupDir } = mounted({ schedule: 'off' });

    const outcome = await run('mb_tidy_done', {});

    expect(failed(outcome)).toBe(true);
    expect(receiptText(outcome)).toContain('note 不能为空');
    expect(listSnapshots(backupDir)).toEqual([]);
  });

  it('fails with the reason when the configured directory is missing', async () => {
    const { run } = mounted({ schedule: 'off', scope: 'custom', customRootDir: '' });

    const outcome = await run('mb_run', {});

    expect(failed(outcome)).toBe(true);
    expect(receiptText(outcome)).toContain('[mb_run 没执行]');
    expect(receiptText(outcome)).toContain('自定义目录是空的');
  });
});

describe('the data directory', () => {
  it('is the directory that holds home, extensions and logs, not the deployment\'s parent', () => {
    const { dataRoot, botDir } = deployment();
    const previous = process.env.CORTICO_EXTENSIONS_DIR;
    process.env.CORTICO_EXTENSIONS_DIR = join(dataRoot, 'extensions');
    try {
      expect(appDataRoot(botDir)).toBe(dataRoot);
    } finally {
      if (previous === undefined) delete process.env.CORTICO_EXTENSIONS_DIR;
      else process.env.CORTICO_EXTENSIONS_DIR = previous;
    }
  });

  it('falls back to the deployment\'s parent outside an app that keeps an extensions directory', () => {
    const { botDir } = deployment();
    const previous = process.env.CORTICO_EXTENSIONS_DIR;
    delete process.env.CORTICO_EXTENSIONS_DIR;
    try {
      expect(appDataRoot(botDir)).toBe(join(botDir, '..'));
    } finally {
      if (previous !== undefined) process.env.CORTICO_EXTENSIONS_DIR = previous;
    }
  });
});

describe('a restore', () => {
  it('shows what it would write, and writes only once confirmed', async () => {
    const { run, botDir, backupDir, dataDir } = mounted({ schedule: 'off' });
    await run('mb_run', {});
    const id = listSnapshots(backupDir)[0].id;
    const workspace = join(botDir, 'workspace');
    writeFileSync(join(workspace, 'later.md'), 'new\n');

    const preview = receiptText(await run('mb_restore', { snapshot: id, target: 'memory' }));

    expect(preview).toContain('这一步会写入');
    expect(preview).toContain('confirm: "restore"');
    expect(existsSync(join(workspace, 'later.md'))).toBe(true);

    const outcome = await run('mb_restore', { snapshot: id, target: 'memory', confirm: 'restore' });

    expect(failed(outcome)).toBe(false);
    expect(receiptText(outcome)).toContain('已回滚');
    expect(readFileSync(join(workspace, 'PARTNER.md'), 'utf8')).toBe('tea\n');
    expect(existsSync(join(workspace, 'later.md'))).toBe(false);
    // the state as it was before the restore is kept as a snapshot of its own
    expect(listSnapshots(backupDir)).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8')).lastRestore).toMatchObject({ from: id, target: 'memory' });
  });

  it('brings each plugin\'s settings back from the snapshot, keeping its own', async () => {
    const { run, botDir, backupDir } = mounted({ schedule: 'off', dailyAt: '21:00' });
    const config = join(botDir, 'config.json');
    const base = JSON.parse(readFileSync(config, 'utf8'));
    base.worlds = {
      terrarium: { enabled: true, tickSec: 10 },
      'memory-backup': { enabled: true, dailyAt: '21:00' },
    };
    writeFileSync(config, JSON.stringify(base, null, 2));
    await run('mb_run', {});
    const id = listSnapshots(backupDir)[0].id;

    base.worlds = {
      terrarium: { enabled: false, tickSec: 99 },
      'memory-backup': { enabled: true, dailyAt: '07:00' },
      extra: { enabled: true },
    };
    writeFileSync(config, JSON.stringify(base, null, 2));

    const outcome = await run('mb_restore', { snapshot: id, target: 'both', confirm: 'restore' });

    expect(failed(outcome)).toBe(false);
    expect(receiptText(outcome)).toContain('设置:1 个插件回到当时的样子');
    const worlds = JSON.parse(readFileSync(config, 'utf8')).worlds;
    expect(worlds.terrarium).toEqual({ enabled: true, tickSec: 10 });
    expect(worlds.extra).toBeUndefined();
    // the tool doing the restoring keeps its own settings, or a rollback could switch itself off
    expect(worlds['memory-backup']).toEqual({ enabled: true, dailyAt: '07:00' });
  });

  it('brings secrets, tokens and plugin state back, but never the conversation store', async () => {
    const { run, botDir, backupDir, dataDir } = mounted({ schedule: 'off' });
    const env = join(botDir, '.env');
    const state = join(botDir, 'data', 'terrarium', 'land', 'state.json');
    const run1 = join(botDir, 'data', 'runs', 'r1', 'events.jsonl');
    const sessions = join(botDir, 'data', 'session-main.jsonl');
    writeFileSync(env, 'TERRARIUM_TOKEN=old\n');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, '{"day":1}');
    mkdirSync(dirname(run1), { recursive: true });
    writeFileSync(run1, '{"cursor":1}\n');
    writeFileSync(sessions, 'old\n');
    await run('mb_run', {});
    const id = listSnapshots(backupDir)[0].id;

    writeFileSync(env, 'TERRARIUM_TOKEN=new\n');
    writeFileSync(state, '{"day":9}');
    writeFileSync(run1, '{"cursor":999}\n');
    writeFileSync(sessions, 'new\n');

    const outcome = await run('mb_restore', { snapshot: id, target: 'both', confirm: 'restore' });

    expect(failed(outcome)).toBe(false);
    expect(readFileSync(env, 'utf8')).toBe('TERRARIUM_TOKEN=old\n');
    expect(readFileSync(state, 'utf8')).toBe('{"day":1}');
    // in use, and not content to bring back
    expect(readFileSync(run1, 'utf8')).toBe('{"cursor":999}\n');
    expect(readFileSync(sessions, 'utf8')).toBe('new\n');
    // this World's own record survives, or it would forget the restore it just did
    expect(JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8')).lastRestore).toMatchObject({ from: id });
  });

  it('restores a snapshot carried over from another machine into this layout', async () => {
    const { run, botDir, backupDir } = mounted({ schedule: 'off' });
    await run('mb_run', {});
    const snapshot = listSnapshots(backupDir)[0];
    const manifestFile = join(backupDir, snapshot.id, MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, root: join(botDir, '..', '..', 'other-machine', 'data') }));
    const workspace = join(botDir, 'workspace');
    writeFileSync(join(workspace, 'later.md'), 'new\n');

    const preview = receiptText(await run('mb_restore', { snapshot: snapshot.id, target: 'memory' }));
    expect(preview).toContain('按这里的布局写入');

    const outcome = await run('mb_restore', { snapshot: snapshot.id, target: 'memory', confirm: 'restore' });

    expect(failed(outcome)).toBe(false);
    expect(existsSync(join(workspace, 'later.md'))).toBe(false);
    expect(readFileSync(join(workspace, 'PARTNER.md'), 'utf8')).toBe('tea\n');
  });

  it('names the snapshots it has when asked for one it does not', async () => {
    const { run } = mounted({ schedule: 'off' });

    const outcome = await run('mb_restore', { snapshot: 'nope' });

    expect(failed(outcome)).toBe(true);
    expect(receiptText(outcome)).toContain('没有 nope 这份快照');
  });
});

describe('the environment section', () => {
  it('gives the prompt the Memory it should tidy, the schedule and where snapshots go', async () => {
    const { world, run, backupDir, botDir } = mounted({ schedule: 'daily' });
    await run('mb_run', {});

    const vars = world.envPromptVars() as Record<string, string>;

    expect(vars['mb.summary']).toContain(`记忆目录 ${join(botDir, 'workspace')}:2 个文件`);
    expect(vars['mb.next']).toMatch(/^下一次提醒:\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(vars['mb.location']).toBe(backupDir);
    const doc = world.webUi!('zh').promptDocs![0];
    expect(doc.role).toBe('envPrompt');
    expect(Object.keys(vars).sort()).toEqual(doc.vars!.map((v) => v.name).sort());
  });
});
