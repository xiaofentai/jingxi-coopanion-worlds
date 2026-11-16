/** 配置段 `worlds.cache-keepalive`：空档多久补一拍、多久看一次表、正文写什么、夜里补不补。 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import {
  DEFAULT_AFTER_MINUTES, DEFAULT_TEMPLATE_EN, DEFAULT_TEMPLATE_ZH, DEFAULT_TICK_SECONDS,
  MAX_AFTER_MINUTES, MAX_MAX_PER_DAY, MAX_TICK_SECONDS, MIN_AFTER_MINUTES, MIN_TICK_SECONDS,
  CACHE_TTL_MINUTES,
} from './beat.ts';

export const CACHE_KEEPALIVE_ID = 'cache-keepalive';

export interface CacheKeepaliveConfigSection extends WorldSection {
  /** 距上一次模型调用超过这么多分钟才补一拍。 */
  afterMinutes: number;
  /** 多久看一次表，秒。改完下一拍生效，不用重启。 */
  tickSeconds: number;
  /** 心跳正文的模板，`{time}` 换成当前时刻；留空用默认那句。 */
  text: string;
  /** 夜间不补拍的窗口，`2-7` 这种写法；空串表示全天都补。 */
  quietHours: string;
  /** 一天最多补几拍；0 表示不限。 */
  maxPerDay: number;
}

export const CACHE_KEEPALIVE_DEFAULTS: CacheKeepaliveConfigSection = {
  enabled: false,
  afterMinutes: DEFAULT_AFTER_MINUTES,
  tickSeconds: DEFAULT_TICK_SECONDS,
  // 空串＝用默认模板；默认那句按 config.json 的语言挑中英文
  text: '',
  // 默认全天：省下来的钱几乎全在「夜里四小时没人叫她」那一段时间里
  quietHours: '',
  maxPerDay: 48,
};

interface GroupText {
  group: string;
  groupDescription: string;
  afterMinutes: { title: string; description: string; suffix: string };
  tickSeconds: { title: string; description: string; suffix: string };
  text: { title: string; description: string };
  quietHours: { title: string; description: string };
  maxPerDay: { title: string; description: string; suffix: string };
}

const ZH: GroupText = {
  group: '缓存保温',
  groupDescription:
    '上下文静下来之后，上游的前缀缓存会在一个多小时里过期；再被叫醒时，那一轮要按整份前缀重新计价。'
    + '这个开关让插件在空档变长之前补一条内部事件，把缓存续上。它不说话、不调用工具、不写盘。',
  afterMinutes: {
    title: '空档阈值',
    description: `距上一次模型调用超过这么多分钟才补一拍。实测缓存约 ${CACHE_TTL_MINUTES} 分钟过期`
      + '（73 分钟还命中、78 分钟就整份重来），填到这个数以上功能就等于关着——插件还在跑，但每次都比缓存慢一步。',
    suffix: '分钟',
  },
  tickSeconds: {
    title: '看表间隔',
    description: '多久查一次「上次调用是几点」，秒。查一次只读一个文件的时间戳，代价可以忽略；'
      + '改完下一拍生效，不用重启。它决定了补拍的精度——间隔比它短就一定会晚一点才补。',
    suffix: '秒',
  },
  text: {
    title: '心跳正文',
    description: '`{time}` 会换成当前时刻，例如 `（静默心跳：现在是 {time}）`。留空用默认那句。\n'
      + '⚠️ 默认这句很短，但它没告诉模型「这不是对方说的」。模型有可能把它当成一句搭话回过来'
      + '（桌宠里就冒泡了），也可能读成「到点了，该做点什么」，转手去查生态箱、写记忆——那一拍就变成五轮。'
      + '想稳一点写成 `（静默心跳：现在是 {time}。不是他说的，不用回、不要调用工具。）`：'
      + '多二十来个字，比一次误触便宜得多。',
  },
  quietHours: {
    title: '夜里不补的时段',
    description: '像 `2-7` 这样写，表示 02:00 到 07:00 之间不补拍，可以跨零点（`23-7`）。'
      + '留空＝全天都补：空档最长的就是夜间，留空才省得最多；代价是半夜也会醒一次。',
  },
  maxPerDay: {
    title: '每日上限',
    description: '一天最多补几拍，0 表示不限。按 40 分钟算一天最多 36 拍，这里是安全阀，防配置写错把模型一直叫醒。',
    suffix: '拍',
  },
};

const EN: GroupText = {
  group: 'Cache keepalive',
  groupDescription:
    'Once the context goes quiet, the upstream prefix cache expires within about an hour; the next wake-up then pays '
    + 'for the whole prefix again. This plugin pushes one internal event before the gap gets that long, so the cache '
    + 'stays warm. It never speaks, calls no tools and writes nothing.',
  afterMinutes: {
    title: 'Idle threshold',
    description: `Beat only when the last model call is older than this. The cache lives about ${CACHE_TTL_MINUTES} `
      + 'minutes (73 min still hits, 78 min misses entirely); setting this above that number leaves the plugin running '
      + 'but always one step behind the expiry.',
    suffix: 'min',
  },
  tickSeconds: {
    title: 'Watch interval',
    description: 'How often to read the timestamp of the last call, in seconds. One stat per tick; changes apply on '
      + 'the next tick without a restart. It bounds how precisely a beat can land.',
    suffix: 's',
  },
  text: {
    title: 'Heartbeat text',
    description: '`{time}` becomes the current clock, e.g. `(Silent heartbeat: it is now {time})`. Empty means the '
      + 'default sentence.\n'
      + '⚠️ The default is very short and does not tell the model this is not from them. It may reply to it (a bubble '
      + 'appears in the pet), or read it as "it is a round hour, do something" and go call tools — turning one beat '
      + 'into five rounds. A safer form: `(Silent heartbeat: it is now {time}. Not from them: no reply, no tool calls.)`',
  },
  quietHours: {
    title: 'No beating between',
    description: 'Write it like `2-7` to hold back between 02:00 and 07:00; it may wrap past midnight (`23-7`). '
      + 'Empty means all day: the longest gaps are at night, so staying empty saves the most.',
  },
  maxPerDay: {
    title: 'Daily cap',
    description: 'How many beats per day at most; 0 means unlimited. At 40 minutes a day holds 36, so this is a safety '
      + 'valve against a typo that keeps waking the model.',
    suffix: 'beats',
  },
};

const pick = (language: Language): GroupText => (language === 'zh' || language === 'zh-Hant' ? ZH : EN);

/** 默认正文；配置里 `text` 留空时用它，并按部署语言挑中英。 */
export function defaultTemplate(language: Language): string {
  return language === 'zh' || language === 'zh-Hant' ? DEFAULT_TEMPLATE_ZH : DEFAULT_TEMPLATE_EN;
}

/** 设置页。每个键都在用的时候现读，所以改完不用重启。 */
export function cacheKeepaliveConfigGroup(language: Language = 'zh'): ConfigGroup {
  const t = pick(language);
  const K = `worlds.${CACHE_KEEPALIVE_ID}`;
  return {
    id: `world:${CACHE_KEEPALIVE_ID}`,
    owner: `world:${CACHE_KEEPALIVE_ID}`,
    schema: {
      type: 'object',
      title: t.group,
      description: t.groupDescription,
      properties: {
        [`${K}.afterMinutes`]: {
          type: 'integer',
          title: t.afterMinutes.title,
          description: t.afterMinutes.description,
          minimum: MIN_AFTER_MINUTES,
          maximum: MAX_AFTER_MINUTES,
          'x-suffix': t.afterMinutes.suffix,
          'x-hot': true,
        },
        [`${K}.tickSeconds`]: {
          type: 'integer',
          title: t.tickSeconds.title,
          description: t.tickSeconds.description,
          minimum: MIN_TICK_SECONDS,
          maximum: MAX_TICK_SECONDS,
          'x-suffix': t.tickSeconds.suffix,
          'x-hot': true,
        },
        [`${K}.text`]: {
          type: 'string',
          title: t.text.title,
          description: t.text.description,
          'x-hot': true,
        },
        [`${K}.quietHours`]: {
          type: 'string',
          title: t.quietHours.title,
          description: t.quietHours.description,
          'x-hot': true,
        },
        [`${K}.maxPerDay`]: {
          type: 'integer',
          title: t.maxPerDay.title,
          description: t.maxPerDay.description,
          minimum: 0,
          maximum: MAX_MAX_PER_DAY,
          'x-suffix': t.maxPerDay.suffix,
          'x-hot': true,
        },
      },
    },
  };
}
