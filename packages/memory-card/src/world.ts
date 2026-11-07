/**
 * 记忆卡的 World。
 *
 * 只在构建系统前缀时工作：读一次目录、裁一张卡、作为 `mc.*` 变量交出去。没有定时器、没有工具、
 * 不写盘，所以它不会在 session 中途改变前缀——前缀变了就是一次交接。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { buildCard } from './card.ts';
import { MEMORY_CARD_ID, memoryCardConfigGroup, rulesText, splitList, type MemoryCardConfigSection } from './config.ts';
import { PROMPT_VARS, memoryCardText, textLanguage, type TextLanguage } from './text.ts';

const ENV_PROMPT_FILES: Record<TextLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

export interface MemoryCardWorldOptions {
  /** 配置段 `worlds.memory-card`，每次使用时读取，所以改完不用重启。 */
  cfg: MemoryCardConfigSection;
  /** 部署目录，相对目录以它为准。 */
  botDir: string;
  /** 卡片抬头的时区。 */
  timezone: string;
}

export class MemoryCardWorld implements World {
  readonly id = MEMORY_CARD_ID;
  private host: WorldHost | null = null;
  private languageCache: { at: number; value: Language } | null = null;

  constructor(private readonly opts: MemoryCardWorldOptions) {}

  private get cfg(): MemoryCardConfigSection {
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

  /** 空值落在部署目录的 `workspace` 上，那是 Cormini 类人设放记忆的地方。 */
  private cardFolder(): string {
    const raw = this.cfg.folder.trim() || 'workspace';
    return isAbsolute(raw) ? resolve(raw) : resolve(join(this.opts.botDir, raw));
  }

  envPromptVars(): Record<string, string> {
    const result = buildCard({
      folder: this.cardFolder(),
      rules: rulesText(this.cfg),
      totalChars: Math.max(0, this.cfg.totalChars),
      listOthers: this.cfg.listOthers,
      listMax: Math.max(0, this.cfg.listMax),
      exclude: splitList(this.cfg.exclude),
      stamp: stamp(this.opts.timezone),
      language: textLanguage(this.language),
    });
    return { 'mc.meta': result.meta, 'mc.card': result.card, 'mc.index': result.index };
  }

  tools(): ToolDef[] {
    return [];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = memoryCardText(language);
    const chosen = ENV_PROMPT_FILES[textLanguage(this.language)];
    return {
      label: t.label,
      config: [memoryCardConfigGroup(language)],
      promptDocs: [{
        key: `worlds.${MEMORY_CARD_ID}.envPrompt`,
        title: t.envPrompt.title,
        description: t.envPrompt.description,
        path: existsSync(chosen) ? chosen : ENV_PROMPT_FILES.zh,
        role: 'envPrompt',
        vars: PROMPT_VARS.map((name) => ({
          name,
          description: t.envPrompt.vars[name],
          ...(name === 'mc.card' || name === 'mc.index' ? { multiline: true } : {}),
        })),
      }],
    };
  }
}

/** `MM-DD HH:mm`，配置时区；时区写错就退回本机时间。 */
function stamp(timezone: string): string {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (kind: string) => parts.find((part) => part.type === kind)?.value ?? '';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    const two = (n: number) => String(n).padStart(2, '0');
    return `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  }
}
