/**
 * ledger 的设置存在 `config.json` 的 `worlds.memory-ledger.settings` 段里。
 *
 * 为什么不另开一份文件：配置页只声明 enabled，平台不会清理没声明的字段（真机上旧规则槽
 * 一直留着），所以设置直接写回同一个文件的自己那一段即可。这样用户在设置页改完，下次启动
 * 读的是同一份，不会回退；预激活、出卡、工具也都读这一处，不再有第二套判据。
 *
 * 首次运行时用配置里的同名键 / 旧规则槽做初值，之后以 settings 段为准。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRules } from './board.ts';
import {
  DEFAULT_ARCHIVE_FILE, DEFAULT_PAST_FILE, DEFAULT_TODAY_FILE, MEMORY_LEDGER_ID,
  rulesText as legacyRulesText, type MemoryLedgerConfigSection,
} from './config.ts';

export const SETTINGS_KEY = 'settings';

/** 顺序就是设置页的卡片顺序：大事记 / 近期 / 超近期。 */
export const LEDGER_RULE_FILES = ['大事记.md', '近期.md', '超近期.md'] as const;

export interface LedgerRule {
  /** 相对记忆目录的路径；面板可改，默认是可读的文件名。 */
  file: string;
  /** 保留天数。0 = 不设窗口。 */
  days: number;
  /** 条目上限。0 = 不限。 */
  cap: number;
  /** 归档目标；可用 `{{YYYY}}` / `{{MM}}` / `{{YYYY-MM}}` / `{{YYYY-MM-DD}}`。空 = 不归档。 */
  archive: string;
}

export interface LedgerSettings {
  folder: string;
  recallOnSpeak: boolean;
  preactivate: boolean;
  preactivatePerDay: number;
  gameRoute: boolean;
  rules: LedgerRule[];
}

const DEFAULT_RULES: readonly LedgerRule[] = [
  { file: '大事记.md', days: 3650, cap: 80, archive: DEFAULT_ARCHIVE_FILE },
  { file: '近期.md', days: 21, cap: 0, archive: 'archive/近期-{{YYYY-MM}}.md' },
  { file: '超近期.md', days: 4, cap: 0, archive: '' },
];

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, raw));
};

const clampText = (value: unknown, fallback: string, max = 240): string => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
};

const clampBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/**
 * 归档目标只能落在 `archive/` 下：设置页填文件名（可带 {{YYYY-MM}}），
 * 老配置里的 `archive/x.md` 原样留，别处的路径只取文件名接回 archive/。
 * 空串表示这份不归档（超近期）。
 */
function normalizeArchive(raw: string): string {
  const value = raw.trim().replaceAll('\\', '/').slice(0, 240);
  if (!value) return '';
  const name = value.split('/').filter(Boolean).pop() ?? '';
  if (!name) return '';
  return `archive/${name}`;
}

/** 面板提交什么都按这个过一遍；三张卡的顺序固定。 */
export function clampSettings(value: Partial<LedgerSettings> | null | undefined, fallback: LedgerSettings): LedgerSettings {
  const incoming = Array.isArray(value?.rules) ? value!.rules : [];
  return {
    folder: clampText(value?.folder, fallback.folder, 400),
    recallOnSpeak: clampBool(value?.recallOnSpeak, fallback.recallOnSpeak),
    preactivate: clampBool(value?.preactivate, fallback.preactivate),
    preactivatePerDay: clampInt(value?.preactivatePerDay, fallback.preactivatePerDay, 0, 20),
    gameRoute: clampBool(value?.gameRoute, fallback.gameRoute),
    rules: fallback.rules.map((base, index) => {
      const raw = (incoming[index] ?? {}) as Partial<LedgerRule>;
      return {
        file: clampText(raw.file, base.file),
        days: clampInt(raw.days, base.days, 0, 3650),
        cap: clampInt(raw.cap, base.cap, 0, 10000),
        // 归档只允许填文件名，目录固定 `archive/`——设置页改不了路径。
        // 传进来的若已是 `archive/x.md` 就原样留；若是别处的路径，只取文件名接回 archive/。
        archive: normalizeArchive(typeof raw.archive === 'string' ? raw.archive : base.archive),
      };
    }),
  };
}

/** 旧配置迁移：三张卡的默认值 + config.json 里的文件槽 / 开关 / 旧 catalog 规则。 */
export function seedSettings(cfg: MemoryLedgerConfigSection): LedgerSettings {
  const rules = DEFAULT_RULES.map((rule) => ({ ...rule }));
  // 超近期、近期这两个文件槽是宿主里已有的参数，先接上
  rules[2]!.file = String(cfg.todayFile ?? '').trim() || rules[2]!.file;
  rules[1]!.file = String(cfg.pastFile ?? '').trim() || rules[1]!.file;
  rules[0]!.archive = String(cfg.archiveFile ?? '').trim() || rules[0]!.archive;

  let legacy: ReturnType<typeof parseRules>['rules'] = [];
  try {
    legacy = parseRules(legacyRulesText(cfg)).rules.filter((rule) => rule.mode === 'catalog');
  } catch {
    // 坏规则不该让 World 起不来；已有默认值继续用
  }
  rules.forEach((rule, index) => {
    const defaultFile = DEFAULT_RULES[index]?.file;
    // 当前文件名精确命中才改 file；只按默认文件名命中时只搬天数 / 上限，保住用户改过的文件名
    const exact = legacy.find((item) => item.path.replaceAll('\\', '/') === rule.file);
    const found = exact ?? legacy.find((item) => item.path.replaceAll('\\', '/') === defaultFile);
    if (!found) return;
    if (exact) rule.file = exact.path.replaceAll('\\', '/');
    const days = Number.parseInt(found.arg.trim(), 10);
    if (Number.isFinite(days) && days > 0) rule.days = days;
    if (found.maxChars > 0) rule.cap = found.maxChars;
  });

  return clampSettings({
    folder: String(cfg.folder ?? '').trim() || 'workspace',
    recallOnSpeak: cfg.recallOnSpeak === true,
    preactivate: cfg.preactivate === true,
    preactivatePerDay: clampInt(cfg.preactivatePerDay, 6, 0, 20),
    gameRoute: cfg.gameRoute === true,
    rules,
  }, {
    folder: 'workspace', recallOnSpeak: false, preactivate: false,
    preactivatePerDay: 6, gameRoute: false, rules: DEFAULT_RULES.map((rule) => ({ ...rule })),
  });
}

export function rulesText(settings: LedgerSettings): string {
  return settings.rules
    .map((rule) => `${rule.file}|catalog|${rule.days}|${rule.cap > 0 ? rule.cap : ''}`)
    .join('; ');
}

/** 归档文件名里的参数替代符：落到具体某一天时展开。 */
export function fillArchiveTemplate(template: string, date: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : (date || '').slice(0, 10);
  const month = day.slice(0, 7) || 'YYYY-MM';
  return template
    .replaceAll('{{YYYY-MM-DD}}', day)
    .replaceAll('{{YYYY-MM}}', month)
    .replaceAll('{{YYYY}}', month.slice(0, 4))
    .replaceAll('{{MM}}', month.slice(5));
}

/** 某份记忆默认归档到哪；按来源文件和那一天展开。 */
export function archiveFor(settings: LedgerSettings, file: string, date: string): string {
  const found = settings.rules.find((rule) => rule.file === file);
  return found ? fillArchiveTemplate(found.archive, date) : '';
}

/** 兼容原来「三层文件」的取值处：都由三张卡推导，不再单独存一份。 */
export const todayFileOf = (settings: LedgerSettings): string =>
  settings.rules[2]?.file || DEFAULT_TODAY_FILE;
export const pastFileOf = (settings: LedgerSettings): string =>
  settings.rules[1]?.file || DEFAULT_PAST_FILE;
export const archiveFileOf = (settings: LedgerSettings): string =>
  settings.rules[0]?.archive || DEFAULT_ARCHIVE_FILE;

export function readSettings(botDir: string, cfg: MemoryLedgerConfigSection): LedgerSettings {
  const seed = seedSettings(cfg);
  const file = join(botDir, 'config.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return seed;
  }
  const worlds = raw?.worlds as Record<string, unknown> | undefined;
  const section = worlds?.[MEMORY_LEDGER_ID] as Record<string, unknown> | undefined;
  const stored = section?.[SETTINGS_KEY];
  if (!stored || typeof stored !== 'object') return seed;
  try {
    return clampSettings(stored as Partial<LedgerSettings>, seed);
  } catch {
    return seed;
  }
}

/**
 * 整份读 config.json，只改 `worlds.memory-ledger.settings`，其余键一个不动。
 *
 * 写临时文件再改名：中途崩了不会留下半份配置。配置页那个 enabled 开关也在这份文件里，
 * 我们只碰自己那一段，不动它。
 */
export function writeSettings(botDir: string, settings: LedgerSettings): void {
  const file = join(botDir, 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // 文件坏了也要写回：宁可从空对象重建自己的段，也不静默不保存
  }
  const worlds = (raw.worlds && typeof raw.worlds === 'object' ? raw.worlds : {}) as Record<string, unknown>;
  const section = (worlds[MEMORY_LEDGER_ID] && typeof worlds[MEMORY_LEDGER_ID] === 'object'
    ? worlds[MEMORY_LEDGER_ID] : {}) as Record<string, unknown>;
  worlds[MEMORY_LEDGER_ID] = { ...section, [SETTINGS_KEY]: settings };
  raw.worlds = worlds;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
