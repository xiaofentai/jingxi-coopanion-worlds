/**
 * 三份索引规则存在 `<data>/memory-ledger-settings.json`，由「索引规则」面板读写。
 *
 * 配置页只放开关与文件槽；规则这种「一行一段」的文本不混进 config.json，原因和
 * are-you-there 把雷达参数搬出配置页一样：平台会把声明过的配置键全渲染出来，用户
 * 面对 5 个规则槽 + extraRules 很难知道该改哪一个。这里只留下三份固定文件，面板
 * 每项只问两个数：留几天、最多几条。
 *
 * 首次运行时用 config.json 里的旧规则做初值，迁移完就以此文件为准。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRules } from './board.ts';
import { rulesText as legacyRulesText, type MemoryLedgerConfigSection } from './config.ts';

export const SETTINGS_FILE = 'memory-ledger-settings.json';

/** 这三份留在 ledger：按天索引、算账、参与召回；其他整份文件归 memory-card。 */
export const LEDGER_RULE_FILES = ['大事记.md', '超近期.md', '近期.md'] as const;

export interface LedgerRule {
  file: string;
  /** catalog 第 3 段：保留天数。0 = 不设窗口。 */
  days: number;
  /** catalog 第 4 段：条目上限。0 = 不限。 */
  cap: number;
}

export interface LedgerSettings {
  rules: LedgerRule[];
}

const DEFAULT_RULES: readonly LedgerRule[] = [
  { file: '大事记.md', days: 3650, cap: 80 },
  { file: '超近期.md', days: 4, cap: 0 },
  { file: '近期.md', days: 21, cap: 0 },
];

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, raw));
};

/** 面板提交什么都按这个过一遍；文件固定，不允许改名。 */
export function clampSettings(value: Partial<LedgerSettings> | null | undefined, fallback: LedgerSettings): LedgerSettings {
  const incoming = Array.isArray(value?.rules) ? value!.rules : [];
  return {
    rules: fallback.rules.map((base, index) => {
      const raw = (incoming[index] ?? {}) as Partial<LedgerRule>;
      return {
        file: base.file,
        days: clampInt(raw.days, base.days, 0, 3650),
        cap: clampInt(raw.cap, base.cap, 0, 10000),
      };
    }),
  };
}

/** 旧配置里只认 catalog 规则；三份之外的一律丢弃，避免把 card 的文件带回来。 */
export function seedSettings(cfg: MemoryLedgerConfigSection): LedgerSettings {
  const defaults: LedgerSettings = { rules: DEFAULT_RULES.map((rule) => ({ ...rule })) };
  let legacy: ReturnType<typeof parseRules>['rules'] = [];
  try {
    legacy = parseRules(legacyRulesText(cfg)).rules.filter((rule) => rule.mode === 'catalog');
  } catch {
    // 坏配置不该让 World 起不来
  }
  const rules = defaults.rules.map((base) => {
    const found = legacy.find((rule) => rule.path.replaceAll('\\', '/') === base.file);
    if (!found) return base;
    const days = Number.parseInt(found.arg.trim(), 10);
    return {
      ...base,
      days: Number.isFinite(days) && days > 0 ? days : base.days,
      cap: found.maxChars > 0 ? found.maxChars : base.cap,
    };
  });
  return clampSettings({ rules }, defaults);
}

export function rulesText(settings: LedgerSettings): string {
  return settings.rules
    .map((rule) => `${rule.file}|catalog|${rule.days}|${rule.cap > 0 ? rule.cap : ''}`)
    .join('; ');
}

export function readSettings(dir: string, cfg: MemoryLedgerConfigSection): LedgerSettings {
  const seed = seedSettings(cfg);
  const file = join(dir, SETTINGS_FILE);
  if (!existsSync(file)) return seed;
  try {
    return clampSettings(JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerSettings>, seed);
  } catch {
    return seed;
  }
}

export function writeSettings(dir: string, settings: LedgerSettings): void {
  const file = join(dir, SETTINGS_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
