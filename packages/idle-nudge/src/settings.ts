/**
 * 参数存在 `config.json` 的 `worlds.idle-nudge.settings` 段里，和 enabled 开关同住一份文件。
 * 不另开小文件——「改了显示保存、重启又回退」那类问题从根上消掉（见《设置页交接》§七）。
 *
 * 两段功能共用这一份：静默心跳（全天）+ 小纸条（三个可配时段）。
 * 所有参数每拍现读，设置页改完下一拍生效，不用重启。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDLE_NUDGE_ID } from './config.ts';

export const SETTINGS_KEY = 'settings';

/** 一段纸条窗口。`from` / `to` 是 "9"、"14:30" 这种本地时刻；两者任一为空 = 这段不启用。 */
export interface NoteSlot {
  from: string;
  to: string;
  /** 这一段每天最多推几次。0 = 这段不推（等价于置空，但保留配置）。 */
  perDay: number;
}

/** 一条问候：时刻 "7:30" 这种；空 = 不启用。jitter 是双向抖动幅度（分钟）。 */
export interface GreetingSlot {
  time: string;
  jitter: number;
}

export interface NudgeSettings {
  // ---- 三个功能各自的总开关（在各自卡片首行）----
  heartbeatEnabled: boolean;
  noteEnabled: boolean;
  greetingEnabled: boolean;

  // ---- 静默心跳（全天）----
  /** 距上次模型调用超过这么多分钟才补一拍。LongCat-2.5 的值，换模型先量。 */
  idleMinutes: number;
  /** 多久看一次表，秒。每拍现读。 */
  tickSeconds: number;
  /** 心跳一天最多几拍；0 = 不限。 */
  maxPerDay: number;
  /** 心跳正文模板，{time} 换成当前时刻；留空用默认。 */
  heartbeatText: string;

  // ---- 小纸条（三个时段）----
  /** 三段窗口，顺序固定。任一段 from / to 置空即不启用。 */
  slots: NoteSlot[];
  /** 两张纸条之间至少隔多少分钟，防止三段挨着推。 */
  noteGapMinutes: number;
  /** 纸条正文模板，{time} 换成当前时刻；留空用默认。 */
  noteText: string;

  // ---- 早晚安（两个时刻，各自双向抖动）----
  /** 两条问候：第一条早安、第二条晚安；时刻留空即不启用。 */
  greetings: GreetingSlot[];
  // 问候正文不给用户填：固定一句由头，让模型自己想措辞（见 greeting.ts 的 GREETING_HINT）
}

export const DEFAULT_HEARTBEAT_TEXT = '静默心跳{time}，无需回复。';

export const DEFAULT_NOTE_TEXT =
  '（系统递的空闲提醒，不是 ta 说的，不用回这条。）现在{time}啦——花花草草小动物、玩玩游戏、找人或者别的鱼聊两句，想干哪样就直接调工具去做；要跟 ta 开口走平时那条通道（微信 / 气泡）；都不想就安静。';



export const DEFAULT_GREETINGS: readonly GreetingSlot[] = [
  { time: '', jitter: 20 },
  { time: '', jitter: 20 },
];

export const DEFAULT_SLOTS: readonly NoteSlot[] = [
  { from: '9', to: '12', perDay: 1 },
  { from: '14', to: '18', perDay: 1 },
  { from: '19', to: '22', perDay: 1 },
];

export const DEFAULT_SETTINGS: NudgeSettings = {
  // 静默心跳默认关：它是否省钱取决于上游的缓存计价，不清楚就别开（见设置页说明）。
  heartbeatEnabled: false,
  noteEnabled: true,
  greetingEnabled: false,
  idleMinutes: 40,
  tickSeconds: 15,
  maxPerDay: 48,
  heartbeatText: '',
  slots: DEFAULT_SLOTS.map((slot) => ({ ...slot })),
  noteGapMinutes: 120,
  noteText: '',
  greetings: DEFAULT_GREETINGS.map((g) => ({ ...g })),
};

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, raw));
};

/** 正文模板允许清空——空串表示"用默认那句"，是用户明确的选择，不能当没提交回退到旧值。 */
const clampTemplate = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  return value.slice(0, 500);
};

/** 一段窗口里的时刻：允许 "9" / "09:30" / "23:59"，空串原样留（表示这段不启用）。 */
const clampClock = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const raw = value.trim();
  if (!raw) return '';
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return fallback;
  if (!Number.isInteger(min) || min < 0 || min > 59) return fallback;
  return m[2] === undefined ? String(h) : `${h}:${String(min).padStart(2, '0')}`;
};

const clampBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/**
 * 设置页一段占一行、两个并排的框：左边填时段 `9-12`，右边填张数。
 * 服务端收到 `{ range, perDay }`：range 拆成 from/to，留空＝不启用本段。
 */
export function slotRangeText(slot: NoteSlot): string {
  if (!slot.from && !slot.to) return '';
  // 半填的段（`9-`）原样显示成 `9-`：显示空会让人以为自己没填过，其实值还在
  return `${slot.from}-${slot.to}`;
}

/** 解析 `{range, perDay}`；写坏时退回这一段原来的值，不静默改成别的时段。 */
export function parseSlotPair(raw: unknown, fallback: NoteSlot): NoteSlot {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const obj = raw as { range?: unknown; perDay?: unknown };
  const range = typeof obj.range === 'string' ? obj.range.trim() : '';
  if (!range) return { from: '', to: '', perDay: 0 };
  const bounds = range.split(/\s*[-–~—]\s*/);
  if (bounds.length !== 2) return { ...fallback };
  return {
    from: clampClock(bounds[0], fallback.from),
    to: clampClock(bounds[1], fallback.to),
    perDay: clampInt(obj.perDay, fallback.perDay, 0, 24),
  };
}

/** 面板提交什么都按这个过一遍；三段窗口顺序固定，数量不足的用默认补齐。 */
export function clampSettings(value: Partial<NudgeSettings> | null | undefined, fallback: NudgeSettings): NudgeSettings {
  const incoming = Array.isArray(value?.slots) ? value!.slots : [];
  const incomingG = Array.isArray(value?.greetings) ? value!.greetings : [];
  return {
    heartbeatEnabled: clampBool(value?.heartbeatEnabled, fallback.heartbeatEnabled),
    noteEnabled: clampBool(value?.noteEnabled, fallback.noteEnabled),
    greetingEnabled: clampBool(value?.greetingEnabled, fallback.greetingEnabled),
    idleMinutes: clampInt(value?.idleMinutes, fallback.idleMinutes, 1, 1440),
    tickSeconds: clampInt(value?.tickSeconds, fallback.tickSeconds, 5, 300),
    maxPerDay: clampInt(value?.maxPerDay, fallback.maxPerDay, 0, 240),
    heartbeatText: clampTemplate(value?.heartbeatText, fallback.heartbeatText),
    slots: fallback.slots.map((base, index) => {
      const raw = (incoming[index] ?? {}) as Partial<NoteSlot>;
      return {
        from: clampClock(raw.from, base.from),
        to: clampClock(raw.to, base.to),
        perDay: clampInt(raw.perDay, base.perDay, 0, 24),
      };
    }),
    noteGapMinutes: clampInt(value?.noteGapMinutes, fallback.noteGapMinutes, 0, 1440),
    noteText: clampTemplate(value?.noteText, fallback.noteText),
    greetings: fallback.greetings.map((base, index) => {
      const raw = (incomingG[index] ?? {}) as Partial<GreetingSlot>;
      return {
        time: clampClock(raw.time, base.time),
        jitter: clampInt(raw.jitter, base.jitter, 0, 240),
      };
    }),
  };
}

/** 新装没有 settings 段时，用默认值起。 */
export function seedSettings(): NudgeSettings {
  return clampSettings(null, {
    ...DEFAULT_SETTINGS,
    slots: DEFAULT_SLOTS.map((slot) => ({ ...slot })),
    greetings: DEFAULT_GREETINGS.map((g) => ({ ...g })),
  });
}

export function readSettings(botDir: string): NudgeSettings {
  const seed = seedSettings();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(botDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return seed;
  }
  const worlds = raw?.worlds as Record<string, unknown> | undefined;
  const section = worlds?.[IDLE_NUDGE_ID] as Record<string, unknown> | undefined;
  const stored = section?.[SETTINGS_KEY];
  if (!stored || typeof stored !== 'object') return seed;
  try {
    return clampSettings(stored as Partial<NudgeSettings>, seed);
  } catch {
    return seed;
  }
}

/**
 * 整份读 config.json，只改 `worlds.idle-nudge.settings`，其余键一个不动。
 * 临时文件再改名：中途崩了不会留下半份配置。
 *
 * **解析不了就不写**——和宿主的 `readJsonObject` 一字不差（它抛
 * 「config.json解析失败,拒绝写回(请手工检查文件)」）。理由是本机实测：这份文件里躺着
 * 20 来个别的 world 段（星邮 token、Server 酱 SendKey、shell 的执行配置…），
 * 拿空对象重建会把它们全抹掉，比「这次没存上」严重得多。
 * 文件不存在＝新装，照常建。
 */
export function writeSettings(botDir: string, settings: NudgeSettings): void {
  const file = join(botDir, 'config.json');
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error('没有保存：config.json 解析失败，先手工修好它（插件不会拿空对象重建）');
    }
    // 顶层不是对象也拒绝：数组会被 JSON.stringify 写成 `[]`、字符串会被静默丢掉别的键
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('没有保存：config.json 的顶层不是对象，先手工修好它（插件不会拿空对象重建）');
    }
    raw = parsed as Record<string, unknown>;
  }
  const worlds = (raw.worlds && typeof raw.worlds === 'object' ? raw.worlds : {}) as Record<string, unknown>;
  const section = (worlds[IDLE_NUDGE_ID] && typeof worlds[IDLE_NUDGE_ID] === 'object'
    ? worlds[IDLE_NUDGE_ID] : {}) as Record<string, unknown>;
  worlds[IDLE_NUDGE_ID] = { ...section, [SETTINGS_KEY]: settings };
  raw.worlds = worlds;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
