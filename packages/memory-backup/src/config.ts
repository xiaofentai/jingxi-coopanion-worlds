/** Config section `worlds.memory-backup`: when the reminder comes and what a snapshot copies. */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import { memoryBackupText } from './text.ts';

export const MEMORY_BACKUP_ID = 'memory-backup';

/** `off` keeps the tools: a snapshot then comes only from a tool call. */
export type ReminderSchedule = 'daily' | 'interval' | 'off';
/** `data` is the directory holding the deployment (keys, models, runtimes); `deployment` is the deployment alone. */
export type BackupScope = 'data' | 'deployment' | 'custom';

export interface MemoryBackupConfigSection extends WorldSection {
  schedule: ReminderSchedule;
  /** Local clock time of the daily reminder, `HH:MM`. */
  dailyAt: string;
  intervalMinutes: number;
  scope: BackupScope;
  customRootDir: string;
  /** Empty puts `memory-backups` beside the copied directory. */
  backupDir: string;
  maxBackups: number;
  skipModels: boolean;
  /** The Memory directory, relative to the deployment. */
  memoryDir: string;
}

export const MEMORY_BACKUP_DEFAULTS: MemoryBackupConfigSection = {
  enabled: false,
  schedule: 'daily',
  dailyAt: '21:00',
  intervalMinutes: 1440,
  scope: 'data',
  customRootDir: '',
  backupDir: '',
  maxBackups: 5,
  skipModels: true,
  memoryDir: 'workspace',
};

/** The kinds `configOptions` answers for. */
export const SCHEDULE_OPTIONS_KIND = 'memory-backup.schedule';
export const SCOPE_OPTIONS_KIND = 'memory-backup.scope';

export function memoryBackupConfigOptions(kind: string, language: Language = 'zh'): Array<{ value: string; label: string }> {
  const o = memoryBackupText(language).config.options;
  if (kind === SCHEDULE_OPTIONS_KIND) {
    return [
      { value: 'daily', label: o.daily },
      { value: 'interval', label: o.interval },
      { value: 'off', label: o.off },
    ];
  }
  if (kind === SCOPE_OPTIONS_KIND) {
    return [
      { value: 'data', label: o.data },
      { value: 'deployment', label: o.deployment },
      { value: 'custom', label: o.custom },
    ];
  }
  return [];
}

/** The settings page of this World; every key is read when used, so a change needs no restart. */
export function memoryBackupConfigGroup(language: Language = 'zh'): ConfigGroup {
  const c = memoryBackupText(language).config;
  const K = `worlds.${MEMORY_BACKUP_ID}`;
  return {
    id: `world:${MEMORY_BACKUP_ID}`,
    owner: `world:${MEMORY_BACKUP_ID}`,
    schema: {
      type: 'object',
      title: c.group,
      description: c.groupDescription,
      properties: {
        [`${K}.schedule`]: {
          type: 'string',
          title: c.schedule.title,
          description: c.schedule.description,
          enum: ['daily', 'interval', 'off'],
          'x-options': SCHEDULE_OPTIONS_KIND,
          'x-hot': true,
        },
        [`${K}.dailyAt`]: {
          type: 'string',
          title: c.dailyAt.title,
          description: c.dailyAt.description,
          'x-hot': true,
        },
        [`${K}.intervalMinutes`]: {
          type: 'integer',
          title: c.intervalMinutes.title,
          description: c.intervalMinutes.description,
          minimum: 30,
          maximum: 43_200,
          'x-suffix': c.intervalMinutes.suffix,
          'x-hot': true,
        },
        [`${K}.scope`]: {
          type: 'string',
          title: c.scope.title,
          description: c.scope.description,
          enum: ['data', 'deployment', 'custom'],
          'x-options': SCOPE_OPTIONS_KIND,
          'x-hot': true,
        },
        [`${K}.customRootDir`]: {
          type: 'string',
          title: c.customRootDir.title,
          description: c.customRootDir.description,
          'x-path': { kind: 'directory' },
          'x-hot': true,
        },
        [`${K}.backupDir`]: {
          type: 'string',
          title: c.backupDir.title,
          description: c.backupDir.description,
          'x-path': { kind: 'directory' },
          'x-hot': true,
        },
        [`${K}.maxBackups`]: {
          type: 'integer',
          title: c.maxBackups.title,
          description: c.maxBackups.description,
          minimum: 1,
          maximum: 100,
          'x-hot': true,
        },
        [`${K}.skipModels`]: {
          type: 'boolean',
          title: c.skipModels.title,
          description: c.skipModels.description,
          'x-hot': true,
        },
        [`${K}.memoryDir`]: {
          type: 'string',
          title: c.memoryDir.title,
          description: c.memoryDir.description,
          'x-hot': true,
        },
      },
    },
  };
}
