/**
 * 最近一句：从宿主的 external 事件里挑出「刚跟她说的话」。
 *
 * 它是预激活和场景路由的入口——两者都得先知道「对方刚说了什么」。
 * 数据源是宿主的 `event store`（`origin: 'external'`），**不读 session jsonl**：
 * 那份文件要自己切、要自己猜格式，而事件库给的是结构化字段（senderKey / ts / cursor）。
 *
 * 这里只有纯函数，不碰 IO；拿不到库就返回 null——路由是可选功能，缺了不该影响别处。
 */

/**
 * 宿主事件的最小形状。宿主给的是宽类型，这里只认用得上的几个字段。
 *
 * 实测（`GET /api/events`）：`senderKey` 是**来源**（`desktop-pet.chat`、他的微信 id、
 * `starpost.owner`），`type` 才是**这件事是什么**（`clawbot.message`、`starpost.owner_message`、
 * `terrarium.irrigation`）。判「是不是有人说话」必须看 `type`，看来源会漏掉星邮主人消息。
 */
export interface SayEvent {
  text?: unknown;
  ts?: unknown;
  cursor?: unknown;
  type?: unknown;
  senderKey?: unknown;
  /** `external` = 外面来的；`internal` = 宿主自己产生的（连接提示、交接、定时事件）。 */
  origin?: unknown;
}

export interface RecentSay {
  /** 原话（已 trim）。 */
  text: string;
  /** 毫秒时间戳。 */
  at: number;
  /** 宿主的事件游标；-1 表示这条没给游标，调用方只能拿时间戳去重。 */
  cursor: number;
}

/**
 * 什么算「人说的话」：**事件类型的后缀**，不是来源。
 *
 * 现在实际有的是 `clawbot.message`（微信）、`desktop-pet.message`（桌宠里打的字）、
 * `starpost.owner_message`（星邮里主人发的）。三类都收；`notification_digest`、
 * `game_view`、`handoff-note` 这些虽然也是 external，但不是他说话，一律不收。
 *
 * 将来加渠道只要类型也叫 `xxx.message` / `xxx.owner_message` 就自动算进来；
 * 真有个新工具不按这个约定，调用方传一个自己的正则就行（这一层不改）。
 */
export const DEFAULT_SENDERS = /(^|\.)(message|owner_message)$/;

/** 超过这么久就不算「刚说的」：太旧的句子拿来做线索，只会捞出不相干的东西。 */
export const DEFAULT_MAX_AGE_MS = 10 * 60_000;

/** 太短的不算一句话（「嗯」「好」这种拿去找记忆，只会撞一堆噪音）。 */
export const DEFAULT_MIN_CHARS = 4;

export interface RecentOptions {
  /** 现在（毫秒）。传进来而不是内部取，方便测试。 */
  now: number;
  /** 匹配事件 `type` 的正则；不传就用 `DEFAULT_SENDERS`。 */
  senders?: RegExp;
  maxAgeMs?: number;
  minChars?: number;
}

/** 正则如果带 `g`，`.test` 会记住 lastIndex，第二次就漏——统一剥掉。 */
function safe(re: RegExp): RegExp {
  return re.global ? new RegExp(re.source, re.flags.replace('g', '')) : re;
}

/** 从一批事件里挑出最新、够长、够新的一句话。没有就 null。 */
export function pickRecent(events: readonly SayEvent[], opts: RecentOptions): RecentSay | null {
  const senders = safe(opts.senders ?? DEFAULT_SENDERS);
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;

  let best: RecentSay | null = null;
  for (const event of events) {
    // 宿主自己产生的事件（连接提示、交接、定时）先排掉；没写 origin 的照单全收
    if (typeof event.origin === 'string' && event.origin !== 'external') continue;
    const kind = String(event.type ?? event.senderKey ?? '');
    if (!senders.test(kind)) continue;
    const at = Date.parse(String(event.ts ?? ''));
    if (!Number.isFinite(at)) continue;
    if (opts.now - at > maxAge) continue;
    const text = String(event.text ?? '').trim();
    if (text.length < minChars) continue;
    if (best && at <= best.at) continue;
    const cursor = Number(event.cursor);
    best = { text, at, cursor: Number.isFinite(cursor) ? cursor : -1 };
  }
  return best;
}

/**
 * 从宿主的事件库读一次。库不在、读不出、形状不对，一律返回 null，不抛。
 *
 * `store` 用宽类型收：`WorldHost` 的完整类型不在仓库里（vendored 的 cortico 没同步），
 * 所以这里只认「有个 range 方法」这一件事。
 */
export function readRecent(
  store: unknown,
  opts: RecentOptions & { limit?: number },
): RecentSay | null {
  const range = (store as { range?: (query: { origin?: string; limit?: number }) => unknown } | null)?.range;
  if (typeof range !== 'function') return null;
  let events: unknown;
  try {
    events = range.call(store, { origin: 'external', limit: Math.max(1, opts.limit ?? 60) });
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  return pickRecent(events as SayEvent[], opts);
}
