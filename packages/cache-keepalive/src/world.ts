/**
 * 缓存保温的 World：一个定时器、一次 `statSync`、最多一行事件。
 *
 * 判据在 `beat.ts`（纯函数），这里只负责「读时间、决定推不推、推出去」。三个约定：
 *
 * 1. **定时器无条件起，开关与间隔每拍现读。** 只在 `start()` 里读一次开关的话，设置页改在启动之后
 *    就白改——memory-ledger 的预激活踩过这个坑（`11.9` 坑一）。所以这里是自排期的 `setTimeout`，
 *    每拍按当拍的 `tickSeconds` 重新算下一次。
 * 2. **判据用 `usage.jsonl` 的 mtime。** 宿主每轮模型调用都往这份账里追加一行，
 *    所以它的修改时间就是「上一次调用」的准确时刻；不用自己记账，也不怕重启丢状态。
 * 3. **推出去的事件是 `flush`，不是 `piggyback`。** 这版宿主不认 piggyback（推了等于没推），
 *    而且 piggyback 不唤醒——夜里那 17 条「攒着不投递」的生态箱事件就是这么来的。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import {
  clampAfterMinutes, clampMaxPerDay, clampTickSeconds, decideBeat, formatClock,
  localDay, localHour, parseQuietHours, renderHeartbeat,
  type BeatPolicy, type QuietWindow,
} from './beat.ts';
import {
  CACHE_KEEPALIVE_ID, cacheKeepaliveConfigGroup, defaultTemplate,
  type CacheKeepaliveConfigSection,
} from './config.ts';

export interface CacheKeepaliveWorldOptions {
  /** `worlds.cache-keepalive`，每次使用时读取。 */
  cfg: CacheKeepaliveConfigSection;
  /** 回执里的时刻用这个时区。 */
  timezone: string;
  /** 部署目录，用来读 `config.json` 的语言。 */
  botDir: string;
  /** 运行数据目录，`usage.jsonl` 在这里。 */
  dataDir: string;
  /** 测试可以换掉「读上一次调用时刻」这一步。 */
  usageMtime?: () => number | null;
  /** 测试可以换掉推送那一步。 */
  push?: (text: string) => Promise<boolean>;
  /** 测试可以换掉时钟。 */
  clock?: () => number;
}

/** 设置页与日志里看的现状：为什么这一拍没推。 */
export interface KeepaliveStatus {
  on: boolean;
  lastTickAt: number | null;
  lastBeatAt: number | null;
  lastCallAt: number | null;
  pushedToday: number;
  note: string;
}

export class CacheKeepaliveWorld implements World {
  readonly id = CACHE_KEEPALIVE_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private beating = false;
  private lastTickAt: number | null = null;
  private lastBeatAt: number | null = null;
  private lastCallAt: number | null = null;
  private pushedDay = '';
  private pushedToday = 0;
  private note = '还没跑过第一拍';
  private languageCache: { at: number; value: Language } | null = null;

  constructor(private readonly opts: CacheKeepaliveWorldOptions) {}

  private get cfg(): CacheKeepaliveConfigSection {
    return this.opts.cfg;
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  private get policy(): BeatPolicy {
    return {
      afterMinutes: clampAfterMinutes(this.cfg.afterMinutes),
      quiet: parseQuietHours(this.cfg.quietHours),
      maxPerDay: clampMaxPerDay(this.cfg.maxPerDay),
    };
  }

  /** 不往前缀里加一个字：这个插件的价值在「不花钱」，加一行提示词就白干了。 */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  /** 一个工具都不给：她没有理由知道这件事，知道了反而会去查。 */
  tools(): ToolDef[] {
    return [];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
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

  /**
   * 交接刚结束：这一轮前缀是刚重建的，下一拍的意义只剩「续期」，
   * 而交接前后通常紧接着就有真正的活动。所以把上一拍记成现在，先让出一个阈值。
   */
  onHandoffEnded(): void {
    this.lastBeatAt = this.now();
  }

  /** `usage.jsonl` 的修改时间 = 上一次模型调用的时刻。读不到就返回 null（当作「很久没调用」）。 */
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
   * 自排期的定时器：每拍按当拍的 `tickSeconds` 决定下一次什么时候来。
   * 固定 `setInterval` 的话，改了间隔得等重启才生效——而这个插件最需要的恰恰是「边改边看」。
   */
  private armTimer(): void {
    if (this.timer !== null || this.stopped) return;
    const step = (): void => {
      const ms = clampTickSeconds(this.cfg.tickSeconds) * 1000;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick().finally(step);
      }, ms);
      // 别让这个定时器把进程吊住（are-you-there / memory-ledger 都是这么做的）
      (this.timer as unknown as { unref?: () => void }).unref?.();
    };
    step();
  }

  /** 一拍：看一眼空档够不够长，够长就补一条不要求回应的事件。 */
  private async tick(): Promise<void> {
    const now = this.now();
    this.lastTickAt = now;
    if (!this.cfg.enabled) {
      this.note = '开关关着';
      return;
    }
    if (this.beating || this.host === null) {
      this.note = this.host === null ? '还没挂到宿主上' : '上一拍还没走完';
      return;
    }

    const lastCallAt = this.readUsageMtime();
    this.lastCallAt = lastCallAt;

    // 跨天清零：日上限算的是「今天」
    const day = localDay(this.opts.timezone, now);
    if (this.pushedDay !== day) {
      this.pushedDay = day;
      this.pushedToday = 0;
    }

    const policy = this.policy;
    const decision = decideBeat({
      now,
      lastCallAt,
      lastBeatAt: this.lastBeatAt,
      pushedToday: this.pushedToday,
      hour: localHour(this.opts.timezone, now),
    }, policy);
    if (!decision.fire) {
      this.note = decision.note;
      return;
    }

    this.beating = true;
    try {
      const clock = formatClock(this.opts.timezone, now);
      const text = renderHeartbeat(this.cfg.text, clock, defaultTemplate(this.language));
      const sent = await this.push(text);
      if (!sent) {
        this.note = '推送失败（宿主的 pushDeferred 没接住）';
        return;
      }
      this.lastBeatAt = now;
      this.pushedToday += 1;
      this.note = `已补一拍（今天 ${this.pushedToday} 拍）`;
    } catch (error) {
      this.note = `出错：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.beating = false;
    }
  }

  /**
   * 推一条内部事件到下一轮。
   *
   * `flush` 是唯一确认可用的触发方式（`are-you-there` 在生产里用的就是它）；
   * 它一定等她这一轮跑完才送进去，所以不会打断正在说的话。
   */
  private async push(text: string): Promise<boolean> {
    if (this.opts.push) return this.opts.push(text);
    const host = this.host as unknown as {
      pushDeferred?: (event: unknown, opts?: unknown) => Promise<unknown> | unknown;
    } | null;
    const fn = host?.pushDeferred;
    if (typeof fn !== 'function') return false;
    try {
      await fn.call(host, { type: `${CACHE_KEEPALIVE_ID}.beat`, origin: 'internal', render: () => text },
        { trigger: 'flush' });
      return true;
    } catch {
      return false;
    }
  }

  /** `config.json` 里的语言，文件变了再读一次。 */
  private get language(): Language {
    let at = 0;
    try {
      at = statSync(join(this.opts.botDir, 'config.json')).mtimeMs;
    } catch {
      // 默认中文
    }
    if (this.languageCache?.at !== at) {
      let value: Language = 'zh';
      try {
        const raw = JSON.parse(readFileSync(join(this.opts.botDir, 'config.json'), 'utf8')) as { language?: unknown };
        if (isLanguage(raw.language)) value = raw.language;
      } catch {
        // 默认中文
      }
      this.languageCache = { at, value };
    }
    return this.languageCache.value;
  }

  status(): KeepaliveStatus {
    return {
      on: this.cfg.enabled,
      lastTickAt: this.lastTickAt,
      lastBeatAt: this.lastBeatAt,
      lastCallAt: this.lastCallAt,
      pushedToday: this.pushedToday,
      note: this.note,
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const zh = language === 'zh' || language === 'zh-Hant';
    const gap = this.lastCallAt === null
      ? (zh ? '还没读到使用账' : 'no usage ledger yet')
      : (zh
        ? `距上次调用 ${Math.max(0, Math.round((this.now() - this.lastCallAt) / 60_000))} 分钟`
        : `${Math.max(0, Math.round((this.now() - this.lastCallAt) / 60_000))} min since the last call`);
    const hint = `${this.note}｜阈值 ${clampAfterMinutes(this.cfg.afterMinutes)} 分钟｜${gap}`;
    return {
      label: zh ? '缓存保温' : 'Cache keepalive',
      config: [cacheKeepaliveConfigGroup(language)],
      lamps: [{
        label: zh ? '保温' : 'Warm',
        state: this.cfg.enabled ? (this.host === null ? 'loading' : 'online') : 'offline',
        hint,
      }],
    };
  }
}

/** 便于上层与测试复用的解析结果。 */
export type { QuietWindow };
