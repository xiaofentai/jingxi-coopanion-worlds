/**
 * The World: a reminder on a clock, three tools, an environment section and one storage entry.
 *
 * The reminder reports facts — how large the Memory is, when it was last tidied, when it was last
 * copied — and leaves the tidying to the bot's own file tools. The copy runs inside the tool call
 * the bot makes when it is done, which is also the moment the bot writes nothing of its own.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { StoragePart, ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import {
  clearSnapshots, listSnapshots, readManifest, restoreSnapshot, takeSnapshot,
  type SnapshotManifest, type SnapshotResult,
} from './backup.ts';
import { MEMORY_BACKUP_DEFAULTS, MEMORY_BACKUP_ID, memoryBackupConfigGroup, type MemoryBackupConfigSection } from './config.ts';
import { formatBytes, formatDuration } from './format.ts';
import { APP_DATA_ENTRIES, MEMORY_BACKUP_PACKAGE, appDataRoot, defaultBackupDir, isAppDataDir } from './paths.ts';
import { mergeWorlds, planWorlds, type WorldsMerge } from './settings.ts';
import { localLabel, nextDaily, parseClock } from './schedule.ts';
import { readState, writeState, STATE_FILE, type MemoryBackupState, type SnapshotRecord } from './state.ts';
import { PROMPT_VARS, memoryBackupText, textLanguage, type TextLanguage } from './text.ts';

/** How often the clock is compared with the due time; the reminder is never late by more than this. */
const TICK_MS = 30_000;
/** A due time this far in the past was missed while the app was closed. */
const MISSED_AFTER_MS = 60_000;
/** Files counted for the reminder before the walk stops. */
const COUNT_CAP = 20_000;
/** Core's supervisor watches for this file in the deployment's data directory and starts Core again. */
const RESTART_MARKER = '.restart-request';
/** How long Core keeps running after mb_restart, so the receipt reaches the person before the process goes. */
const RESTART_DELAY_MS = 8_000;

/** Windows compares paths without case; a snapshot's root has to match the live one. */
const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

const ENV_PROMPT_FILES: Record<TextLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

/** Every tool this World can offer; `tools()` binds the handlers. */
export const MEMORY_BACKUP_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'mb_status',
    description: 'Report when the next reminder is due, when the Memory was last tidied, when it was last copied, and the snapshots on disk. Reads only.',
    tags: ['read', 'snapshot'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'How many of the newest snapshots to list; 5 when left out.',
        },
      },
    },
  },
  {
    name: 'mb_run',
    description: 'Copy the configured directory into a new dated snapshot now, without recording a Memory tidy. Returns the snapshot path, file count, size and how many older snapshots were deleted. The copy takes seconds to minutes and runs inside this call, so nothing written meanwhile lands in it.',
    tags: ['write', 'snapshot'],
    barrierAfter: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: {
          type: 'string',
          maxLength: 500,
          description: 'One line kept with this snapshot, for the person and for your own later reading.',
        },
      },
    },
  },
  {
    name: 'mb_tidy_done',
    description: 'Record that you finished tidying the Memory, with what you changed, and copy the configured directory in the same call. Call it after rewriting, merging or deleting Memory files, not before.',
    tags: ['write', 'snapshot'],
    barrierAfter: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: {
          type: 'string',
          maxLength: 500,
          description: 'One or two sentences on what changed: what you merged, rewrote or deleted.',
        },
      },
      required: ['note'],
    },
  },
  {
    name: 'mb_restore',
    description: 'Write a snapshot back over the Memory, the extension packages, their settings and their credentials. Without confirm: "restore" it only reports what the snapshot holds and what would be replaced, and changes nothing. With it, the state as it is now is snapshotted first, then the files are written; the running app keeps its loaded state until Core restarts, so tell the person. Memory is restored whole (files the snapshot does not hold are deleted, its Git history stays). Extensions come back with their dependencies under each package, with nothing deleted; each plugin\'s settings in config.json, its secrets in .env and its state under data/ come back too, except this World\'s own package, its own settings and its own state. The conversation store (data/runs), the session and usage logs (*.jsonl) and whatever an online plugin keeps on its server are outside this.',
    tags: ['write'],
    barrierAfter: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        snapshot: {
          type: 'string',
          description: 'A snapshot id from mb_status, or the absolute path of a snapshot folder.',
        },
        target: {
          type: 'string',
          enum: ['memory', 'extensions', 'both'],
          description: 'What to write back; both when left out.',
        },
        confirm: {
          type: 'string',
          description: 'Exactly "restore" to carry it out. Leave it out for the preview; nothing is written then.',
        },
      },
      required: ['snapshot'],
    },
  },
  {
    name: 'mb_restart',
    description: 'Restart Core so that restored files, and extensions installed or removed meanwhile, take effect. The pet disconnects for a few seconds and comes back. Only when the app runs under its supervisor, and only after asking the person.',
    tags: ['act'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export interface MemoryBackupWorldOptions {
  /** `worlds.memory-backup`, read at each use. */
  cfg: MemoryBackupConfigSection;
  timezone: string;
  /** The deployment directory. */
  botDir: string;
  /** The deployment's data directory: the run's record sits here. */
  dataDir: string;
  /** The directory the app writes: `home/`, `extensions/` and `logs/`; `appDataRoot(botDir)` when absent. */
  dataRoot?: string;
}

/** One side of a restore: the paths taken from the snapshot, and what to leave alone. */
interface RestoreTarget {
  kind: 'memory' | 'extensions';
  /** Paths relative to the data directory, so another machine's layout does not matter. */
  entries: string[];
  keep: string[];
  keepInside: string[];
  skipSuffix: string[];
  mirror: boolean;
}

export class MemoryBackupWorld implements World {
  readonly id = MEMORY_BACKUP_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: MemoryBackupState;
  private copying = false;
  private languageCache: { at: number; value: Language } | null = null;

  constructor(private readonly opts: MemoryBackupWorldOptions) {
    this.state = readState(this.stateFile);
  }

  private get cfg(): MemoryBackupConfigSection {
    return this.opts.cfg;
  }

  private get t() {
    return memoryBackupText(this.language);
  }

  private get stateFile(): string {
    return join(this.opts.dataDir, STATE_FILE);
  }

  /** The app language `config.json` has, read again when that file changes. */
  private get language(): Language {
    let at = 0;
    try {
      at = statSync(join(this.opts.botDir, 'config.json')).mtimeMs;
    } catch { /* seeded Chinese */ }
    if (this.languageCache?.at !== at) {
      let value: Language = 'zh';
      try {
        const raw = JSON.parse(readFileSync(join(this.opts.botDir, 'config.json'), 'utf8')) as { language?: unknown };
        if (isLanguage(raw.language)) value = raw.language;
      } catch { /* seeded Chinese */ }
      this.languageCache = { at, value };
    }
    return this.languageCache.value;
  }

  envPromptVars(): Record<string, string> {
    const t = this.t;
    const memoryDir = this.memoryDir();
    const stats = countFiles(memoryDir);
    return {
      'mb.summary': [
        stats ? t.summary.memory(memoryDir, stats.files, formatBytes(stats.bytes)) : t.summary.memoryMissing(memoryDir),
        t.summary.lastTidy(this.when(this.state.lastTidyAt)),
        t.summary.lastSnapshot(this.when(this.state.lastSnapshot?.at ?? null), this.state.lastSnapshot?.path ?? null),
      ].join('\n'),
      'mb.next': t.summary.nextDue(this.state.nextDueAt === null ? null : localLabel(this.opts.timezone, this.state.nextDueAt)),
      'mb.scope': this.scopeLabel(),
      'mb.location': this.locationText(),
    };
  }

  tools(): ToolDef[] {
    return MEMORY_BACKUP_TOOL_DECLS.map((decl) => ({ ...decl, handler: (args, ctx) => this.run(decl.name, args, ctx) }));
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = memoryBackupText(language);
    const chosen = ENV_PROMPT_FILES[textLanguage(this.language)];
    return {
      label: t.label,
      config: [memoryBackupConfigGroup(language)],
      promptDocs: [{
        key: `worlds.${MEMORY_BACKUP_ID}.envPrompt`,
        title: t.envPrompt.title,
        description: t.envPrompt.description,
        path: existsSync(chosen) ? chosen : ENV_PROMPT_FILES.zh,
        role: 'envPrompt',
        vars: PROMPT_VARS.map((name) => ({
          name,
          description: t.envPrompt.vars[name],
          ...(name === 'mb.summary' ? { multiline: true } : {}),
        })),
      }],
      storage: [this.storagePart(language)],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.state = readState(this.stateFile);
    if (this.cfg.schedule !== 'off' && this.state.nextDueAt === null) {
      this.state.nextDueAt = this.nextDueAfter(Date.now());
      this.save();
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    // a due time that passed while the app was closed is delivered at once
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host = null;
  }

  /** The directory a snapshot copies, and the entries taken from it when it also holds caches. */
  private plan(): { root: string; only: readonly string[] | null } {
    if (this.cfg.scope === 'custom') {
      const custom = this.cfg.customRootDir.trim();
      if (!custom) throw new Error(this.t.tools.customRootMissing);
      return { root: resolve(custom), only: null };
    }
    if (this.cfg.scope === 'deployment') return { root: resolve(this.opts.botDir), only: null };
    // the data directory: `home/` (Memory, conversations, settings, keys, models), `extensions/`, `logs/`
    const root = this.opts.dataRoot ?? appDataRoot(this.opts.botDir);
    return { root, only: isAppDataDir(root) ? APP_DATA_ENTRIES : null };
  }

  /** Models and runtimes sit at different depths depending on where the copied directory starts. */
  private skipDirs(root: string): string[] {
    if (!this.cfg.skipModels) return [];
    return [join(root, 'models'), join(root, 'runtimes'), join(root, 'home', 'models'), join(root, 'home', 'runtimes')];
  }

  private backupDirFor(): string {
    const configured = this.cfg.backupDir.trim();
    return configured ? resolve(configured) : defaultBackupDir();
  }

  private locationOrNull(): string | null {
    try {
      this.plan();
      return this.backupDirFor();
    } catch {
      return null;
    }
  }

  private memoryDir(): string {
    const configured = this.cfg.memoryDir.trim() || MEMORY_BACKUP_DEFAULTS.memoryDir;
    return isAbsolute(configured) ? configured : resolve(this.opts.botDir, configured);
  }

  private when(at: number | null): string | null {
    return at === null ? null : localLabel(this.opts.timezone, at);
  }

  private scopeLabel(): string {
    const t = this.t;
    try {
      const { root } = this.plan();
      if (this.cfg.scope === 'data') return t.tools.scope.data(root);
      if (this.cfg.scope === 'deployment') return t.tools.scope.deployment(root);
      return t.tools.scope.custom(root);
    } catch {
      return this.cfg.scope === 'custom' ? t.tools.customRootMissing : t.tools.scopeUnset;
    }
  }

  private locationText(): string {
    return this.locationOrNull() ?? this.t.tools.locationUnset;
  }

  private scheduleLine(): string {
    const cfg = this.cfg;
    return this.t.summary.schedule(cfg.schedule, cfg.schedule === 'interval' ? String(cfg.intervalMinutes) : cfg.dailyAt);
  }

  private nextDueAfter(now: number): number | null {
    const cfg = this.cfg;
    if (cfg.schedule === 'off') return null;
    if (cfg.schedule === 'interval') return now + Math.max(1, cfg.intervalMinutes) * 60_000;
    const clock = parseClock(cfg.dailyAt) ?? parseClock(MEMORY_BACKUP_DEFAULTS.dailyAt) ?? { hour: 21, minute: 0 };
    return nextDaily(now, this.opts.timezone, clock.hour, clock.minute);
  }

  private save(): void {
    try {
      writeState(this.stateFile, this.state);
    } catch (error) {
      console.warn('[memory-backup] could not save the record', this.stateFile, error);
    }
  }

  private tick(): void {
    const host = this.host;
    if (!host) return;
    const now = Date.now();
    if (this.cfg.schedule === 'off') {
      if (this.state.nextDueAt !== null) {
        this.state.nextDueAt = null;
        this.save();
      }
      return;
    }
    const due = this.state.nextDueAt;
    if (due === null) {
      this.state.nextDueAt = this.nextDueAfter(now);
      this.save();
      return;
    }
    if (due > now) return;
    this.state.nextDueAt = this.nextDueAfter(now);
    this.save();
    host.pushDeferred({ type: 'memory-backup.due', origin: 'internal', render: () => this.dueText(due) }, { trigger: 'flush' });
  }

  private dueText(planned: number): string {
    const t = this.t;
    const memoryDir = this.memoryDir();
    const stats = countFiles(memoryDir);
    const facts = [
      stats ? t.summary.memory(memoryDir, stats.files, formatBytes(stats.bytes)) : t.summary.memoryMissing(memoryDir),
      t.summary.lastTidy(this.when(this.state.lastTidyAt)),
      t.summary.lastSnapshot(this.when(this.state.lastSnapshot?.at ?? null), this.state.lastSnapshot?.path ?? null),
    ];
    return [
      t.due.head(localLabel(this.opts.timezone, planned), Date.now() - planned > MISSED_AFTER_MS),
      ...facts,
      t.due.ask(this.scopeLabel(), this.locationText()),
    ].join('\n');
  }

  private async run(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<string | ToolOutcome> {
    if (name === 'mb_status') return this.status(args);
    if (name === 'mb_run' || name === 'mb_tidy_done') return this.snapshot(name, args, ctx);
    if (name === 'mb_restore') return this.restore(args, ctx);
    if (name === 'mb_restart') return this.restart();
    return { text: this.t.tools.failed(name, this.t.tools.unknown), failed: true };
  }

  private status(args: Record<string, unknown>): string {
    const t = this.t;
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.min(50, Math.max(1, Math.round(args.limit)))
      : 5;
    const memoryDir = this.memoryDir();
    const stats = countFiles(memoryDir);
    const lines = [
      stats ? t.summary.memory(memoryDir, stats.files, formatBytes(stats.bytes)) : t.summary.memoryMissing(memoryDir),
      t.summary.lastTidy(this.when(this.state.lastTidyAt)),
      t.summary.lastSnapshot(this.when(this.state.lastSnapshot?.at ?? null), this.state.lastSnapshot?.path ?? null),
      t.summary.lastRestore(this.when(this.state.lastRestore?.at ?? null), this.state.lastRestore?.from ?? null),
      t.summary.nextDue(this.state.nextDueAt === null ? null : localLabel(this.opts.timezone, this.state.nextDueAt)),
      this.scheduleLine(),
      this.scopeLabel(),
      this.locationText(),
    ];
    const dir = this.locationOrNull();
    const snapshots = dir ? listSnapshots(dir) : [];
    if (snapshots.length) {
      lines.push(t.tools.listHead);
      for (const snapshot of snapshots.slice(0, limit)) {
        lines.push(t.tools.listLine(snapshot.id, localLabel(this.opts.timezone, snapshot.at), snapshot.files, formatBytes(snapshot.bytes), snapshot.note));
      }
    } else {
      lines.push(t.tools.none);
    }
    return lines.join('\n');
  }

  private async snapshot(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const t = this.t;
    if (this.copying) return { text: t.tools.busy, failed: true };
    this.copying = true;
    try {
      const plan = this.plan();
      const backupDir = this.backupDirFor();
      const note = typeof args.note === 'string' ? args.note.trim().slice(0, 500) : '';
      if (name === 'mb_tidy_done' && !note) return { text: t.tools.failed(name, t.tools.noteMissing), failed: true };
      const started = Date.now();
      const result = await takeSnapshot({
        root: plan.root,
        backupDir,
        timezone: this.opts.timezone,
        maxBackups: this.cfg.maxBackups,
        skipDirs: this.skipDirs(plan.root),
        ...(plan.only ? { only: plan.only } : {}),
        note,
        signal: ctx.signal,
      });
      this.record(name === 'mb_tidy_done' ? note : null, result);
      const lines = [
        name === 'mb_tidy_done' ? t.tools.tidy(note) : '',
        t.tools.done(result.path, result.manifest.files, formatBytes(result.manifest.bytes), formatDuration(Date.now() - started, textLanguage(this.language))),
        result.removed.length ? t.tools.removed(result.removed.length) : '',
        result.manifest.repaired.length ? t.tools.repaired(result.manifest.repaired.length) : '',
        result.manifest.changed.length ? t.tools.changed(result.manifest.changed.length) : '',
        result.manifest.failed.length ? t.tools.heldOpen(result.manifest.failed.length) : '',
        result.manifest.linked.length ? t.tools.linked(result.manifest.linked.length) : '',
      ];
      return { text: lines.filter(Boolean).join('\n') };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: t.tools.failed(name, t.tools.copyFailed(reason)), failed: true };
    } finally {
      this.copying = false;
    }
  }

  private record(tidyNote: string | null, result: SnapshotResult): void {
    const snapshot: SnapshotRecord = {
      id: result.manifest.id,
      at: result.manifest.at,
      path: result.path,
      files: result.manifest.files,
      bytes: result.manifest.bytes,
    };
    this.state.lastSnapshot = snapshot;
    if (tidyNote !== null) {
      this.state.lastTidyAt = result.manifest.at;
      this.state.lastTidyNote = tidyNote;
    }
    // the next reminder counts from this copy, so a tidied Memory is not asked for again at once
    this.state.nextDueAt = this.nextDueAfter(Date.now());
    this.save();
  }

  /* ---------- restore ---------- */

  private dataRoot(): string {
    return this.opts.dataRoot ?? appDataRoot(this.opts.botDir);
  }

  private extensionsDir(): string {
    return join(this.dataRoot(), 'extensions');
  }

  /** A snapshot id from the list, or a folder path; null when neither names a folder. */
  private resolveSnapshot(value: string): string | null {
    const asked = value.trim();
    if (!asked) return null;
    if (isAbsolute(asked)) return existsSync(asked) ? resolve(asked) : null;
    const dir = this.locationOrNull();
    if (!dir) return null;
    const path = join(dir, asked);
    return existsSync(path) ? resolve(path) : null;
  }

  /**
   * What each target writes, as paths relative to this installation's data directory, so a snapshot
   * taken on another machine — where that directory had a different path — restores into the same
   * places here. `entries` is empty when the snapshot holds none of them.
   */
  private restoreTargets(snapshot: string, target: 'memory' | 'extensions' | 'both'): RestoreTarget[] {
    const root = this.dataRoot();
    const wanted = (path: string): string | null => {
      const rel = relative(root, path);
      return rel && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(join(snapshot, rel)) ? rel : null;
    };
    const kinds = target === 'both' ? ['memory', 'extensions'] as const : [target] as const;
    return kinds.map((kind) => {
      if (kind === 'memory') {
        const live = this.memoryDir();
        const one = wanted(live);
        return {
          kind,
          entries: one ? [one] : [],
          keep: [],
          // the workspace's Git history is neither written over nor deleted: the restore is a change to commit
          keepInside: [join(live, '.git')],
          skipSuffix: [],
          mirror: true,
        };
      }
      const deployment = this.opts.botDir;
      const data = join(deployment, 'data');
      const entries = [this.extensionsDir(), join(deployment, '.env'), data]
        .map(wanted)
        .filter((value): value is string => value !== null);
      return {
        kind,
        entries,
        // this package is running the restore, and its state file is the record of it
        keep: [join(this.extensionsDir(), 'node_modules', MEMORY_BACKUP_PACKAGE), join(data, 'memory-backup.json')],
        // the conversation store and the instance lock are in use, not content to bring back
        keepInside: [join(data, 'runs'), join(data, 'instance.lock')],
        skipSuffix: ['.jsonl'],
        mirror: false,
      };
    });
  }

  private restorePreview(
    manifest: SnapshotManifest,
    targets: RestoreTarget[],
    elsewhere: string,
    settings: WorldsMerge | null,
  ): string {
    const t = this.t;
    const lines = [t.restore.preview(
      manifest.id,
      localLabel(this.opts.timezone, manifest.at),
      manifest.note,
      manifest.files,
      formatBytes(manifest.bytes),
    )];
    for (const target of targets) {
      const label = t.restore.targets[target.kind];
      lines.push(target.entries.length
        ? t.restore.willWrite(label, target.kind === 'memory' ? t.restore.what.mirror : t.restore.what.overwrite)
        : t.restore.missing(label));
    }
    if (targets.some((target) => target.kind === 'extensions' && target.entries.length)) lines.push(t.restore.extras);
    if (settings?.applicable) lines.push(t.restore.settings(settings.restored.length, settings.removed.length));
    if (elsewhere) lines.push(elsewhere);
    lines.push(t.restore.memoryMirror, t.restore.confirmHint);
    return lines.join('\n');
  }

  /** The live and snapshot copies of the deployment's `config.json`, when the snapshot holds one. */
  private configFiles(snapshot: string): { live: string; from: string } | null {
    const live = join(this.opts.botDir, 'config.json');
    const entry = relative(this.dataRoot(), live);
    if (!entry || entry.startsWith('..') || isAbsolute(entry)) return null;
    const from = join(snapshot, entry);
    return existsSync(from) ? { live, from } : null;
  }

  private async restore(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const t = this.t;
    const asked = typeof args.snapshot === 'string' ? args.snapshot.trim() : '';
    const snapshot = this.resolveSnapshot(asked);
    if (!snapshot) return { text: t.tools.failed('mb_restore', t.restore.unknown(asked || '(empty)')), failed: true };
    const manifest = readManifest(snapshot);
    if (!manifest) return { text: t.tools.failed('mb_restore', t.restore.notASnapshot(snapshot)), failed: true };
    const current = this.dataRoot();
    // another machine, or the same one after the data directory moved: the layout is what counts
    const elsewhere = !samePath(manifest.root, current) && !samePath(manifest.root, resolve(this.opts.botDir))
      ? t.restore.fromElsewhere(manifest.root, current)
      : '';

    const target = args.target === 'memory' || args.target === 'extensions' ? args.target : 'both';
    const targets = this.restoreTargets(snapshot, target);
    // settings belong to the plugins, so they come back with the extension packages, never with the Memory alone
    const config = target === 'memory' ? null : this.configFiles(snapshot);
    const settings = config ? planWorlds(config.live, config.from, [MEMORY_BACKUP_ID]) : null;
    if (args.confirm !== 'restore') return { text: this.restorePreview(manifest, targets, elsewhere, settings) };
    if (!targets.some((entry) => entry.entries.length)) {
      return { text: t.tools.failed('mb_restore', t.restore.missing(t.restore.targets[target])), failed: true };
    }

    // the state as it is now, saved before anything is written; a failure here means nothing is touched
    const safety = await this.safetySnapshot(manifest.id, ctx);
    if (!safety) return { text: t.tools.failed('mb_restore', t.restore.safetyFailed), failed: true };

    const totals = { files: 0, bytes: 0, removed: 0, failed: [] as string[] };
    try {
      for (const entry of targets) {
        if (!entry.entries.length) continue;
        const result = await restoreSnapshot({
          snapshot,
          root: current,
          entries: entry.entries,
          keep: entry.keep,
          keepInside: entry.keepInside,
          skipSuffix: entry.skipSuffix,
          mirror: entry.mirror,
          signal: ctx.signal,
        });
        totals.files += result.files;
        totals.bytes += result.bytes;
        totals.removed += result.removed;
        totals.failed.push(...result.failed);
      }
      if (config && settings?.applicable) mergeWorlds(config.live, config.from, [MEMORY_BACKUP_ID]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: t.tools.failed('mb_restore', t.tools.copyFailed(reason)), failed: true };
    }

    this.state.lastRestore = {
      at: Date.now(),
      from: manifest.id,
      target,
      files: totals.files,
      safety,
    };
    this.save();

    const lines = [
      t.restore.done(totals.files, formatBytes(totals.bytes), totals.removed, safety),
      settings?.applicable ? t.restore.settings(settings.restored.length, settings.removed.length) : '',
      elsewhere,
      totals.failed.length ? t.restore.partial(totals.failed.length) : '',
      t.restore.online,
      t.restore.restartHint,
      ...(totals.failed.length ? ['', ...totals.failed.slice(0, 10)] : []),
    ];
    return { text: lines.filter(Boolean).join('\n') };
  }

  /** A snapshot of the live state, taken before a restore; null when it could not be written. */
  private async safetySnapshot(from: string, ctx: ToolCallContext): Promise<string | null> {
    try {
      const plan = this.plan();
      const result = await takeSnapshot({
        root: plan.root,
        backupDir: this.backupDirFor(),
        timezone: this.opts.timezone,
        maxBackups: this.cfg.maxBackups,
        skipDirs: this.skipDirs(plan.root),
        ...(plan.only ? { only: plan.only } : {}),
        note: `before restore from ${from}`,
        signal: ctx.signal,
      });
      return result.path;
    } catch (error) {
      console.warn('[memory-backup] safety snapshot failed', error);
      return null;
    }
  }

  /** Asks the app's supervisor for a new Core. Core exits on its own after the receipt has had time to land. */
  private restart(): ToolOutcome {
    const t = this.t;
    if (process.env.CORTICO_SUPERVISED !== '1') {
      return { text: t.tools.failed('mb_restart', t.restore.unsupervised), failed: true };
    }
    try {
      writeFileSync(join(this.opts.dataDir, RESTART_MARKER), '');
    } catch (error) {
      return { text: t.tools.failed('mb_restart', error instanceof Error ? error.message : String(error)), failed: true };
    }
    setTimeout(() => process.exit(0), RESTART_DELAY_MS).unref();
    return { text: t.restore.restarting };
  }

  private storagePart(language: Language): StoragePart {
    const t = memoryBackupText(language);
    return {
      key: MEMORY_BACKUP_ID,
      label: t.storage.label,
      kind: 'disk',
      location: this.locationText(),
      danger: true,
      note: t.storage.note,
      stat: () => {
        const dir = this.locationOrNull();
        if (!dir) return t.storage.empty;
        const snapshots = listSnapshots(dir);
        return snapshots.length
          ? t.storage.stat(snapshots.length, formatBytes(snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0)))
          : t.storage.empty;
      },
      clear: () => {
        const dir = this.locationOrNull();
        if (!dir) return t.storage.cleared(0);
        return t.storage.cleared(clearSnapshots(dir).count);
      },
    };
  }
}

/** Files and bytes under `dir`, `.git` left out; null when the directory is not there. */
function countFiles(dir: string, cap = COUNT_CAP): { files: number; bytes: number } | null {
  if (!existsSync(dir)) return null;
  let files = 0;
  let bytes = 0;
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= cap) return;
      if (entry.name === '.git') continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      try {
        bytes += statSync(path).size;
      } catch { /* removed while counting */ }
    }
  };
  walk(dir);
  return { files, bytes };
}
