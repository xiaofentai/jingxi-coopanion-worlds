/**
 * 把 SendKey 认成两种通道之一，并拼出推送地址。
 *
 * 两家的地址只差一点点，写混了就永远发不出去，所以单独放一个文件、单独写测试：
 *
 * - Turbo（旧版）：`https://sctapi.ftqq.com/<sendkey>.send`
 * - Server酱³：`https://<uid>.push.ft07.com/send/<sendkey>.send`
 *
 * ³ 的 `<uid>` 不在配置里，藏在 SendKey 中间——`sctp<uid>t<token>`，开头 `sctp`，后面紧跟数字，
 * 再一个 `t`。拿不到这个数字就拼不出地址，只能报错，不能退回 Turbo 的域名（那样一定失败）。
 */
export type Channel = 'turbo' | 'sc3';

/** `auto` 看 SendKey 的形状；另外两个值是手工覆盖。 */
export type ChannelChoice = 'auto' | Channel;

export const TURBO_HOST = 'sctapi.ftqq.com';
export const SC3_HOST_SUFFIX = 'push.ft07.com';
/** `sctp1234txxxx` 里的 1234。 */
const SC3_KEY = /^sctp(\d+)t/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface Target {
  channel: Channel;
  sendkey: string;
  /** Server酱³ 的数字子域；Turbo 没有。 */
  uid: string | null;
  /** 单留一份主机名给回执看。 */
  host: string;
  /** 完整推送地址；路径里带着 SendKey，别写进回执。 */
  url: string;
}

export type KeyProblem = 'empty' | 'no-uid' | 'not-a-url';

export type ParseResult =
  | { ok: true; target: Target }
  | { ok: false; problem: KeyProblem; sendkey: string };

/** 从 SendKey（或直接粘来的推送地址）认出通道，拼出地址。 */
export function parseSendKey(raw: string, choice: ChannelChoice = 'auto'): ParseResult {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { ok: false, problem: 'empty', sendkey: '' };

  const pasted = fromUrl(input);
  if (pasted === null && SCHEME.test(input)) return { ok: false, problem: 'not-a-url', sendkey: input };

  const sendkey = pasted?.sendkey ?? input;
  const uidFromKey = SC3_KEY.exec(sendkey)?.[1] ?? null;
  // 只要以 sctp 开头就归 ³：少了数字是 Key 有问题，得报错，不能当成 Turbo 硬发
  const looksSc3 = /^sctp/i.test(sendkey);
  const channel: Channel = choice === 'auto' ? (looksSc3 ? 'sc3' : 'turbo') : choice;

  if (channel === 'sc3') {
    const uid = uidFromKey ?? pasted?.uid ?? null;
    if (uid === null) return { ok: false, problem: 'no-uid', sendkey };
    const host = `${uid}.${SC3_HOST_SUFFIX}`;
    return {
      ok: true,
      target: { channel, sendkey, uid, host, url: `https://${host}/send/${encodeURIComponent(sendkey)}.send` },
    };
  }

  const host = TURBO_HOST;
  return {
    ok: true,
    target: { channel: 'turbo', sendkey, uid: null, host, url: `https://${host}/${encodeURIComponent(sendkey)}.send` },
  };
}

/** 粘的是推送地址本身时，从路径（和 ³ 的主机名）里把 SendKey 与 uid 拆出来。 */
function fromUrl(input: string): { sendkey: string; uid: string | null } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  if (host === TURBO_HOST) {
    const key = keyFromPath(url.pathname, /^\/([^/]+)\.send$/);
    return key === null ? null : { sendkey: key, uid: null };
  }
  if (host.endsWith(`.${SC3_HOST_SUFFIX}`)) {
    const key = keyFromPath(url.pathname, /^\/send\/([^/]+)\.send$/);
    const uid = host.slice(0, -(SC3_HOST_SUFFIX.length + 1));
    if (key === null || !/^\d+$/.test(uid)) return null;
    return { sendkey: key, uid };
  }
  return null;
}

function keyFromPath(pathname: string, pattern: RegExp): string | null {
  const matched = pattern.exec(pathname);
  if (!matched) return null;
  const decoded = decodeURIComponent(matched[1]!);
  return decoded || null;
}

/** 回执里露出的 Key：留头留尾，中间省略。 */
export function maskKey(key: string): string {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed) return '';
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}…`;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}
