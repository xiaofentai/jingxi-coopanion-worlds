/** 配置段 `worlds.serverchan`：SendKey 与通道选择。 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import type { ChannelChoice } from './channel.ts';
import { serverChanText } from './text.ts';

export const SERVERCHAN_ID = 'serverchan';

/** `configOptions` 回答的那一类选项。 */
export const CHANNEL_OPTIONS_KIND = 'serverchan.channel';

export interface ServerChanConfigSection extends WorldSection {
  /** Server酱 的 SendKey；留空时读部署目录 `.env` 的 `SERVERCHAN_SENDKEY`。 */
  sendkey: string;
  /** `auto` 看 Key 的形状，只有自动判断错了才手工指定。 */
  channel: ChannelChoice;
}

export const SERVERCHAN_DEFAULTS: ServerChanConfigSection = {
  enabled: false,
  sendkey: '',
  channel: 'auto',
};

export function serverChanConfigOptions(kind: string, language: Language = 'zh'): Array<{ value: string; label: string }> {
  if (kind !== CHANNEL_OPTIONS_KIND) return [];
  const o = serverChanText(language).config.options;
  return [
    { value: 'auto', label: o.auto },
    { value: 'turbo', label: o.turbo },
    { value: 'sc3', label: o.sc3 },
  ];
}

/** 设置页；每个键都在用的时候读，所以改完不用重启。 */
export function serverChanConfigGroup(language: Language = 'zh'): ConfigGroup {
  const c = serverChanText(language).config;
  const K = `worlds.${SERVERCHAN_ID}`;
  return {
    id: `world:${SERVERCHAN_ID}`,
    owner: `world:${SERVERCHAN_ID}`,
    schema: {
      type: 'object',
      title: c.group,
      description: c.groupDescription,
      properties: {
        [`${K}.sendkey`]: {
          type: 'string',
          title: c.sendkey.title,
          description: c.sendkey.description,
          'x-hot': true,
        },
        [`${K}.channel`]: {
          type: 'string',
          title: c.channel.title,
          description: c.channel.description,
          enum: ['auto', 'turbo', 'sc3'],
          'x-options': CHANNEL_OPTIONS_KIND,
          'x-hot': true,
        },
      },
    },
  };
}
