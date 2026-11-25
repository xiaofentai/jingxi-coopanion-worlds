/** 包入口：加载器读默认导出。 */
import { IDLE_NUDGE } from './definition.ts';

export default IDLE_NUDGE;
export { IDLE_NUDGE };
export {
  IDLE_NUDGE_DEFAULTS, IDLE_NUDGE_ID, idleNudgeConfigGroup,
  type IdleNudgeConfigSection,
} from './config.ts';
export { IdleNudgeWorld } from './world.ts';
export type { IdleNudgeWorldOptions, NudgeStatus } from './world.ts';
export {
  DEFAULT_HEARTBEAT_TEXT, DEFAULT_NOTE_TEXT, DEFAULT_SLOTS, DEFAULT_SETTINGS,
  SETTINGS_KEY, clampSettings, parseSlotPair, slotRangeText,
  readSettings, seedSettings, writeSettings,
  type NoteSlot, type NudgeSettings,
} from './settings.ts';
export {
  DEFAULT_IDLE_MINUTES, DEFAULT_MAX_PER_DAY, DEFAULT_TEMPLATE_EN, DEFAULT_TEMPLATE_ZH,
  DEFAULT_TICK_SECONDS, LONGCAT_TTL_MINUTES, MAX_IDLE_MINUTES, MAX_MAX_PER_DAY,
  MAX_TICK_SECONDS, MIN_IDLE_MINUTES, MIN_TICK_SECONDS,
  clampIdleMinutes, clampMaxPerDay, clampTickSeconds, decideBeat, formatClock,
  localDay, localHour, localMinuteOfDay, minutesOf, renderHeartbeat,
  type BeatDecision, type BeatFacts, type BeatPolicy,
} from './beat.ts';
export {
  decideNote, inWindow, jitterMinute, jitterOffset, parseClock, renderNote, slotEnabled,
  windowSpan, type NoteDecision, type NoteFacts, type NotePolicy,
} from './note.ts';
