/** 包入口：加载器读默认导出。 */
import { SERVERCHAN } from './definition.ts';

export default SERVERCHAN;
export { SERVERCHAN };
export { CHANNEL_OPTIONS_KIND, SERVERCHAN_DEFAULTS, SERVERCHAN_ID, serverChanConfigGroup, serverChanConfigOptions } from './config.ts';
export type { ServerChanConfigSection } from './config.ts';
export { ServerChanWorld, SERVERCHAN_TOOL_DECLS } from './world.ts';
export type { ServerChanWorldOptions } from './world.ts';
export { SC3_HOST_SUFFIX, TURBO_HOST, maskKey, parseSendKey } from './channel.ts';
export type { Channel, ChannelChoice, KeyProblem, ParseResult, Target } from './channel.ts';
export { buildRequest, DEFAULT_TIMEOUT_MS, MAX_TEXT, MAX_TITLE, pushTo } from './send.ts';
export type { FailureKind, FetchLike, IgnoredOption, PushInput, PushOutcome } from './send.ts';
export { bodyHash, dayKey, emptyState, readState, recordSend, todayCount, writeState, STATE_FILE } from './state.ts';
export type { LastSend, ServerChanState } from './state.ts';
export { ENV_SENDKEY, dotEnvValue, readLanguage } from './env.ts';
export { formatClock } from './format.ts';
export { PROMPT_VARS, serverChanText, textLanguage } from './text.ts';
export type { PromptVar, ServerChanText, TextLanguage } from './text.ts';
