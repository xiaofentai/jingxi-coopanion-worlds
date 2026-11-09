/** 包入口：加载器读默认导出。 */
import { ARE_YOU_THERE } from './definition.ts';

export default ARE_YOU_THERE;
export { ARE_YOU_THERE };
export {
  ARE_YOU_THERE_DEFAULTS, ARE_YOU_THERE_ID, clampedPollSeconds, idleThresholdMs,
  areYouThereConfigGroup, DEFAULT_IDLE_MINUTES, DEFAULT_MEDIA_KEYWORDS, MAX_IDLE_MINUTES,
} from './config.ts';
export type { AreYouThereConfigSection } from './config.ts';
export { AreYouThereWorld, ARE_YOU_THERE_TOOL_DECLS } from './world.ts';
export type { AreYouThereWorldOptions } from './world.ts';
export { parseTasklist, probeLocked, runTasklist, confirmedReading, feedReading, emptyDebounce } from './probe.ts';
export type { Debounce, ProbeResult, TasklistRunner } from './probe.ts';
export { IdleTracker, parseIdleLine, IDLE_SCRIPT, STALE_AFTER_MS } from './idle.ts';
export type { IdleReading, IdleSource } from './idle.ts';
export {
  mediaMatch, parseForegroundLine, parseShotLine, splitKeywords, defaultConfirmProbe,
  SCREEN_CHANGED_PERCENT,
} from './confirm.ts';
export type { ConfirmProbe, ForegroundInfo } from './confirm.ts';
export { applyReading, decidePresence, emptyPresence } from './presence.ts';
export type { AwayReason, AwayRecord, PresenceChange, PresenceReading, PresenceState } from './presence.ts';
export { formatAgo, formatClock, formatDuration } from './format.ts';
export { readState, writeState, STATE_FILE } from './state.ts';
