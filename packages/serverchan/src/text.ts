/**
 * 这个 World 说的所有话：设置页、回执、环境提示，中文与英文两张表。
 *
 * 设置页文案跟随请求的语言；回执与环境提示跟随 `config.json` 里的语言。另一种语言读英文。
 */
import type { Language } from 'cortico/core/language.ts';
import type { Channel, ChannelChoice } from './channel.ts';

export type TextLanguage = 'zh' | 'en';

/** 环境提示模板里要填的占位符。 */
export const PROMPT_VARS = ['sc.state'] as const;
export type PromptVar = typeof PROMPT_VARS[number];

export type BrokenKeyProblem = 'no-uid' | 'not-a-url';

export interface ServerChanText {
  label: string;
  /** 通道名，两家都保留原名。 */
  channel: Record<Channel, string>;
  config: {
    group: string;
    groupDescription: string;
    sendkey: { title: string; description: string };
    channel: { title: string; description: string };
    options: Record<ChannelChoice, string>;
  };
  envPrompt: {
    title: string;
    description: string;
    vars: Record<PromptVar, string>;
  };
  state: {
    ready: (channel: string, today: number) => string;
    unconfigured: string;
    broken: string;
  };
  tool: {
    /** 工具说明，`describe` 与设置页用。 */
    describeSend: string;
    describeStatus: string;
    busy: string;
    unknown: string;
    failed: (name: string, reason: string) => string;
    sent: (title: string, channel: string, today: number) => string;
    ignoredTags: string;
    unconfigured: (envName: string) => string;
    brokenKey: (problem: BrokenKeyProblem) => string;
    emptyTitle: string;
    longTitle: (max: number) => string;
    longText: (max: number) => string;
    duplicate: (seconds: number) => string;
    timeout: (seconds: number) => string;
    network: (detail: string) => string;
    notJson: (head: string) => string;
    http: (status: number) => string;
    rejected: (code: string, message: string) => string;
    statusLines: {
      channel: (channel: string, host: string, masked: string) => string;
      none: string;
      broken: (problem: BrokenKeyProblem) => string;
      fromSettings: string;
      fromEnv: (envName: string) => string;
      today: (today: number, total: number) => string;
      never: string;
      last: (when: string, title: string) => string;
      lastFailed: (when: string, reason: string) => string;
    };
  };
}

const zh: ServerChanText = {
  label: 'Server酱',
  channel: { turbo: 'Server酱 Turbo', sc3: 'Server酱³' },
  config: {
    group: 'Server酱',
    groupDescription: '把话送到 ta 的手机上。填一个 Server酱 SendKey，Turbo 与 Server酱³ 两种通道按 SendKey 的形状自动分辨，推送地址各按各的拼法。',
    sendkey: {
      title: 'SendKey',
      description: 'Server酱 后台拿到的 SendKey：Turbo 的是 SCT 开头，Server酱³ 的是 sctp 开头，粘整条推送地址也认。留空时读部署目录 .env 里的 SERVERCHAN_SENDKEY。',
    },
    channel: {
      title: '通道',
      description: '自动判断：sctp 开头走 Server酱³（地址里要带 Key 中间那串数字），其余走 Turbo。只有自动判断错了才手动指定。',
    },
    options: { auto: '自动判断', turbo: 'Server酱 Turbo', sc3: 'Server酱³' },
  },
  envPrompt: {
    title: 'Server酱',
    description: '告诉 bot 现在能不能把话发到 ta 的手机上、走哪条通道，以及该怎么用。',
    vars: { 'sc.state': '能不能推送、走哪条通道、今天已经发了几条。' },
  },
  state: {
    ready: (channel, today) => `Server酱：可用，走 ${channel}，今天已发 ${today} 条。`,
    unconfigured: 'Server酱：还没配 SendKey，发不出去。',
    broken: 'Server酱：SendKey 认不出通道，先在设置页改一下。',
  },
  tool: {
    describeSend: '把一句话推到 ta 的手机上（Server酱）。标题 32 字以内，正文是 Markdown。Turbo 的 Key 不收标签，Server酱³ 的 Key 收。60 秒内一模一样的标题和正文会被拒，别盲目重试。',
    describeStatus: '报当前用的是哪条通道（Key 打码）、能不能发、今天成功发了几条、上一次的结果。只读，不会发东西。',
    busy: '上一条还在发，等它回来再说。',
    unknown: '这个工具不存在。',
    failed: (name, reason) => `${name} 失败：${reason}`,
    sent: (title, channel, today) => `已经发到 ta 的手机：《${title}》，走 ${channel}，今天第 ${today} 条。`,
    ignoredTags: 'Turbo 通道不收标签，这次没带上。',
    unconfigured: (envName) => `没配 SendKey，发不出去。到设置页填「SendKey」，或在部署目录的 .env 里写 ${envName}=…。`,
    brokenKey: (problem) => (problem === 'no-uid'
      ? 'SendKey 以 sctp 开头，却没带地址需要的数字（形如 sctp1234t…），认不出 Server酱³ 的推送地址。'
      : '粘进来的像是个网址，但不是 Server酱 的推送地址；直接填 SendKey 就好。'),
    emptyTitle: '标题不能为空。',
    longTitle: (max) => `标题超过 ${max} 个字了，缩短一点再发。`,
    longText: (max) => `正文超过 ${max} 个字了，缩短一点再发。`,
    duplicate: (seconds) => `${seconds} 秒内已经发过一样的标题和正文，这次没有重复发。`,
    timeout: (seconds) => `等了 ${seconds} 秒没有回应，这条没发出去。`,
    network: (detail) => `连不上 Server酱：${detail}`,
    notJson: (head) => `返回的不是 JSON（${head}），这一次算失败。`,
    http: (status) => `服务端返回 HTTP ${status}。`,
    rejected: (code, message) => `Server酱 拒收了（code ${code}）：${message || '没写原因'}`,
    statusLines: {
      channel: (channel, host, masked) => `通道：${channel}（${host}，Key ${masked}）`,
      none: '通道：还没配 SendKey。',
      broken: (problem) => `通道：认不出来（${problem === 'no-uid' ? 'sctp 开头的 Key 里没有数字' : '粘进来的地址认不出'}）。`,
      fromSettings: 'Key 来源：设置页。',
      fromEnv: (envName) => `Key 来源：部署目录 .env 的 ${envName}。`,
      today: (today, total) => `今天：${today} 条；累计 ${total} 条。`,
      never: '上次：还没发过。',
      last: (when, title) => `上次：${when}，成功，《${title}》。`,
      lastFailed: (when, reason) => `上次：${when}，失败：${reason}`,
    },
  },
};

const en: ServerChanText = {
  label: 'Server Chan',
  channel: { turbo: 'Server酱 Turbo', sc3: 'Server酱³' },
  config: {
    group: 'Server Chan',
    groupDescription: 'Sends a line to their phone. Paste one Server酱 SendKey; Turbo and Server酱³ are told apart by the key itself, and each channel gets its own URL shape.',
    sendkey: {
      title: 'SendKey',
      description: 'The SendKey from the Server酱 dashboard: Turbo keys start with SCT, Server酱³ keys start with sctp. The whole push URL is accepted too. When left empty, SERVERCHAN_SENDKEY in the deployment\'s .env is read.',
    },
    channel: {
      title: 'Channel',
      description: 'Chosen from the key: sctp goes to Server酱³ (its URL carries the number inside the key), anything else to Turbo. Set it by hand only when the guess is wrong.',
    },
    options: { auto: 'Chosen from the key', turbo: 'Server酱 Turbo', sc3: 'Server酱³' },
  },
  envPrompt: {
    title: 'Server Chan',
    description: 'Tells the bot whether a push can go out, through which channel, and how many went out today.',
    vars: { 'sc.state': 'Whether pushing works, which channel it uses, and how many went out today.' },
  },
  state: {
    ready: (channel, today) => `Server Chan: ready through ${channel}; ${today} sent today.`,
    unconfigured: 'Server Chan: no SendKey yet, nothing can be sent.',
    broken: 'Server Chan: the SendKey names no channel; fix it in the settings first.',
  },
  tool: {
    describeSend: 'Pushes one line to their phone through Server酱. Title within 32 characters, body in Markdown. Turbo keys take no tags, Server酱³ keys do. The same title and body is refused within 60 seconds, so do not retry blindly.',
    describeStatus: 'Reports which channel the key belongs to (masked), whether sending works, how many went out today and how the last attempt went. Read only; sends nothing.',
    busy: 'The previous push is still on its way; wait for it.',
    unknown: 'No such tool.',
    failed: (name, reason) => `${name} failed: ${reason}`,
    sent: (title, channel, today) => `Sent to their phone: "${title}" through ${channel}; ${today} today.`,
    ignoredTags: 'Turbo keys take no tags, so they were left out.',
    unconfigured: (envName) => `No SendKey is set, so nothing was sent. Fill in "SendKey" in the settings, or put ${envName}=… in the deployment\'s .env.`,
    brokenKey: (problem) => (problem === 'no-uid'
      ? 'The key starts with sctp but carries no number (like sctp1234t…), so the Server酱³ address cannot be built.'
      : 'That looks like a URL but not a Server酱 push address; paste the SendKey itself.'),
    emptyTitle: 'The title cannot be empty.',
    longTitle: (max) => `The title is longer than ${max} characters; shorten it and send again.`,
    longText: (max) => `The body is longer than ${max} characters; shorten it and send again.`,
    duplicate: (seconds) => `The same title and body went out less than ${seconds} seconds ago; this one was not sent again.`,
    timeout: (seconds) => `No answer after ${seconds} seconds; this push did not go out.`,
    network: (detail) => `Could not reach Server酱: ${detail}`,
    notJson: (head) => `The reply was not JSON (${head}); this attempt counts as failed.`,
    http: (status) => `The server answered HTTP ${status}.`,
    rejected: (code, message) => `Server酱 refused it (code ${code}): ${message || 'no reason given'}`,
    statusLines: {
      channel: (channel, host, masked) => `Channel: ${channel} (${host}, key ${masked})`,
      none: 'Channel: no SendKey yet.',
      broken: (problem) => `Channel: unrecognised (${problem === 'no-uid' ? 'the sctp key carries no number' : 'the pasted address is unknown'}).`,
      fromSettings: 'Key from: the settings page.',
      fromEnv: (envName) => `Key from: ${envName} in the deployment's .env.`,
      today: (today, total) => `Today: ${today}; all time: ${total}.`,
      never: 'Last: nothing sent yet.',
      last: (when, title) => `Last: ${when}, sent "${title}".`,
      lastFailed: (when, reason) => `Last: ${when}, failed: ${reason}`,
    },
  },
};

const TABLES: Record<TextLanguage, ServerChanText> = { zh, en };

export function textLanguage(language: Language): TextLanguage {
  return language === 'zh' ? 'zh' : 'en';
}

export function serverChanText(language: Language = 'zh'): ServerChanText {
  return TABLES[textLanguage(language)];
}
