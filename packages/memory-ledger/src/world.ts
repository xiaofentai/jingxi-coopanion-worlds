/**
 * 记忆树网的 World。
 *
 * 只在构建系统前缀时工作：读一次目录、裁一张板、作为 `ml.*` 变量交出去。没有定时器、没有工具、
 * 不写盘，所以它不会在 session 中途改变前缀——前缀变了就是一次交接。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { buildBoard } from './board.ts';
import { ensureArchiveFile } from './archive.ts';
import { MEMORY_LEDGER_ID, memoryLedgerConfigGroup, rulesText, splitList, type MemoryLedgerConfigSection } from './config.ts';
import { PROMPT_VARS, memoryLedgerText, textLanguage, type TextLanguage } from './text.ts';
import { createLedgerTools } from './tools.ts';

const ENV_PROMPT_FILES: Record<TextLanguage, string> = {
  zh: fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('../ENV_PROMPT.en.md', import.meta.url)),
};

export interface MemoryLedgerWorldOptions {
  /** 配置段 `worlds.memory-ledger`，每次使用时读取，所以改完不用重启。 */
  cfg: MemoryLedgerConfigSection;
  /** 部署目录，相对目录以它为准。 */
  botDir: string;
  /** 卡抬头的时区。 */
  timezone: string;
}

export class MemoryLedgerWorld implements World {
  readonly id = MEMORY_LEDGER_ID;
  private host: WorldHost | null = null;
  private languageCache: { at: number; value: Language } | null = null;

  private readonly opts: MemoryLedgerWorldOptions;

  // 不用参数属性：Node 的 strip-only 模式不认这种写法，测试就 import 不了这个文件
  constructor(opts: MemoryLedgerWorldOptions) {
    this.opts = opts;
  }

  private get cfg(): MemoryLedgerConfigSection {
    return this.opts.cfg;
  }

  /** `config.json` 里的语言，文件变了再读一次。 */
  private get language(): Language {
    let at = 0;
    try {
      at = statSync(join(this.opts.botDir, 'config.json')).mtimeMs;
    } catch {
      // seeded Chinese
    }
    if (this.languageCache?.at !== at) {
      let value: Language = 'zh';
      try {
        const raw = JSON.parse(readFileSync(join(this.opts.botDir, 'config.json'), 'utf8')) as { language?: unknown };
        if (isLanguage(raw.language)) value = raw.language;
      } catch {
        // seeded Chinese
      }
      this.languageCache = { at, value };
    }
    return this.languageCache.value;
  }

  /** 空值落在部署目录的 `workspace` 上。 */
  private boardFolder(): string {
    const raw = this.cfg.folder.trim() || 'workspace';
    return isAbsolute(raw) ? resolve(raw) : resolve(join(this.opts.botDir, raw));
  }

  envPromptVars(): Record<string, string> {
    const result = buildBoard({
      folder: this.boardFolder(),
      rules: rulesText(this.cfg),
      listOthers: this.cfg.listOthers,
      listMax: Math.max(0, this.cfg.listMax),
      exclude: splitList(this.cfg.exclude),
      stamp: stamp(this.opts.timezone),
      today: today(this.opts.timezone),
      language: textLanguage(this.language),
      archiveFile: this.cfg.archiveFile ?? '',
    });
    // 开口前召回是实验项：开关关着时这个变量是空串，模板里那一行自然消失
    const hint = this.cfg.recallOnSpeak ? memoryLedgerText(textLanguage(this.language)).hintRecall : '';
    return { 'ml.meta': result.meta, 'ml.card': result.card, 'ml.index': result.index, 'ml.policy': result.policy, 'ml.hint': hint };
  }

  /** 写入口：只碰块，不碰行；每次调用现读文件，所以配置改了不用重启。 */
  tools(): ToolDef[] {
    return createLedgerTools({
      folder: () => this.boardFolder(),
      rules: () => rulesText(this.cfg),
      backupDir: () => join(this.opts.botDir, 'data', 'memory-ledger'),
      today: () => today(this.opts.timezone),
      todayFile: () => this.cfg.todayFile ?? '',
      archiveFile: () => this.cfg.archiveFile ?? '',
    });
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.ensureArchive();
  }

  /** 启用时先把归档文件建出来：设置页的选择器要能选到它，第一次 `ml_forget` 也不该失败。 */
  private ensureArchive(): void {
    ensureArchiveFile(this.boardFolder(), this.cfg.archiveFile ?? '');
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = memoryLedgerText(language);
    const chosen = ENV_PROMPT_FILES[textLanguage(this.language)];
    return {
      label: t.label,
      config: [memoryLedgerConfigGroup(language)],
      promptDocs: [{
        key: `worlds.${MEMORY_LEDGER_ID}.envPrompt`,
        title: t.envPrompt.title,
        description: t.envPrompt.description,
        path: existsSync(chosen) ? chosen : ENV_PROMPT_FILES.zh,
        role: 'envPrompt',
        vars: PROMPT_VARS.map((name) => ({
          name,
          description: t.envPrompt.vars[name],
          ...(name === 'ml.card' || name === 'ml.index' ? { multiline: true } : {}),
        })),
      }],
    };
  }
}

/** 时区里的一个时刻，按 `Intl` 取各段。 */
function parts(timezone: string): Record<string, string> | null {
  try {
    const list = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const out: Record<string, string> = {};
    for (const part of list) out[part.type] = part.value;
    return out;
  } catch {
    return null;
  }
}

/** `MM-DD HH:mm`，配置时区；时区写错就退回本机时间。 */
function stamp(timezone: string): string {
  const at = parts(timezone);
  if (at) return `${at.month}-${at.day} ${at.hour}:${at.minute}`;
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

/** `YYYY-MM-DD`，配置时区；判覆盖用。 */
function today(timezone: string): string {
  const at = parts(timezone);
  if (at) return `${at.year}-${at.month}-${at.day}`;
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}
