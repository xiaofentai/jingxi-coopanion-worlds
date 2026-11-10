/**
 * Server酱 的 World：把 bot 想说的一句话推到 ta 的手机上。
 *
 * 没有定时器、没有事件——推送只发生在 `sc_send` 这一次工具调用里。两个通道在这条路上唯一的差别
 * 是地址的拼法（见 `channel.ts`）与请求形状（见 `send.ts`），World 只负责认 Key、拦明显不合适的
 * 调用、把结果记下来，再把话交给 `text.ts` 去说。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { maskKey, parseSendKey, type ChannelChoice } from './channel.ts';
import { SERVERCHAN_ID, serverChanConfigGroup, type ServerChanConfigSection } from './config.ts';
import { ENV_SENDKEY, dotEnvValue, readLanguage } from './env.ts';
import { formatClock } from './format.ts';
import { DEFAULT_TIMEOUT_MS, MAX_TEXT, MAX_TITLE, pushTo, type FetchLike, type PushOutcome } from './send.ts';
import { bodyHash, readState, recordSend, todayCount, writeState, STATE_FILE, type ServerChanState } from './state.ts';
import { PROMPT_VARS, serverChanText, textLanguage, type TextLanguage } from './text.ts';

const ENV_PROMPT_FILES: Record<TextLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

/** 同样的标题与正文在这个时间内不再重复发一次。 */
const DUPLICATE_MS = 60_000;

/** 这个 World 的两个工具；`tools()` 绑上 handler。 */
export const SERVERCHAN_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'sc_send',
    description:
      'Push one short message to their phone through Server酱, so it reaches them away from this screen. Use it when the '
      + 'thing must reach them now and a chat bubble here would not. The title is capped at 32 characters and shows in '
      + 'the notification; the body is Markdown but the notification may show only the title. Turbo keys take no tags, '
      + 'Server酱³ keys do. The same title and body is refused within 60 seconds, so never call it twice for reassurance.',
    tags: ['write', 'push'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          maxLength: MAX_TITLE,
          description: `The line they see on the lock screen, at most ${MAX_TITLE} characters.`,
        },
        text: {
          type: 'string',
          maxLength: MAX_TEXT,
          description: 'The body: Markdown, links and lists render in the app. Keep it short; it is a push, not a letter.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Server酱³ only: tags for later filtering. Ignored with a Turbo key and reported in the receipt.',
        },
      },
      required: ['title', 'text'],
    },
  },
  {
    name: 'sc_status',
    description:
      'Report which Server酱 channel the configured SendKey belongs to (masked), whether a push can go out at all, how '
      + 'many went out today, and how the last attempt ended. Read only; nothing is sent.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export interface ServerChanWorldOptions {
  /** `worlds.serverchan`，每次使用时读取。 */
  cfg: ServerChanConfigSection;
  /** 回执里的时刻用这个时区。 */
  timezone: string;
  /** 部署目录：读 `config.json` 的语言与 `.env` 里的 Key。 */
  botDir: string;
  /** 运行记录 `serverchan.json` 放这里。 */
  dataDir: string;
  /** 测试可以换掉真正发请求的那一步。 */
  fetcher?: FetchLike;
  /** 测试可以换掉时钟，用来试「60 秒内不重复」。 */
  now?: () => number;
}

export class ServerChanWorld implements World {
  readonly id = SERVERCHAN_ID;
  private host: WorldHost | null = null;
  /** 同一时间只发一条，免得两个工具调用抢着写同一份记录。 */
  private sending = false;
  private readonly opts: ServerChanWorldOptions;
  private readonly fetcher: FetchLike;
  private readonly nowMs: () => number;

  constructor(opts: ServerChanWorldOptions) {
    this.opts = opts;
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
    this.nowMs = opts.now ?? Date.now;
  }

  private get cfg(): ServerChanConfigSection {
    return this.opts.cfg;
  }

  private get t() {
    return serverChanText(this.language);
  }

  private get textLanguage(): TextLanguage {
    return textLanguage(this.language);
  }

  private get language(): Language {
    return readLanguage(this.opts.botDir);
  }

  private get stateFile(): string {
    return join(this.opts.dataDir, STATE_FILE);
  }

  /** 只有 `auto` / `turbo` / `sc3` 三个值算数，写坏了回到自动。 */
  private get choice(): ChannelChoice {
    const raw = this.cfg.channel;
    return raw === 'turbo' || raw === 'sc3' ? raw : 'auto';
  }

  envPromptVars(): Record<string, string> {
    const t = this.t;
    const key = this.resolveKey();
    const state = readState(this.stateFile);
    let line: string;
    if (!key.value) {
      line = t.state.unconfigured;
    } else {
      const parsed = parseSendKey(key.value, this.choice);
      line = parsed.ok
        ? t.state.ready(t.channel[parsed.target.channel], todayCount(state, this.opts.timezone, this.nowMs()))
        : t.state.broken;
    }
    return { 'sc.state': line };
  }

  tools(): ToolDef[] {
    return SERVERCHAN_TOOL_DECLS.map((decl) => ({ ...decl, handler: (args) => this.run(decl.name, args) }));
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = serverChanText(language);
    const chosen = ENV_PROMPT_FILES[this.textLanguage];
    return {
      label: t.label,
      config: [serverChanConfigGroup(language)],
      promptDocs: [{
        key: `worlds.${SERVERCHAN_ID}.envPrompt`,
        title: t.envPrompt.title,
        description: t.envPrompt.description,
        path: existsSync(chosen) ? chosen : ENV_PROMPT_FILES.zh,
        role: 'envPrompt',
        vars: PROMPT_VARS.map((name) => ({ name, description: t.envPrompt.vars[name] })),
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  private async run(name: string, args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (name === 'sc_status') return this.status();
    if (name === 'sc_send') return this.send(args);
    return { text: this.t.tool.failed(name, this.t.tool.unknown), failed: true };
  }

  /** 设置页优先，其次部署目录 `.env`。 */
  private resolveKey(): { value: string; source: 'settings' | 'dotenv' } {
    const fromSettings = typeof this.cfg.sendkey === 'string' ? this.cfg.sendkey.trim() : '';
    if (fromSettings) return { value: fromSettings, source: 'settings' };
    return { value: dotEnvValue(join(this.opts.botDir, '.env'), ENV_SENDKEY), source: 'dotenv' };
  }

  private async send(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const t = this.t;
    const now = this.nowMs();
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag.length > 0)
      : [];

    if (!title) return { text: t.tool.failed('sc_send', t.tool.emptyTitle), failed: true };
    if ([...title].length > MAX_TITLE) return { text: t.tool.failed('sc_send', t.tool.longTitle(MAX_TITLE)), failed: true };
    if ([...text].length > MAX_TEXT) return { text: t.tool.failed('sc_send', t.tool.longText(MAX_TEXT)), failed: true };

    const resolved = this.resolveKey();
    if (!resolved.value) return { text: t.tool.failed('sc_send', t.tool.unconfigured(ENV_SENDKEY)), failed: true };
    const parsed = parseSendKey(resolved.value, this.choice);
    if (!parsed.ok) {
      const problem = parsed.problem === 'empty' ? 'not-a-url' : parsed.problem;
      return { text: t.tool.failed('sc_send', t.tool.brokenKey(problem)), failed: true };
    }

    if (this.sending) return { text: t.tool.failed('sc_send', t.tool.busy), failed: true };

    const state = readState(this.stateFile);
    const hash = bodyHash(text);
    if (
      state.last !== null && state.last.ok
      && state.last.title === title && state.last.hash === hash
      && now - state.last.at < DUPLICATE_MS
    ) {
      const seconds = Math.round(DUPLICATE_MS / 1000);
      return { text: t.tool.failed('sc_send', t.tool.duplicate(seconds)), failed: true };
    }

    this.sending = true;
    let outcome: PushOutcome;
    try {
      outcome = await pushTo(parsed.target, { title, desp: text, tags }, this.fetcher);
    } finally {
      this.sending = false;
    }

    const reason = outcome.ok ? null : this.reasonOf(outcome);
    const next = recordSend(state, {
      at: now,
      ok: outcome.ok,
      channel: outcome.channel,
      title,
      hash,
      error: reason,
    }, this.opts.timezone);
    this.save(next);

    if (!outcome.ok) return { text: t.tool.failed('sc_send', reason ?? t.tool.unknown), failed: true };
    const lines = [t.tool.sent(title, t.channel[outcome.channel], todayCount(next, this.opts.timezone, now))];
    if (outcome.ignored.includes('tags')) lines.push(t.tool.ignoredTags);
    return lines.join('\n');
  }

  /** 把一次失败翻成人话；`text.ts` 是唯一写句子的地方。 */
  private reasonOf(outcome: Extract<PushOutcome, { ok: false }>): string {
    const t = this.t;
    const seconds = Math.round(DEFAULT_TIMEOUT_MS / 1000);
    if (outcome.kind === 'timeout') return t.tool.timeout(seconds);
    if (outcome.kind === 'network') return t.tool.network(outcome.message);
    if (outcome.kind === 'not-json') return t.tool.notJson(outcome.message);
    if (outcome.kind === 'http') return t.tool.http(outcome.status ?? 0);
    return t.tool.rejected(outcome.code === null ? '?' : String(outcome.code), outcome.message);
  }

  private status(): string {
    const t = this.t;
    const now = this.nowMs();
    const state = readState(this.stateFile);
    const key = this.resolveKey();
    const lines: string[] = [];

    if (!key.value) {
      lines.push(t.tool.statusLines.none);
    } else {
      const parsed = parseSendKey(key.value, this.choice);
      if (parsed.ok) {
        lines.push(t.tool.statusLines.channel(t.channel[parsed.target.channel], parsed.target.host, maskKey(parsed.target.sendkey)));
      } else {
        const problem = parsed.problem === 'empty' ? 'not-a-url' : parsed.problem;
        lines.push(t.tool.statusLines.broken(problem));
      }
      lines.push(key.source === 'dotenv' ? t.tool.statusLines.fromEnv(ENV_SENDKEY) : t.tool.statusLines.fromSettings);
    }

    lines.push(t.tool.statusLines.today(todayCount(state, this.opts.timezone, now), state.total));
    const last = state.last;
    if (last === null) {
      lines.push(t.tool.statusLines.never);
    } else if (last.ok) {
      lines.push(t.tool.statusLines.last(formatClock(this.opts.timezone, last.at), last.title));
    } else {
      lines.push(t.tool.statusLines.lastFailed(formatClock(this.opts.timezone, last.at), last.error ?? ''));
    }
    return lines.join('\n');
  }

  private save(state: ServerChanState): void {
    try {
      writeState(this.stateFile, state);
    } catch (error) {
      console.warn('[serverchan] could not save the record', this.stateFile, error);
    }
  }
}
