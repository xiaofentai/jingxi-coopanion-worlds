/**
 * 记忆卡的非开关设置存在 `<data>/memory-card-settings.json`。
 *
 * 配置页只剩启用开关：规则在设置页是一条一张卡（选文件、选取法、填参数），
 * 不再让人手写 `常驻.md|whole||2000` 这种一行五段的格式。
 * 首次运行从 `config.json` 的旧规则槽迁移，之后以这份文件为准。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRules, RULE_MODES, type Cut, type Rule, type RuleMode } from './card.ts';
import { MEMORY_CARD_DEFAULTS, RULE_SLOTS, type MemoryCardConfigSection } from './config.ts';

export const CARD_SETTINGS_FILE = 'memory-card-settings.json';

export interface CardRule {
  /** 相对记忆目录；空 = 跳过这一条。 */
  file: string;
  mode: RuleMode;
  /** 取法的参数：`marker` 的标题、`newest` 的块数、`newest+pin` 的「块数,固定块」。 */
  arg: string;
  /** 这一份的字数上限；0 = 不单独限制，只受整张卡的上限约束。 */
  maxChars: number;
  /** 超限时切哪一头。 */
  cut: Cut;
}

export interface CardSettings {
  folder: string;
  totalChars: number;
  listOthers: boolean;
  listMax: number;
  exclude: string;
  rules: CardRule[];
}

const EMPTY_RULE: CardRule = { file: '', mode: 'whole', arg: '', maxChars: 0, cut: 'tail' };

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, raw));
};

const clampBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/** 一行旧规则；认不出的模式（ledger 的 `catalog` 之类）会被 `parseRules` 判错，那一行就丢掉。 */
function safeRules(text: string): Rule[] {
  try {
    return parseRules(text).rules;
  } catch {
    return [];
  }
}

/** 逐槽解析：某个槽写错时只丢那一槽，不会把后面的规则往前挤。 */
function slotRules(cfg: MemoryCardConfigSection): Rule[] {
  const slots = [cfg.rule1, cfg.rule2, cfg.rule3, cfg.rule4, cfg.rule5]
    .map((line) => safeRules((line ?? '').trim())[0])
    .filter((rule): rule is Rule => !!rule);
  // 旧 `extraRules` 可以有多条，排在五个槽后面；设置页会给每一条画一张卡
  return [...slots, ...safeRules((cfg.extraRules ?? '').trim())];
}

function toCardRule(rule: Rule | undefined): CardRule {
  return rule
    ? { file: rule.path, mode: rule.mode, arg: rule.arg, maxChars: rule.maxChars, cut: rule.cut }
    : { ...EMPTY_RULE };
}

/** 首次迁移：旧规则有几条就搬几条；一条都没有就用包里那三条。 */
export function seedSettings(cfg: MemoryCardConfigSection): CardSettings {
  const legacy = slotRules(cfg);
  const used = legacy.length ? legacy : slotRules(MEMORY_CARD_DEFAULTS);
  const size = Math.max(RULE_SLOTS, used.length);
  return {
    folder: String(cfg.folder ?? '').trim() || MEMORY_CARD_DEFAULTS.folder,
    totalChars: clampInt(cfg.totalChars, MEMORY_CARD_DEFAULTS.totalChars, 0, 200_000),
    listOthers: clampBool(cfg.listOthers, MEMORY_CARD_DEFAULTS.listOthers),
    listMax: clampInt(cfg.listMax, MEMORY_CARD_DEFAULTS.listMax, 0, 100),
    exclude: typeof cfg.exclude === 'string' ? cfg.exclude.trim() : MEMORY_CARD_DEFAULTS.exclude,
    rules: Array.from({ length: size }, (_, index) => toCardRule(used[index])),
  };
}

function clampRule(value: Partial<CardRule> | undefined, base: CardRule): CardRule {
  const mode = RULE_MODES.includes(value?.mode as RuleMode) ? value!.mode as RuleMode : base.mode;
  return {
    // 文件允许留空（跳过这一条），所以不能像别处那样「空了就用默认值」
    file: typeof value?.file === 'string' ? value.file.trim().replaceAll('\\', '/').slice(0, 240) : base.file,
    mode,
    arg: typeof value?.arg === 'string' ? value.arg.trim().slice(0, 120) : base.arg,
    maxChars: clampInt(value?.maxChars, base.maxChars, 0, 200_000),
    cut: value?.cut === 'head' ? 'head' : value?.cut === 'tail' ? 'tail' : base.cut,
  };
}

/** 面板提交什么都按这个过一遍；条数不会因为表单少给一条就丢。 */
export function clampSettings(
  value: Partial<CardSettings> | null | undefined,
  fallback: CardSettings,
): CardSettings {
  const incoming = Array.isArray(value?.rules) ? value!.rules : [];
  const size = Math.max(RULE_SLOTS, fallback.rules.length, incoming.length);
  return {
    folder: typeof value?.folder === 'string' && value.folder.trim()
      ? value.folder.trim().slice(0, 400)
      : fallback.folder,
    totalChars: clampInt(value?.totalChars, fallback.totalChars, 0, 200_000),
    listOthers: clampBool(value?.listOthers, fallback.listOthers),
    listMax: clampInt(value?.listMax, fallback.listMax, 0, 100),
    // 跳过名单允许清空，所以不把空串当成「没提交」
    exclude: typeof value?.exclude === 'string' ? value.exclude.trim().slice(0, 400) : fallback.exclude,
    rules: Array.from({ length: size }, (_, index) =>
      clampRule(incoming[index], fallback.rules[index] ?? EMPTY_RULE)),
  };
}

/** 拼回 `card.ts` 认的一行五段；文件留空的规则不出现。 */
export function rulesText(settings: CardSettings): string {
  return settings.rules
    .filter((rule) => rule.file)
    .map((rule) => `${rule.file}|${rule.mode}|${rule.arg}|${rule.maxChars > 0 ? rule.maxChars : ''}|${rule.cut}`)
    .join('; ');
}

export function readSettings(dir: string, cfg: MemoryCardConfigSection): CardSettings {
  const seed = seedSettings(cfg);
  const file = join(dir, CARD_SETTINGS_FILE);
  if (!existsSync(file)) return seed;
  try {
    return clampSettings(JSON.parse(readFileSync(file, 'utf8')) as Partial<CardSettings>, seed);
  } catch {
    return seed;
  }
}

export function writeSettings(dir: string, settings: CardSettings): void {
  const file = join(dir, CARD_SETTINGS_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
