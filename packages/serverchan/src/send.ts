/**
 * 真把一条消息推出去：Turbo 走 GET + query，Server酱³ 走 POST + JSON。
 *
 * 这里只回事实——通道、HTTP 状态、服务端的 code 与 message、哪几项选项被丢了——不写句子，
 * 句子在 `text.ts`。密钥在地址里，所以结果里不带地址，免得回执把它带进对话。
 */
import type { Channel, Target } from './channel.ts';

/** 与 Server酱 后台的默认超时一致；等不到就当没发。 */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** 两家都卡这个数：标题 32 字。 */
export const MAX_TITLE = 32;
/** 正文给足，但别把一整篇文档塞进通知。 */
export const MAX_TEXT = 32_000;

export type IgnoredOption = 'tags';
export type FailureKind = 'http' | 'rejected' | 'not-json' | 'timeout' | 'network';

export interface PushInput {
  title: string;
  /** 正文，Markdown。 */
  desp?: string;
  /** Server酱³ 认标签；Turbo 忽略。 */
  tags?: string[];
}

export type PushOutcome =
  | { ok: true; channel: Channel; code: 0; message: string; ignored: IgnoredOption[] }
  | {
    ok: false;
    channel: Channel;
    kind: FailureKind;
    /** HTTP 状态码；连不上时是 null。 */
    status: number | null;
    /** 服务端返回的 code；没拿到就是 null。 */
    code: number | null;
    /** 服务端的 message，或读取失败时的片段。 */
    message: string;
    ignored: IgnoredOption[];
  };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function pushTo(
  target: Target,
  input: PushInput,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PushOutcome> {
  const tags = normalizeTags(input.tags);
  const ignored: IgnoredOption[] = target.channel === 'turbo' && tags.length > 0 ? ['tags'] : [];
  const request = buildRequest(target, input, tags, timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(request.url, request.init);
  } catch (error) {
    const timeout = isTimeout(error);
    return {
      ok: false,
      channel: target.channel,
      kind: timeout ? 'timeout' : 'network',
      status: null,
      code: null,
      message: errorText(error),
      ignored,
    };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    return {
      ok: false,
      channel: target.channel,
      kind: 'network',
      status: response.status,
      code: null,
      message: errorText(error),
      ignored,
    };
  }

  const parsed = parseJson(raw);
  if (parsed === null) {
    return {
      ok: false,
      channel: target.channel,
      kind: 'not-json',
      status: response.status,
      code: null,
      message: head(raw),
      ignored,
    };
  }

  const code = typeof parsed.code === 'number' ? parsed.code : null;
  const message = typeof parsed.message === 'string' ? parsed.message : '';
  if (!response.ok) {
    return { ok: false, channel: target.channel, kind: 'http', status: response.status, code, message, ignored };
  }
  if (code !== 0) {
    return { ok: false, channel: target.channel, kind: 'rejected', status: response.status, code, message, ignored };
  }
  return { ok: true, channel: target.channel, code: 0, message, ignored };
}

/** 两种通道的请求形状；测试按这个断言「地址没有拼混」。 */
export function buildRequest(
  target: Target,
  input: PushInput,
  tags: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): { url: string; init: RequestInit } {
  const signal = AbortSignal.timeout(timeoutMs);
  const title = input.title;
  const desp = input.desp ?? '';

  if (target.channel === 'turbo') {
    // 旧接口按参考实现的写法：GET + query
    const query = new URLSearchParams({ title, desp });
    return { url: `${target.url}?${query.toString()}`, init: { method: 'GET', signal } };
  }

  const body: Record<string, unknown> = { title, desp };
  if (tags.length > 0) body.tags = tags.join('|');
  return {
    url: target.url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=utf-8' },
      body: JSON.stringify(body),
      signal,
    },
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function parseJson(raw: string): { code?: unknown; message?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as { code?: unknown; message?: unknown }) : null;
  } catch {
    return null;
  }
}

/** 回执里最多带这么长的服务端原文，别把一整页 HTML 塞进对话。 */
function head(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function isTimeout(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
