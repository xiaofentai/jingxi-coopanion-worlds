/**
 * 小纸条 World：一个定时器、三套判据、最多一条事件。
 *
 * 三个约定（沿用 cache-keepalive，被它的注释骂过一轮才定下来的）：
 * 1. **定时器自排期**，间隔每拍现读；只在 start() 里读一次的话，设置页改完就白改。
 * 2. **心跳的空档用 usage.jsonl 的 mtime**——宿主每轮都写账，mtime 就是上次调用时刻；
 *    纸条和问候的钟**不看 mtime**（后台信息会一直刷新它），只看自己的时刻和时段。
 * 3. **推的是 flush，不是 piggyback**——这版宿主不认 piggyback；flush 等这一轮跑完才送，
 *    不打断正在说的话。
 *
 * 同一拍多套判据都通过时按 问候 > 纸条 > 心跳 取一条：那一拍也唤醒了模型，
 * 缓存照样续上，所以把 lastBeatAt 记成现在，不再补一条让她一次收到几句。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import {
  DEFAULT_TEMPLATE_EN, clampIdleMinutes, clampTickSeconds, decideBeat, formatClock,
  localDay, localMinuteOfDay, minutesOf, renderHeartbeat,
} from './beat.ts';
import { IDLE_NUDGE_ID, idleNudgeConfigGroup, type IdleNudgeConfigSection } from './config.ts';
import { decideNote, renderNote } from './note.ts';
import { decideGreeting, renderGreeting } from './greeting.ts';
import { checkIncoming } from './validate.ts';
import {
  DEFAULT_NOTE_TEXT, DEFAULT_HEARTBEAT_TEXT,
  readSettings, writeSettings, clampSettings,
  slotRangeText, parseSlotPair, type NudgeSettings,
} from './settings.ts';

export interface IdleNudgeWorldOptions {
  /** `worlds.idle-nudge`，每次使用时读取。 */
  cfg: IdleNudgeConfigSection;
  timezone: string;
  botDir: string;
  dataDir: string;
  /** 测试换掉「读上一次调用时刻」。 */
  usageMtime?: () => number | null;
  /** 测试换掉推送那一步。返回 event.type，便于断言先推了谁；key 是落进事件库的 senderKey。 */
  push?: (type: string, text: string, senderKey?: string) => Promise<boolean>;
  clock?: () => number;
}

/** 设置页 / 日志里看的现状。 */
export interface NudgeStatus {
  on: boolean;
  lastTickAt: number | null;
  lastBeatAt: number | null;
  lastCallAt: number | null;
  lastNoteAt: number | null;
  beatToday: number;
  noteToday: number[];
  greetingToday: boolean[];
  beatNote: string;
  noteNote: string;
  greetingNote: string;
}

export class IdleNudgeWorld implements World {
  readonly id = IDLE_NUDGE_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private working = false;
  private settings: NudgeSettings;

  // ---- 运行时状态：这些是节奏，不是记忆，不落盘。重启会清，所以判据前会再去事件库核对一遍 ----
  private lastTickAt: number | null = null;
  private lastBeatAt: number | null = null;
  private lastCallAt: number | null = null;
  private lastNoteAt: number | null = null;
  private beatToday = 0;
  private noteToday: number[] = [0, 0, 0];
  private greetingToday: boolean[] = [false, false];
  private countedDay = '';
  private beatNote = '还没跑过第一拍';
  private noteNote = '还没跑过第一拍';
  private greetingNote = '还没跑过第一拍';
  private languageCache: { at: number; value: 'zh' | 'en' } | null = null;
  private readonly opts: IdleNudgeWorldOptions;

  constructor(opts: IdleNudgeWorldOptions) {
    this.opts = opts;
    this.settings = readSettings(opts.botDir);
  }

  private get cfg(): IdleNudgeConfigSection {
    return this.opts.cfg;
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  /** 不往前缀加一个字：它的价值全在「推对了那一拍」。 */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  /** 一个工具都不给：她没有理由知道有这个插件。 */
  tools(): ToolDef[] {
    return [];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    this.settings = readSettings(this.opts.botDir);
    this.armTimer();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.host = null;
  }

  /** 交接刚结束：前缀是新建的，让出一个阈值再补拍（和 cache-keepalive 一样）。 */
  onHandoffEnded(): void {
    this.lastBeatAt = this.now();
  }

  private armTimer(): void {
    if (this.timer !== null || this.stopped) return;
    const step = (): void => {
      // 每拍现读设置：间隔和所有参数改完下一拍生效，不用重启
      this.settings = readSettings(this.opts.botDir);
      const ms = clampTickSeconds(this.settings.tickSeconds) * 1000;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick().finally(step);
      }, ms);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    };
    step();
  }

  /** usage.jsonl 的修改时间 = 上一次模型调用时刻。读不到就返回 null（当作很久没调用）。 */
  private readUsageMtime(): number | null {
    if (this.opts.usageMtime) return this.opts.usageMtime();
    for (const file of [join(this.opts.dataDir, 'usage.jsonl'), join(this.opts.botDir, 'data', 'usage.jsonl')]) {
      try {
        return statSync(file).mtimeMs;
      } catch {
        // 换下一个位置
      }
    }
    return null;
  }

  /**
   * 事件库里最近 26 小时、本插件自己推的事件（同步，查一次）。
   *
   * 26 小时 = 「今天」最多 24 小时 + 2 小时余量：窗口只要把今天整段包进来就够，
   * 精确到「只算今天」靠调用方按 `localDay(ts)` 过滤——这样不必自己算本地零点的偏移。
   * 纸条的间隔上限是 1440 分钟（24 小时），也需要这个跨度。
   *
   * **只在判据决定要推的那一刻调用**（见 tick），一次 tick 不会白扫：正常一天几十次。
   * 查不到（老宿主没有 store、库读坏了）返回 null，调用方退回纯内存。
   */
  private queryWindow(now: number, senderKey?: string): Array<{ type?: unknown; ts?: unknown; senderKey?: unknown }> | null {
    const store = this.host?.store;
    if (!store) return null;
    try {
      return store.range({
        source: IDLE_NUDGE_ID,
        ...(senderKey === undefined ? {} : { senderKey }),
        fromTs: new Date(now - 26 * 3600_000).toISOString(),
        limit: 200,
      }) as Array<{ type?: unknown; ts?: unknown; senderKey?: unknown }>;
    } catch {
      return null;
    }
  }

  /**
   * 推之前确认「今天这一天推过没有」，并把查到的结果**写回内存**。
   *
   * 写回是关键：调用方紧接着会用同一份事实重判一次（见 tick），内存里有了就自然拦住，
   * 下一拍也不会再查。内存与库取 max / OR 而不是相加——本会话刚推的事件要等投递才落库，
   * 落了库又会在这条查询里出现，相加就重复计数了。
   *
   * 背景：内存计数重启就清，而抖动点按「日期|段号|第几张」算、重启后还是同一个已经过去的点，
   * 所以以前每次重启都会白推一条（11-25 实测：7 次重启 7 条纸条，全在启动后 16–23 秒）。
   */
  private hydrateGreeting(slot: number, day: string, now: number): void {
    const events = this.queryWindow(now, `greeting:${slot}`);
    if (!events) return;
    for (const event of events) {
      const at = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
      if (!Number.isFinite(at) || localDay(this.opts.timezone, at) !== day) continue;
      if (event.type === `${IDLE_NUDGE_ID}.greeting`) {
        this.greetingToday[slot] = true;
        return;
      }
    }
  }

  private hydrateNote(slot: number, day: string, now: number): void {
    const events = this.queryWindow(now);
    if (!events) return;
    let count = 0;
    let lastMs: number | null = null;
    for (const event of events) {
      if (event.type !== `${IDLE_NUDGE_ID}.note`) continue;
      const at = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
      if (!Number.isFinite(at)) continue;
      // 上一张的时刻不限今天：间隔最长 24 小时，昨日 23:00 那张会挡住今天 00:30
      if (lastMs === null || at > lastMs) lastMs = at;
      if (localDay(this.opts.timezone, at) !== day) continue;
      if (Number(typeof event.senderKey === 'string' ? event.senderKey.split(':')[1] : Number.NaN) === slot) count += 1;
    }
    this.noteToday[slot] = Math.max(this.noteToday[slot] ?? 0, count);
    if (lastMs !== null) this.lastNoteAt = Math.max(this.lastNoteAt ?? 0, lastMs);
  }

  private hydrateBeat(day: string, now: number): void {
    const events = this.queryWindow(now, 'beat');
    if (!events) return;
    let count = 0;
    for (const event of events) {
      const at = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
      if (!Number.isFinite(at) || localDay(this.opts.timezone, at) !== day) continue;
      if (event.type === `${IDLE_NUDGE_ID}.beat`) count += 1;
    }
    this.beatToday = Math.max(this.beatToday, count);
  }

  private async tick(): Promise<void> {
    const now = this.now();
    this.lastTickAt = now;
    if (!this.cfg.enabled) {
      this.beatNote = this.noteNote = this.greetingNote = '开关关着';
      return;
    }
    if (this.working || this.host === null) {
      const why = this.host === null ? '还没挂到宿主上' : '上一拍还没走完';
      this.beatNote = this.noteNote = this.greetingNote = why;
      return;
    }

    this.working = true;
    try {
      const day = localDay(this.opts.timezone, now);
      if (this.countedDay !== day) {
        this.countedDay = day;
        this.beatToday = 0;
        this.noteToday = this.settings.slots.map(() => 0);
        this.greetingToday = this.settings.greetings.map(() => false);
      }

      // usage 的 mtime 每拍都读：心跳要用它，「缓存距今多久」那颗药丸也要用。
      // 放在最前面——问候 / 纸条那一拍会提前 return，之后的值也得是这一拍的。
      const lastCallAt = this.readUsageMtime();
      this.lastCallAt = lastCallAt;

      // 每拍只读内存判；判据说要推了，才去事件库核对一次（hydrate* 会把结果写回内存，
      // 所以同一件事最多查一次，下一拍内存就拦住了）。见 queryWindow 的注释。
      const minuteOfDay = localMinuteOfDay(this.opts.timezone, now);

      // ---- 问候最优先（早晚安有时效），其次纸条，最后心跳 ----
      const greetingPolicy = { slots: this.settings.greetings };
      const greetingFacts = () => ({ now, minuteOfDay, day, sentToday: this.greetingToday });
      let greetingDecision = this.settings.greetingEnabled
        ? decideGreeting(greetingFacts(), greetingPolicy)
        : { fire: false as const, note: '早晚安已关' };
      if (greetingDecision.fire) {
        this.hydrateGreeting(greetingDecision.slot, day, now);
        greetingDecision = decideGreeting(greetingFacts(), greetingPolicy); // 补过内存再判一次
      }

      if (greetingDecision.fire) {
        const clock = formatClock(this.opts.timezone, now);
        const text = renderGreeting(clock, greetingDecision.label);
        if (await this.push('greeting', text, greetingDecision.slot)) {
          this.greetingToday[greetingDecision.slot] = true;
          this.lastBeatAt = now;
          this.greetingNote = `已递${greetingDecision.label}（${clock}）`;
          this.noteNote = '这一拍递了问候，缓存已续';
          this.beatNote = '这一拍递了问候，缓存已续';
          return;
        }
        // 推失败就降级到下一套判据，不 return：判据本身不会推进状态（sentToday 没置位），
        // 下一拍还会命中同一个问候；一直 return 的话纸条和心跳会被一个永久失败的推送饿死。
        this.greetingNote = '推送失败（宿主的 pushDeferred 没接住），接着试纸条 / 心跳';
      } else {
        this.greetingNote = greetingDecision.note;
      }

      // ---- 纸条：它有自己的钟，和 usage 的 mtime 无关 ----
      const notePolicy = { slots: this.settings.slots, gapMinutes: this.settings.noteGapMinutes };
      const noteFacts = () => ({
        now,
        minuteOfDay,
        day,
        lastNoteAt: this.lastNoteAt,
        slotPushedToday: this.noteToday,
      });
      let noteDecision = this.settings.noteEnabled
        ? decideNote(noteFacts(), notePolicy)
        : { fire: false as const, note: '小纸条已关' };
      if (noteDecision.fire) {
        this.hydrateNote(noteDecision.slot, day, now);
        noteDecision = decideNote(noteFacts(), notePolicy); // 补过内存再判一次
      }

      if (noteDecision.fire) {
        const clock = formatClock(this.opts.timezone, now);
        const text = renderNote(this.settings.noteText, clock, DEFAULT_NOTE_TEXT);
        if (await this.push('note', text, noteDecision.slot)) {
          this.lastNoteAt = now;
          this.noteToday[noteDecision.slot] = (this.noteToday[noteDecision.slot] ?? 0) + 1;
          // 这一拍唤醒了模型，缓存已续；别再补心跳
          this.lastBeatAt = now;
          this.noteNote = `已递纸条（今天 ${this.noteToday.reduce((a, b) => a + b, 0)} 张）`;
          this.beatNote = '这一拍递了纸条，缓存已续';
          return;
        }
        // 推不出去也得让心跳兜底，不然缓存就没人续了
        this.noteNote = '推送失败（宿主的 pushDeferred 没接住），接着试心跳';
      } else {
        this.noteNote = noteDecision.note;
      }

      // ---- 心跳：全天，看 usage 的空档 ----
      const beatPolicy = { idleMinutes: this.settings.idleMinutes, maxPerDay: this.settings.maxPerDay };
      const beatFacts = () => ({ now, lastCallAt, lastBeatAt: this.lastBeatAt, pushedToday: this.beatToday });
      let beatDecision = this.settings.heartbeatEnabled
        ? decideBeat(beatFacts(), beatPolicy)
        : { fire: false as const, note: '静默心跳已关' };
      if (beatDecision.fire) {
        this.hydrateBeat(day, now);
        beatDecision = decideBeat(beatFacts(), beatPolicy); // 补过内存再判一次
      }
      if (!beatDecision.fire) {
        this.beatNote = beatDecision.note;
        return;
      }

      const clock = formatClock(this.opts.timezone, now);
      const fallback = this.language === 'zh' ? DEFAULT_HEARTBEAT_TEXT : DEFAULT_TEMPLATE_EN;
      const text = renderHeartbeat(this.settings.heartbeatText, clock, fallback);
      const sent = await this.push('beat', text);
      if (!sent) {
        this.beatNote = '推送失败（宿主的 pushDeferred 没接住）';
        return;
      }
      this.lastBeatAt = now;
      this.beatToday += 1;
      this.beatNote = `已补一拍（今天 ${this.beatToday} 拍）`;
    } catch (error) {
      this.beatNote = `出错：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.working = false;
    }
  }

  /** 推到下一轮。三个 type 分开声明（见 definition.ts），宿主才知道是插件发的。 */
  private async push(kind: 'beat' | 'note' | 'greeting', text: string, slot?: number): Promise<boolean> {
    const type = `${IDLE_NUDGE_ID}.${kind}`;
    // senderKey 是「回头查今天推过没有」的稳定键（见 sentToday）：greeting:1 / note:0 / beat。
    // 落在事件库里，重启后仍然查得到。
    const senderKey = slot === undefined ? kind : `${kind}:${slot}`;
    const meta = slot === undefined ? {} : { slot };
    if (this.opts.push) return this.opts.push(type, text, senderKey);
    const host = this.host as unknown as {
      pushDeferred?: (event: unknown, opts?: unknown) => Promise<unknown> | unknown;
    } | null;
    const fn = host?.pushDeferred;
    if (typeof fn !== 'function') return false;
    try {
      await fn.call(host, { type, origin: 'internal', senderKey, meta, render: () => text }, { trigger: 'flush' });
      return true;
    } catch {
      return false;
    }
  }

  status(): NudgeStatus {
    return {
      on: this.cfg.enabled,
      lastTickAt: this.lastTickAt,
      lastBeatAt: this.lastBeatAt,
      lastCallAt: this.lastCallAt,
      lastNoteAt: this.lastNoteAt,
      beatToday: this.beatToday,
      noteToday: [...this.noteToday],
      greetingToday: [...this.greetingToday],
      beatNote: this.beatNote,
      noteNote: this.noteNote,
      greetingNote: this.greetingNote,
    };
  }

  /** 只用来挑心跳默认模板的中/英；不依赖 cortico 的 isLanguage（vendor 没 checkout 时那是个坏 import）。 */
  private get language(): 'zh' | 'en' {
    let at = 0;
    try {
      at = statSync(join(this.opts.botDir, 'config.json')).mtimeMs;
    } catch {
      // 默认中文
    }
    if (this.languageCache?.at !== at) {
      let value: 'zh' | 'en' = 'zh';
      try {
        const raw = JSON.parse(readSettingsText(this.opts.botDir)) as { language?: unknown };
        if (raw.language === 'en') value = 'en';
      } catch {
        // 默认中文
      }
      this.languageCache = { at, value };
    }
    return this.languageCache.value;
  }

  // ---- 设置页 ----

  private panelSections(): Array<Record<string, unknown>> {
    const s = this.settings;
    const beatDefault = DEFAULT_HEARTBEAT_TEXT.replace('{time}', '<当前时刻>');
    const noteDefault = DEFAULT_NOTE_TEXT.replace('{time}', '<当前时刻>');
    return [
      {
        id: 'note',
        title: '小纸条（白天的三个时段）',
        description: '在安静的空档里递一句带动作的话。它不看 usage 的 mtime，所以后台推再多信息也挡不住它；只按自己的钟和时段走。去不去做由她定。',
        fields: [
          { key: 'noteEnabled', label: '启用小纸条', kind: 'bool', value: s.noteEnabled, hint: '关掉就一张都不推；不影响静默心跳。' },
          { key: 'noteGapMinutes', label: '两张间隔', kind: 'int', value: s.noteGapMinutes, min: 0, max: 1440, suffix: '分钟', hint: '两张纸条之间至少隔多久（三段共用），防止挨着推。默认 120。' },
          ...s.slots.map((slot, index) => ({
            key: `slot${index}`,
            label: `时段 ${index + 1}`,
            kind: 'slot',
            value: { range: slotRangeText(slot), perDay: slot.perDay },
            rangePlaceholder: '9-12', rangeLabel: '时段',
            sep: '×', countMin: 0, countMax: 24, countLabel: '每天几张',
            hint: '左边填时段（如 9-12 / 14:30-18 / 22-2 跨零点），右边填每天几张。时段留空＝不启用；右端时刻不含。',
          })),
          { key: 'noteText', label: '纸条正文', kind: 'text', value: s.noteText, hint: `留空用默认：${noteDefault}` },
        ],
      },
      {
        id: 'greeting',
        title: '早晚安（两个时刻）',
        description: '到点后由她在窗口内挑一个时刻，递一句「该道早安 / 晚安了」的由头——措辞和走哪条通道都由她自己定。时刻留空就不启用那一条。',
        fields: [
          { key: 'greetingEnabled', label: '启用早晚安', kind: 'bool', value: s.greetingEnabled, hint: '默认关。不需要就别开；开了也不填时刻的话仍不生效。' },
          ...s.greetings.map((g, index) => ({
            key: `greeting${index}`,
            label: index === 0 ? '早安时刻' : '晚安时刻',
            kind: 'slot',
            value: { range: g.time, perDay: g.jitter },
            rangePlaceholder: index === 0 ? '7:30' : '22:30',
            rangeLabel: '时刻',
            sep: '±', countMin: 0, countMax: 240, countLabel: '抖动幅度（分钟）',
            hint: `这一行固定是${index === 0 ? '早安' : '晚安'}——按行算，不按钟点猜，所以 17 点道早安、3 点道晚安也照填：左边写几点该道${index === 0 ? '早安' : '晚安'}（写 17 就是 17:00，写 3 就是 03:00），留空＝这一条不启用；右边填双向抖动幅度（分钟，默认 20）。当天在「这个点 ± 抖动」里哈希挑一个时刻递，隔天换。`,
          })),
        ],
      },
      {
        id: 'heartbeat',
        title: '静默心跳（全天）',
        description: '空档变长就补一条不要求回应的内部事件，让上游前缀缓存不过期。它不说话、不调用工具。⚠️ 不确定就别启用：① 命中不够便宜时补拍反而增加费用；② 有些模型的缓存有效期并不稳定，固定阈值要么白补、要么来不及，这时它帮不上忙只会花钱。换上游前先跑 measure 脚本量一遍，量不出稳定区间就保持关。',
        fields: [
          { key: 'heartbeatEnabled', label: '启用静默心跳', kind: 'bool', value: s.heartbeatEnabled, hint: '默认关。缓存命中不够便宜、或有效期忽长忽短，开了反而更贵。关掉不影响小纸条。' },
          { key: 'idleMinutes', label: '空档阈值', kind: 'int', value: s.idleMinutes, min: 1, max: 1440, suffix: '分钟', hint: '距上次模型调用超过这么久才补一拍。默认 40 是 LongCat-2.5 的值；TTL 不稳的模型填多少都不准——量不出稳定区间就别开这个开关。' },
          { key: 'maxPerDay', label: '每日上限', kind: 'int', value: s.maxPerDay, min: 0, max: 240, suffix: '拍', hint: '一天最多补几拍；0 = 不限。安全阀，防配置写错一直叫醒模型。' },
          { key: 'tickSeconds', label: '看表间隔', kind: 'int', value: s.tickSeconds, min: 5, max: 300, suffix: '秒', hint: '多久查一次上次调用时刻。改完下一拍生效。' },
          { key: 'heartbeatText', label: '心跳正文', kind: 'text', value: s.heartbeatText, hint: `留空用默认：${beatDefault}` },
        ],
      },
      {
        id: 'status',
        title: '现状',
        description: '为什么这一拍没推，都写在这里。三个功能各记各的，互不影响。',
        fields: [
          { key: 'stGreeting', label: '问候', kind: 'text', value: this.status().greetingNote, readonly: true, hint: `今天 ${this.greetingToday.filter(Boolean).length} 条` },
          { key: 'stNote', label: '纸条', kind: 'text', value: this.status().noteNote, readonly: true, hint: `今天 ${this.noteToday.reduce((a, b) => a + b, 0)} 张` },
          { key: 'stBeat', label: '心跳', kind: 'text', value: this.status().beatNote, readonly: true, hint: `今天 ${this.beatToday} 拍` },
        ],
      },
    ];
  }

  private panelPayload(): Record<string, unknown> {
    return {
      sections: this.panelSections(),
      labels: { saved: '已保存', failed: '保存失败' },
    };
  }

  private panelInvoke(panel: string, method: string, args: unknown[]): Record<string, unknown> {
    if (panel !== 'settings') throw new Error(`no such panel: ${panel}`);
    if (method === 'status') return this.panelPayload();
    if (method === 'save') {
      const incoming = (args?.[0] ?? {}) as Record<string, unknown>;
      // 写坏了整份不存：这里抛出去，宿主翻成 500 + {error}，前端把那句话显示在面板底部，
      // 输入框里的内容也不清（webui.js 的 dirty）。clampSettings 只在读盘时兜底，不再替人猜。
      const problem = checkIncoming(incoming, this.settings);
      if (problem) throw new Error(`没有保存：${problem}`);
      const text = (key: string, fallback: string) =>
        typeof incoming[key] === 'string' ? (incoming[key] as string) : fallback;
      const number = (key: string, fallback: number) =>
        typeof incoming[key] === 'number' && Number.isFinite(incoming[key] as number)
          ? incoming[key] as number : fallback;
      const bool = (key: string, fallback: boolean) =>
        typeof incoming[key] === 'boolean' ? incoming[key] as boolean : fallback;
      const next: NudgeSettings = {
        heartbeatEnabled: bool('heartbeatEnabled', this.settings.heartbeatEnabled),
        noteEnabled: bool('noteEnabled', this.settings.noteEnabled),
        greetingEnabled: bool('greetingEnabled', this.settings.greetingEnabled),
        idleMinutes: number('idleMinutes', this.settings.idleMinutes),
        maxPerDay: number('maxPerDay', this.settings.maxPerDay),
        tickSeconds: number('tickSeconds', this.settings.tickSeconds),
        heartbeatText: text('heartbeatText', this.settings.heartbeatText),
        slots: this.settings.slots.map((slot, index) =>
          parseSlotPair(incoming[`slot${index}`], slot)),
        noteGapMinutes: number('noteGapMinutes', this.settings.noteGapMinutes),
        noteText: text('noteText', this.settings.noteText),
        greetings: this.settings.greetings.map((g, index) => {
          // 前端 slot 字段提交 {range, perDay}：这里 range 当时刻、perDay 当抖动幅度
          const raw = incoming[`greeting${index}`] as { range?: unknown; perDay?: unknown } | undefined;
          return {
            time: typeof raw?.range === 'string' ? raw.range : g.time,
            jitter: typeof raw?.perDay === 'number' && Number.isFinite(raw.perDay) ? raw.perDay : g.jitter,
          };
        }),
      };
      this.settings = clampSettings(next, this.settings);
      writeSettings(this.opts.botDir, this.settings);
      return this.panelPayload();
    }
    throw new Error(`no such method: ${panel}.${method}`);
  }

  webUi(): WorldWebUiDecl {
    const st = this.status();
    const gap = st.lastCallAt === null ? '还没读到使用账'
      : `距上次调用 ${minutesOf(this.now() - st.lastCallAt)} 分钟`;
    const nextNote = st.noteToday.reduce((a, b) => a + b, 0);
    // 页头那排药丸（page.badges）：一眼看出三个功能各自开着没、今天各推了多少。
    // 返回处整体 `as WorldWebUiDecl`（同 are-you-there）。`badges` 本身是宿主类型里的字段
    // （见 build/cortico/src/core/types.ts 的 WorldWebUiDecl），真正对不上的是另外两处：
    // `config` 的 schema 用了本包的 ConfigGroupLike（Record<string, unknown>，比宿主宽），
    // `invoke` 返回同步对象而宿主声明的是 Promise<unknown>。不加断言这两处会报类型错。
    const on = this.cfg.enabled;
    const badges = [
      {
        label: '心跳',
        value: !on || !this.settings.heartbeatEnabled ? '关'
          : (this.host === null ? '载入中' : `今天 ${st.beatToday} 拍`),
        tone: (on && this.settings.heartbeatEnabled ? 'on' : 'off') as 'on' | 'off',
      },
      {
        label: '问候',
        value: !on || !this.settings.greetingEnabled ? '关'
          : (this.host === null ? '载入中' : `今天 ${st.greetingToday.filter(Boolean).length} 条`),
        tone: (on && this.settings.greetingEnabled ? 'on' : 'off') as 'on' | 'off',
      },
      {
        label: '纸条',
        value: !on || !this.settings.noteEnabled ? '关'
          : (this.host === null ? '载入中' : `今天 ${nextNote} 张`),
        tone: (on && this.settings.noteEnabled ? 'on' : 'off') as 'on' | 'off',
      },
      { label: '缓存', value: gap.replace('距上次调用 ', ''), tone: 'plain' as const },
    ];
    return {
      label: '小纸条',
      badges,
      panels: [{
        id: 'settings',
        title: '设置',
        description: '早晚安、小纸条（三个时段）、静默心跳（全天）。参数改完下一拍生效，不用重启。',
        getMethods: ['status', 'save'],
      }],
      invoke: (panel: string, method: string, args: unknown[]) => this.panelInvoke(panel, method, args),
      config: [idleNudgeConfigGroup()],
      lamps: [
        {
          label: '问候',
          state: !on || !this.settings.greetingEnabled ? 'offline'
            : (this.host === null ? 'loading' : 'online'),
          hint: `${st.greetingNote}｜今天 ${st.greetingToday.filter(Boolean).length} 条`,
        },
        {
          label: '心跳',
          state: !on || !this.settings.heartbeatEnabled ? 'offline'
            : (this.host === null ? 'loading' : 'online'),
          hint: `${st.beatNote}｜阈值 ${clampIdleMinutes(this.settings.idleMinutes)} 分钟｜${gap}`,
        },
        {
          label: '纸条',
          state: !on || !this.settings.noteEnabled ? 'offline'
            : (this.host === null ? 'loading' : 'online'),
          hint: `${st.noteNote}｜今天 ${nextNote} 张`,
        },
      ],
    } as WorldWebUiDecl;
  }
}

/** language 读 config.json 用；单独抽出来是因为 settings.ts 只管自己的段。 */
function readSettingsText(botDir: string): string {
  // eslint 不 complain：这里就是要读整份文件，settings.ts 的 readSettings 只返回自己的段
  return readFileSync(join(botDir, 'config.json'), 'utf8');
}

