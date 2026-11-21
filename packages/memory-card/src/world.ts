/**
 * 记忆卡的 World。
 *
 * 只在构建系统前缀时工作：读一次目录、裁一张卡、作为 `mc.*` 变量交出去。没有定时器、没有工具、
 * 不写记忆文件，所以它不会在 session 中途改变前缀——前缀变了就是一次交接。
 *
 * 配置页只剩启用开关；规则、目录、上限在独立「设置」面板里，落在
 * `<data>/memory-card-settings.json`，每次构建前缀时现读，改完下一次交接就生效。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { buildCard, RULE_MODES, type Cut, type RuleMode } from './card.ts';
import { MEMORY_CARD_ID, memoryCardConfigGroup, splitList, type MemoryCardConfigSection } from './config.ts';
import {
  clampSettings, readSettings, rulesText, writeSettings, type CardSettings,
} from './settings.ts';
import { PROMPT_VARS, memoryCardText, textLanguage, type TextLanguage } from './text.ts';

const ENV_PROMPT_FILES: Record<TextLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

export interface MemoryCardWorldOptions {
  /** 配置段 `worlds.memory-card`；现在只用来取 `enabled` 和首次迁移的旧规则。 */
  cfg: MemoryCardConfigSection;
  /** 部署目录，相对目录以它为准。 */
  botDir: string;
  /** 数据目录，`memory-card-settings.json` 放在这里。 */
  dataDir: string;
  /** 卡片抬头的时区。 */
  timezone: string;
}

export class MemoryCardWorld implements World {
  readonly id = MEMORY_CARD_ID;
  private host: WorldHost | null = null;
  private languageCache: { at: number; value: Language } | null = null;

  private readonly opts: MemoryCardWorldOptions;

  // 不用参数属性：Node 的 strip-only 模式不认这种写法，脚本就 import 不了这个文件
  constructor(opts: MemoryCardWorldOptions) {
    this.opts = opts;
  }

  private get cfg(): MemoryCardConfigSection {
    return this.opts.cfg;
  }

  /** 设置文件很小，每次现读：面板一保存，下一次构建前缀就吃到新值。 */
  private settings(): CardSettings {
    return readSettings(this.opts.dataDir, this.cfg);
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

  /** 空值落在部署目录的 `workspace` 上，那是人设放记忆的地方。 */
  private cardFolder(folder: string): string {
    const raw = folder.trim() || 'workspace';
    return isAbsolute(raw) ? resolve(raw) : resolve(join(this.opts.botDir, raw));
  }

  envPromptVars(): Record<string, string> {
    const settings = this.settings();
    const result = buildCard({
      folder: this.cardFolder(settings.folder),
      rules: rulesText(settings),
      totalChars: Math.max(0, settings.totalChars),
      listOthers: settings.listOthers,
      listMax: Math.max(0, settings.listMax),
      exclude: splitList(settings.exclude),
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

  /** 「设置」面板：一条规则一张卡，取法用下拉，不再手写竖线格式。 */
  private panelSections(language: Language): Array<Record<string, unknown>> {
    const p = memoryCardText(language).panel;
    const settings = this.settings();
    const modeOptions = RULE_MODES.map((mode) => ({ value: mode, label: p.modes[mode] }));
    const cutOptions = [
      { value: 'tail', label: p.cuts.tail },
      { value: 'head', label: p.cuts.head },
    ];
    const ruleSections = settings.rules.map((rule, index) => ({
      id: `rule${index}`,
      title: p.ruleTitle(index + 1),
      description: p.ruleDescription,
      fields: [
        { key: `file${index}`, label: p.labels.file, kind: 'text', value: rule.file, hint: p.hints.file },
        {
          key: `mode${index}`, label: p.labels.mode, kind: 'select',
          value: rule.mode, options: modeOptions, hint: p.hints.mode,
        },
        { key: `arg${index}`, label: p.labels.arg, kind: 'text', value: rule.arg, hint: p.hints.arg },
        {
          key: `limit${index}`, label: p.labels.limit, kind: 'int',
          value: rule.maxChars, min: 0, max: 200_000, suffix: p.charsSuffix, hint: p.hints.limit,
        },
        {
          key: `cut${index}`, label: p.labels.cut, kind: 'select',
          value: rule.cut, options: cutOptions, hint: p.hints.cut,
        },
      ],
    }));
    return [
      ...ruleSections,
      {
        id: 'common',
        title: p.commonTitle,
        description: p.commonDescription,
        fields: [
          { key: 'folder', label: p.labels.folder, kind: 'text', value: settings.folder, hint: p.hints.folder },
          {
            key: 'totalChars', label: p.labels.totalChars, kind: 'int',
            value: settings.totalChars, min: 0, max: 200_000, suffix: p.charsSuffix, hint: p.hints.totalChars,
          },
          {
            key: 'listOthers', label: p.labels.listOthers, kind: 'bool',
            value: settings.listOthers, hint: p.hints.listOthers,
          },
          {
            key: 'listMax', label: p.labels.listMax, kind: 'int',
            value: settings.listMax, min: 0, max: 100, hint: p.hints.listMax,
          },
          {
            key: 'exclude', label: p.labels.exclude, kind: 'text',
            value: settings.exclude, hint: p.hints.exclude,
          },
        ],
      },
    ];
  }

  private panelPayload(language: Language): Record<string, unknown> {
    const p = memoryCardText(language).panel;
    return {
      sections: this.panelSections(language),
      labels: { saved: p.saved },
    };
  }

  private panelInvoke(
    panel: string,
    method: string,
    args: unknown[],
    language: Language,
  ): Record<string, unknown> {
    if (panel !== 'settings') throw new Error(`no such panel: ${panel}`);
    if (method === 'status') return this.panelPayload(language);
    if (method === 'save') {
      const incoming = (args?.[0] ?? {}) as Record<string, unknown>;
      const text = (key: string, fallback: string) =>
        typeof incoming[key] === 'string' ? incoming[key] as string : fallback;
      const number = (key: string, fallback: number) =>
        typeof incoming[key] === 'number' && Number.isFinite(incoming[key] as number)
          ? incoming[key] as number
          : fallback;
      const bool = (key: string, fallback: boolean) =>
        typeof incoming[key] === 'boolean' ? incoming[key] as boolean : fallback;
      const current = this.settings();
      const next: CardSettings = {
        folder: text('folder', current.folder),
        totalChars: number('totalChars', current.totalChars),
        listOthers: bool('listOthers', current.listOthers),
        listMax: number('listMax', current.listMax),
        exclude: text('exclude', current.exclude),
        rules: current.rules.map((rule, index) => ({
          file: text(`file${index}`, rule.file),
          mode: text(`mode${index}`, rule.mode) as RuleMode,
          arg: text(`arg${index}`, rule.arg),
          maxChars: number(`limit${index}`, rule.maxChars),
          cut: text(`cut${index}`, rule.cut) as Cut,
        })),
      };
      writeSettings(this.opts.dataDir, clampSettings(next, current));
      return this.panelPayload(language);
    }
    throw new Error(`no such method: ${panel}.${method}`);
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = memoryCardText(language);
    const chosen = ENV_PROMPT_FILES[textLanguage(this.language)];
    return {
      label: t.label,
      panels: [{
        id: 'settings',
        title: t.panel.title,
        description: t.panel.description,
        getMethods: ['status', 'save'],
      }],
      invoke: async (panel: string, method: string, args: unknown[]) =>
        this.panelInvoke(panel, method, args, language),
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
