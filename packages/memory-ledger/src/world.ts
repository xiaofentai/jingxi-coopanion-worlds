/**
 * 记忆树网的 World。
 *
 * 三条路，互不打扰：
 * - 出卡：只在构建系统前缀时读一次目录、裁一张板，作为 `ml.*` 变量交出去。
 * - 工具：写盘与召回，经 `ml_*` 调用。它们不改前缀，只把结果放进回执。
 * - 预激活（可选）：一个定时器盯着事件库，他说完一句就替她查一次，**只推事件、不碰前缀**。
 *   所以前缀仍然是「交接时算一次」——事件是追加，不是替换。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { buildBoard } from './board.ts';
import { ensureArchiveFile } from './archive.ts';
import {
  MEMORY_LEDGER_ID, memoryLedgerConfigGroup, splitList, type MemoryLedgerConfigSection,
} from './config.ts';
import {
  archiveFileOf, archiveFor, clampSettings, pastFileOf, readSettings,
  rulesText, todayFileOf, writeSettings, type LedgerSettings,
} from './settings.ts';
import { readRuleDocs } from './audit.ts';
import { PRIME_LIMIT, coolEnough, primeHits, primeKey, primeText, withinDailyBudget } from './prime.ts';
import { readRecent, type RecentSay } from './recent.ts';
import { recall } from './recall.ts';
import { buildInjection, detectGame, parseFamilyMap, type LogItem } from './route.ts';
import { parseDoc } from './parse.ts';
import { PROMPT_VARS, memoryLedgerText, textLanguage, type TextLanguage } from './text.ts';
import { createLedgerTools } from './tools.ts';

const ENV_PROMPT_FILES: Record<TextLanguage, string> = {
  zh: fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('../ENV_PROMPT.en.md', import.meta.url)),
};

/**
 * 预激活多久看一眼事件库。
 *
 * **快慢无所谓。** 注入是轮边界投递的：事件先进队列，等她这一轮跑完才送进去。
 * 所以 2 秒和 60 秒的差别只是「在队列里等多久」，永远追不上「她开口之前」——
 * 实测 60 秒时注入在她答完之后 30 秒到，改成 2 秒也只会变成答完之后 2 秒到。
 *
 * 既然注定是补充，就取 30 秒：代价是一次内存切片读取，换「答完半分钟内就补上」。
 */
const PRIME_TICK_MS = 30_000;

/**
 * 拿不到身份时最多等几拍再送目录档。
 *
 * 3 拍 ≈ 90 秒：客厅开局后身份通常立刻就有，等一等是为了不让「还没发牌」被当成
 * 「这平台不给身份」。一局只在最后送一次，不会目录档和角色档各送一遍。
 */
const ROUTE_BLIND_TICKS = 3;

export interface MemoryLedgerWorldOptions {
  /** 配置段 `worlds.memory-ledger`，每次使用时读取，所以改完不用重启。 */
  cfg: MemoryLedgerConfigSection;
  /** 部署目录，相对目录以它为准；config.json 也在这里。 */
  botDir: string;
  /** 卡抬头的时区。 */
  timezone: string;
}

export class MemoryLedgerWorld implements World {
  readonly id = MEMORY_LEDGER_ID;
  private host: WorldHost | null = null;
  private languageCache: { at: number; value: Language } | null = null;
  // ---- 预激活的状态：都是会话内的，重启就清空 ----
  private primeTimer: ReturnType<typeof setInterval> | null = null;
  /** 已经为哪一句查过了（用游标做 key，同一句不重复查）。 */
  private primedFor = '';
  /** 每一块上次被推的时间。重启会丢，最坏是重启后再推一次同一块。 */
  private readonly primedAt = new Map<string, number>();
  /** 记下的对局：重启会丢，首拍只建状态不推，避免把上一局的残留再念一遍。 */
  private routeStarted = false;
  /** 身份还没拿到时，已经等了几拍。目录档只在等够之后才送。 */
  private readonly routeBlind = new Map<string, number>();
  private priming = false;
  /** 他刚说的那句、那一轮她查过没有。查没查只有我们知道——工具是我们的。 */
  private activeAsk: { at: number; text: string; checkedAt: number | null } | null = null;
  /** 已经记过账的那一句。 */
  private askedKey = '';
  /** 最近一拍的时间：只在「定时器真的在跑」时才会往前走。 */
  private lastTickAt: number | null = null;
  /** 这次会话推过几次。 */
  private pushed = 0;
  /** 今天推过几次、是哪天——跨天自动清零。 */
  private pushedToday = 0;
  private pushedDay = '';
  /** 今天有没有提醒过「该整理」。写盘回执问它，一天只放行一次。 */
  private dueNoticedDay = '';
  /** 上一拍停在哪一步。`ml_check` 直接报出来，省得靠猜。 */
  private lastNote = '';

  private readonly opts: MemoryLedgerWorldOptions;
  /** 三份索引规则，和开关一起住在 config.json 的 worlds.memory-ledger 段里。 */
  private settings: LedgerSettings;

  // 不用参数属性：Node 的 strip-only 模式不认这种写法，测试就 import 不了这个文件
  constructor(opts: MemoryLedgerWorldOptions) {
    this.opts = opts;
    this.settings = readSettings(opts.botDir, opts.cfg);
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

  /** 记忆目录来自独立设置；空值落在部署目录的 `workspace` 上。 */
  private boardFolder(): string {
    const raw = (this.settings.folder || '').trim() || 'workspace';
    return isAbsolute(raw) ? resolve(raw) : resolve(join(this.opts.botDir, raw));
  }

  envPromptVars(): Record<string, string> {
    const language = textLanguage(this.language);
    const day = today(this.opts.timezone);
    const result = buildBoard({
      folder: this.boardFolder(),
      rules: rulesText(this.settings),
      listOthers: false,
      listMax: 0,
      exclude: splitList(this.cfg.exclude),
      stamp: stamp(this.opts.timezone),
      today: day,
      language,
      archiveFile: archiveFileOf(this.settings),
    });
    // 开口前召回是实验项：开关关着时这个变量是空串，模板里那一行自然消失
    const hint = this.settings.recallOnSpeak ? memoryLedgerText(language).hintRecall : '';
    // 三层文件名由三张卡推导：改名只改设置页一处
    const layers = memoryLedgerText(language).layers(
      todayFileOf(this.settings),
      pastFileOf(this.settings),
      archiveFileOf(this.settings),
    );
    // 心跳：不提供内容，只提供「系统还活着」。份数掉了或覆盖日期停住，就是有东西没读到。
    const health = memoryLedgerText(language).health(
      result.loaded.length,
      result.cover.from,
      result.cover.to,
      day,
    );
    return {
      'ml.health': health,
      'ml.meta': result.meta,
      'ml.card': result.card,
      'ml.policy': result.policy,
      'ml.layers': layers,
      'ml.hint': hint,
    };
  }

  /** 写入口：只碰块，不碰行；每次调用现读文件，所以配置改了不用重启。 */
  tools(): ToolDef[] {
    return createLedgerTools({
      folder: () => this.boardFolder(),
      rules: () => rulesText(this.settings),
      backupDir: () => join(this.opts.botDir, 'data', 'memory-ledger'),
      today: () => today(this.opts.timezone),
      todayFile: () => todayFileOf(this.settings),
      pastFile: () => pastFileOf(this.settings),
      archiveFile: () => archiveFileOf(this.settings),
      archiveFor: (file, date) => archiveFor(this.settings, file, date),
      recent: () => this.recentSay(),
      prime: () => this.primeStatus(),
      ask: () => this.askStatus(),
      onRecall: () => this.markRecall(),
      dueNotice: () => this.dueNotice(),
      route: () => this.routeStatus(),
    });
  }

  /**
   * 对方刚说的最后一句：从宿主的事件库读（`origin: 'external'`），不读 session jsonl。
   *
   * 三种结果分开报，因为排查时它们是三件事：
   * `undefined` = 这个宿主没有事件库；`null` = 有库，但十分钟内没人说话；否则就是那一句。
   */
  private recentSay(): RecentSay | null | undefined {
    const store = (this.host as unknown as { store?: unknown } | null)?.store;
    const range = (store as { range?: unknown } | null)?.range;
    if (typeof range !== 'function') return undefined;
    return readRecent(store, { now: Date.now() });
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.ensureArchive();
    this.startPriming();
  }

  /**
   * 预激活的定时器：只推事件，不碰前缀。
   *
   * **不看开关就起**——开关每拍现读。这样设置页一改，下一分钟就生效、不用重启；
   * 只在 `start()` 里读一次的话，改在启动之后就白改（这个坑今晚刚踩过）。
   * 关着的时候一拍只是读个布尔值，代价可以忽略。
   */
  private startPriming(): void {
    if (this.primeTimer) return;
    this.primeTimer = setInterval(() => {
      void this.primeOnce();
      // 和预激活共用一个 tick：两件事都是「看一眼、有新东西就推」，没必要两个定时器
      void this.routeOnce();
    }, PRIME_TICK_MS);
    // 别让这个定时器把进程吊住（are-you-there 也是这么做的）
    (this.primeTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 推过的对局：同一局只推一次。 */
  private routedGames = new Set<string>();

  /** 路由上一拍在干什么，出错时要能说出来。 */
  private routeNote = '';

  /**
   * 每拍看一眼「她是不是刚进了一局」。
   *
   * 四条边界都写这儿：
   * - 首拍只建状态：重启后日志里可能还留着上一局的牌桌，不补发；
   * - 认局靠 `session-main.jsonl`（事件库里没有 ownRole）；
   * - 身份没拿到时先等几拍（约 90 秒），再退到目录档；期间拿到身份就送角色档；
   * - 同一局只送一次，否则每 30 秒念一遍。
   */
  private async routeOnce(): Promise<void> {
    if (!this.settings.gameRoute) return;
    // 重启不补发：第一拍只把状态建起来，哪怕日志里残留着一局进行中的牌桌
    if (!this.routeStarted) {
      this.routeStarted = true;
      this.routeNote = '首拍只记状态，不补发';
      return;
    }
    try {
      const items = this.readSessionItems();
      const state = detectGame(items);
      if (!state) {
        this.routeNote = '不在对局';
        return;
      }
      if (this.routedGames.has(state.gameId)) {
        this.routeNote = '这一局已经给过';
        return;
      }

      const found = this.findGameDoc(state.family);
      if (!found) {
        // 说不出来比不说好：她下次新建游戏文件时才知道要写这行
        this.routeNote = `没有哪个 games 文件的文件头写着 family: ${state.family}`;
        return;
      }

      // 身份还没拿到：先等几拍。拿到身份就走角色档；等够了还拿不到才退到目录档。
      if (!state.role) {
        const waited = (this.routeBlind.get(state.gameId) ?? 0) + 1;
        this.routeBlind.set(state.gameId, waited);
        if (waited < ROUTE_BLIND_TICKS) {
          this.routeNote = `${state.family} 还没发牌（等 ${waited}/${ROUTE_BLIND_TICKS} 拍）`;
          return;
        }
        this.routeNote = `${state.family} 还没发牌，等够了——退到目录档`;
      }

      const roleName = state.role ? (found.map.roles[state.role.toLowerCase()] ?? null) : null;
      const injected = buildInjection(state, found.rel, found.doc.blocks, roleName);
      const sent = await this.pushPrime(injected.text);
      if (!sent) {
        this.routeNote = '推送失败（宿主的 pushDeferred 没接住）';
        return;
      }
      // 送成功才记账：失败时下一拍还能重试，不会白白吃掉这一局的唯一名额
      this.routedGames.add(state.gameId);
      this.routeBlind.delete(state.gameId);
      this.routeNote = state.role
        ? `推了 ${found.rel}（${state.family} / ${state.role}）`
        : `推了目录档（${state.family}，始终没拿到身份）`;
    } catch (error) {
      this.routeNote = `出错：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 上次解析时的文件大小：没变就不重读（这个文件一局能涨几十行）。 */
  private logSize = -1;
  private logItems: LogItem[] = [];

  /**
   * 会话日志的最后一批条目；读不到就给空数组（第一局还没开时就是空的）。
   *
   * 窗口取 800 行：一局大概几十到两百行，够覆盖最近几局。文件没变就用上次的结果——
   * 这文件几兆，每 30 秒重解析一遍不值得。
   */
  private readSessionItems(): LogItem[] {
    const file = join(this.opts.botDir, 'data', 'session-main.jsonl');
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    if (size === this.logSize) return this.logItems;

    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    const items: LogItem[] = [];
    for (const line of lines.slice(-800)) {
      try {
        const row = JSON.parse(line) as { item?: LogItem };
        if (row.item) items.push(row.item);
      } catch {
        // 半行/坏行跳过，不让它把整拍打断
      }
    }
    this.logSize = size;
    this.logItems = items;
    return items;
  }

  /** 找文件头写着 `family: xxx` 的那份；顺便把它的映射带出来。 */
  private findGameDoc(family: string): { rel: string; doc: ReturnType<typeof parseDoc>; map: ReturnType<typeof parseFamilyMap> } | null {
    const folder = join(this.boardFolder(), 'games');
    if (!existsSync(folder)) return null;
    const day = today(this.opts.timezone);
    const year = Number(day.slice(0, 4));
    const wanted = family.trim().toLowerCase();
    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.md')) continue;
      const rel = `games/${name}`;
      try {
        const doc = parseDoc(readFileSync(join(folder, name), 'utf8'), rel, year, day);
        const map = parseFamilyMap(doc.front);
        if (map && map.family.toLowerCase() === wanted) return { rel, doc, map };
      } catch {
        // 读不动就跳过，别因为一个坏文件让整拍失败
      }
    }
    return null;
  }

  /** 路由的状态，`ml_check` 用一行说清楚它活着没有。 */
  routeStatus(): { on: boolean; note: string; games: number } {
    return { on: this.settings.gameRoute, note: this.routeNote, games: this.routedGames.size };
  }

  /**
   * 预激活的状态：开关、最近一拍、推过几次、上一拍停在哪。`ml_check` 拿它证明这一层活着。
   *
   * `today` 和 `pushed` 是**两个数**：预算只管当天，`pushed` 是进程启动以来的累计。
   * 以前 `ml_check` 只报后者，跑两天就会显示「已推 7 次」，而 cap 是 3——看着像超了，
   * 其实那是跨天的总数。两个都报出来，就不用猜。
   */
  primeStatus(): { on: boolean; lastTick: number | null; pushed: number; today: number; cap: number; note: string } {
    const day = today(this.opts.timezone);
    return {
      on: this.settings.preactivate,
      lastTick: this.lastTickAt,
      pushed: this.pushed,
      // 今天还没跑过拍时，pushedDay 还是昨天，那时今天就是 0
      today: this.pushedDay === day ? this.pushedToday : 0,
      cap: this.settings.preactivatePerDay,
      note: this.lastNote,
    };
  }

  /**
   * 每拍看一眼「他有没有新说一句」。
   *
   * 这是「她查没查」的另一半：他说话的时间我们看得见，`ml_recall` 的调用也是我们的工具。
   * 两边一合，就知道每轮她有没有在开口前查——不用问她，也不用读会话日志。
   */
  private noteAsk(): void {
    const recent = this.recentSay();
    if (!recent) return;
    const key = recent.cursor >= 0 ? `c${recent.cursor}` : `t${recent.at}`;
    if (key === this.askedKey) return;
    // 连发：一分钟内的几条算同一轮（她一般到最后一条才回），只换内容、不另起账；
    // 起止时间仍按第一条算，这样「几秒后查的」量的是他心里那一句到召回的距离。
    if (this.activeAsk && recent.at - this.activeAsk.at < 60_000) {
      this.activeAsk = { ...this.activeAsk, text: recent.text };
      this.askedKey = key;
      return;
    }
    // 新的一轮：把上一轮结掉
    this.settleAsk();
    this.askedKey = key;
    this.activeAsk = { at: recent.at, text: recent.text, checkedAt: null };
    this.probe({ at: new Date().toISOString(), kind: 'ask', said: clipText(recent.text, 60) });
  }

  /** 这一轮结束（他的下一句话来了 / 世界停了）：把「查没查」落一行账。 */
  private settleAsk(): void {
    const ask = this.activeAsk;
    if (!ask) return;
    this.probe({
      at: new Date().toISOString(),
      kind: 'turn',
      askedAt: new Date(ask.at).toISOString(),
      said: clipText(ask.text, 60),
      checked: ask.checkedAt !== null,
      delaySec: ask.checkedAt === null ? null : Math.max(0, Math.round((ask.checkedAt - ask.at) / 1000)),
    });
    this.activeAsk = null;
  }

  /** `ml_recall` 被调用时进来一次：这一轮她查过了。 */
  markRecall(): void {
    if (this.activeAsk && this.activeAsk.checkedAt === null) this.activeAsk.checkedAt = Date.now();
  }

  /**
   * 到期提醒的闸：一天只放行一次。
   *
   * 不做定时兜底——她整天不说话时推一个事件，等于无故开一轮对话叫她去整理，
   * 比「漏一天」更糟。写盘时她在场，那才是最合适的时机。
   */
  private dueNotice(): boolean {
    const day = today(this.opts.timezone);
    if (this.dueNoticedDay === day) return false;
    this.dueNoticedDay = day;
    return true;
  }

  /** `ml_check` 用：这一轮他说的那句 + 她查了没有。 */
  askStatus(): { at: number; text: string; checkedAt: number | null } | null {
    return this.activeAsk ? { ...this.activeAsk } : null;
  }

  /** 埋点：一行 JSON。写不进去就算了，不该影响任何行为。 */
  private probe(entry: Record<string, unknown>): void {
    try {
      const dir = join(this.opts.botDir, 'data', 'memory-ledger');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'recall.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // 埋点失败不影响行为
    }
  }

  /**
   * 一拍：看有没有「刚说的那一句」，有就替她查一次。
   *
   * 四道闸都过了才推：十分钟内有人说话、这句没查过、命中里还有不在冷却的、宿主收下了。
   * 任何一步不满足就安静地什么都不做——预激活是附加功能，坏了不该影响别的。
   */
  private async primeOnce(): Promise<void> {
    // 先记这一拍：`ml_check` 里「上次检查」不往前走，就是定时器没在跑
    this.lastTickAt = Date.now();
    // 不管预激活开不开，都要盯「他刚说的那句」——这是判断她查没查的另一半
    this.noteAsk();
    // 每一步的出口都留一句话，`ml_check` 直接报它——不然「没推」到底是哪一步卡住，只能猜
    if (!this.settings.preactivate) {
      this.lastNote = '开关关着';
      return;
    }
    if (this.priming || !this.host) {
      this.lastNote = '上一拍还没走完';
      return;
    }
    const recent = this.recentSay();
    if (recent === undefined) {
      this.lastNote = '读不到事件库';
      return;
    }
    if (recent === null) {
      this.lastNote = '十分钟内没人说话';
      return;
    }
    const key = recent.cursor >= 0 ? `c${recent.cursor}` : `t${recent.at}`;
    if (this.primedFor === key) {
      this.lastNote = '这一句已经查过';
      return;
    }
    // 自抑制：这一轮她自己查过了，就不再递。昨晚那次「同一件事说两遍」就是这么来的。
    if (this.activeAsk && this.activeAsk.checkedAt !== null && this.askedKey === key) {
      this.primedFor = key;
      this.lastNote = '这一轮她自己查过，不重复递';
      return;
    }

    this.priming = true;
    try {
      const day = today(this.opts.timezone);
      // 日预算：一天推几次由配置定，默认 6。跨天自动清零。
      if (this.pushedDay !== day) {
        this.pushedDay = day;
        this.pushedToday = 0;
      }
      const cap = this.settings.preactivatePerDay;
      if (!withinDailyBudget(this.pushedToday, cap)) {
        this.primedFor = key;
        this.lastNote = `今天的名额用完了（${cap} 次）`;
        return;
      }
      const docs = readRuleDocs(this.boardFolder(), rulesText(this.settings), Number(day.slice(0, 4)), day)
        .map(({ doc }) => doc);
      // 不认日期：事件文本自带「[11-13 周五 23:03]」，认了就会每次偏向今天
      // 比到块那一层：日块拿首行（那一天的一句话），大事记按条（每条本来就是一行一件事）
      const hits = recall(docs, {
        query: recent.text,
        today: day,
        limit: PRIME_LIMIT * 3,
        useDates: false,
        level: 'block',
      });
      const picked = coolEnough(this.primedAt, primeHits(hits), Date.now());
      // 这一句查过了，不管有没有命中都不再查——否则每拍都要重算一遍
      this.primedFor = key;
      const strong = primeHits(hits).length;
      if (!picked.length) {
        this.lastNote = strong ? `命中 ${strong} 条，全在冷却里` : `候选 ${hits.length} 条，没有对得上的`;
        return;
      }

      const sent = await this.pushPrime(primeText(picked));
      if (!sent) {
        this.lastNote = '推送失败（宿主的 pushDeferred 没接住）';
        return;
      }
      this.pushed += 1;
      this.pushedToday += 1;
      this.lastNote = `已推 ${picked.length} 条（今天 ${this.pushedToday}/${cap}）`;
      // 留一行账：不然「今天推了几次」只能翻 session 日志去数，而那两个数对不上时没法自证
      this.probe({ at: new Date().toISOString(), kind: 'prime', hits: picked.length, today: this.pushedToday, cap });
      const at = Date.now();
      for (const hit of picked) this.primedAt.set(primeKey(hit), at);
    } catch (error) {
      this.lastNote = `出错：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.priming = false;
    }
  }

  /**
   * 把一段话递到下一轮。
   *
   * `pushDeferred` 是宿主给 World 的接口（`are-you-there` 在生产里用它推「ta 回来了」）。
   * `piggyback` = 搭在下一次模型调用上，不额外开一轮；这个时机不支持就退回 `flush`。
   */
  private async pushPrime(text: string): Promise<boolean> {
    const host = this.host as unknown as {
      pushDeferred?: (event: unknown, opts?: unknown) => Promise<unknown> | unknown;
    } | null;
    const push = host?.pushDeferred;
    if (typeof push !== 'function') return false;
    const event = { type: `${MEMORY_LEDGER_ID}.prime`, origin: 'internal', render: () => text };
    // 先用 `flush`：`are-you-there` 在生产里用的就是这个，能确认这版宿主认它。
    // `piggyback`（搭下一次调用、不额外开一轮）更好，但它在这版宿主里没被验证过，做后备。
    try {
      await push.call(host, event, { trigger: 'flush' });
      return true;
    } catch {
      try {
        await push.call(host, event, { trigger: 'piggyback' });
        return true;
      } catch {
        return false;
      }
    }
  }

  /** 启用时先把归档文件建出来：设置页的选择器要能选到它，第一次 `ml_delete(…, keep=true)` 也不该失败。 */
  private ensureArchive(): void {
    ensureArchiveFile(this.boardFolder(), archiveFileOf(this.settings));
  }

  async stop(): Promise<void> {
    if (this.primeTimer) {
      clearInterval(this.primeTimer);
      this.primeTimer = null;
    }
    // 最后一轮也要落账，否则「她到底查没查」会少一条
    this.settleAsk();
    this.host = null;
  }

  /** 独立「设置」页：大事记 / 近期 / 超近期各一张卡，公共参数另放一张。 */
  private panelSections(language: Language): Array<Record<string, unknown>> {
    const t = memoryLedgerText(language);
    const c = t.config;
    const s = this.settings;
    const ruleSections = s.rules.map((rule, index) => {
      const name = t.panel.ruleTitle(index);
      const fields: Array<Record<string, unknown>> = [
        {
          key: `file${index}`, label: t.panel.file(name), kind: 'text',
          value: rule.file, hint: t.panel.fileHint,
        },
        {
          key: `days${index}`, label: t.panel.days(name), kind: 'int',
          value: rule.days, min: 0, max: 3650, suffix: t.panel.daysSuffix, hint: t.panel.daysHint,
        },
        {
          key: `cap${index}`, label: t.panel.cap(name), kind: 'int',
          value: rule.cap, min: 0, max: 10000, suffix: t.panel.capSuffix, hint: t.panel.capHint,
        },
      ];
      // 超近期不归档；其余两份各自填自己的归档目标
      if (index !== 2) {
        fields.push({
          key: `archive${index}`, label: t.panel.archive(name), kind: 'text',
          value: rule.archive, hint: t.panel.archiveHint,
        });
      }
      return {
        id: `rule${index}`,
        title: name,
        description: t.panel.ruleDescription(index),
        fields,
      };
    });
    return [
      ...ruleSections,
      {
        id: 'common',
        title: t.panel.commonTitle,
        description: t.panel.commonDescription,
        fields: [
          {
            key: 'folder', label: c.folder.title, kind: 'text',
            value: s.folder, hint: c.folder.description,
          },
          {
            key: 'recallOnSpeak', label: c.recallOnSpeak.title, kind: 'bool',
            value: s.recallOnSpeak, hint: c.recallOnSpeak.description,
          },
          {
            key: 'preactivate', label: c.preactivate.title, kind: 'bool',
            value: s.preactivate, hint: c.preactivate.description,
          },
          {
            key: 'preactivatePerDay', label: c.preactivatePerDay.title, kind: 'int',
            value: s.preactivatePerDay, min: 0, max: 20,
            suffix: t.panel.timesSuffix, hint: c.preactivatePerDay.description,
          },
          {
            key: 'gameRoute', label: c.gameRoute.title, kind: 'bool',
            value: s.gameRoute, hint: c.gameRoute.description,
          },
        ],
      },
    ];
  }

  private panelPayload(language: Language): Record<string, unknown> {
    const t = memoryLedgerText(language);
    return {
      sections: this.panelSections(language),
      labels: { saved: t.panel.saved, failed: t.panel.saveFailed('') },
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
        typeof incoming[key] === 'string' && (incoming[key] as string).trim()
          ? (incoming[key] as string).trim()
          : fallback;
      const number = (key: string, fallback: number) =>
        typeof incoming[key] === 'number' && Number.isFinite(incoming[key] as number)
          ? incoming[key] as number
          : fallback;
      const bool = (key: string, fallback: boolean) =>
        typeof incoming[key] === 'boolean' ? incoming[key] as boolean : fallback;
      const next: LedgerSettings = {
        folder: text('folder', this.settings.folder),
        recallOnSpeak: bool('recallOnSpeak', this.settings.recallOnSpeak),
        preactivate: bool('preactivate', this.settings.preactivate),
        preactivatePerDay: number('preactivatePerDay', this.settings.preactivatePerDay),
        gameRoute: bool('gameRoute', this.settings.gameRoute),
        rules: this.settings.rules.map((rule, index) => ({
          file: text(`file${index}`, rule.file),
          days: number(`days${index}`, rule.days),
          cap: number(`cap${index}`, rule.cap),
          // 归档允许清空；clampSettings 会区分「没提交」和「提交空串」
          archive: typeof incoming[`archive${index}`] === 'string'
            ? (incoming[`archive${index}`] as string).trim().slice(0, 240)
            : rule.archive,
        })),
      };
      this.settings = clampSettings(next, this.settings);
      writeSettings(this.opts.botDir, this.settings);
      return this.panelPayload(language);
    }
    throw new Error(`no such method: ${panel}.${method}`);
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = memoryLedgerText(language);
    const chosen = ENV_PROMPT_FILES[textLanguage(this.language)];
    return {
      label: t.label,
      panels: [{
        id: 'settings',
        title: t.panel.title,
        description: t.panel.description,
        getMethods: ['status', 'save'],
      }],
      invoke: (panel: string, method: string, args: unknown[]) => this.panelInvoke(panel, method, args, language),
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
          ...(name === 'ml.card' ? { multiline: true } : {}),
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

/** 埋点里留多少字：够认出是哪句，又不至于把整句存下来。 */
function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** `YYYY-MM-DD`，配置时区；判覆盖用。 */
function today(timezone: string): string {
  const at = parts(timezone);
  if (at) return `${at.year}-${at.month}-${at.day}`;
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}
