import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { MEMORY_BACKUP_DEFAULTS, MEMORY_BACKUP_ID, memoryBackupConfigOptions, type MemoryBackupConfigSection } from './config.ts';
import { appDataRoot } from './paths.ts';
import { MEMORY_BACKUP_TOOL_DECLS, MemoryBackupWorld } from './world.ts';

export const MEMORY_BACKUP: WorldDefinition<MemoryBackupConfigSection> = {
  id: MEMORY_BACKUP_ID,
  label: 'Memory backup',
  defaults: () => ({ ...MEMORY_BACKUP_DEFAULTS }),
  configOptions: (kind, language) => memoryBackupConfigOptions(kind, language),
  // every setting is read when used: `ctx.cfg` is the live `worlds.memory-backup` section
  create: (ctx) => new MemoryBackupWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
    dataRoot: appDataRoot(ctx.botDir),
  }),
  describe: {
    tools: describeTools(MEMORY_BACKUP_TOOL_DECLS, {
      mb_status: { zh: '查看提醒排期、上次整理、上次备份与已有的备份。', en: 'Reports the reminder schedule, the last tidy, the last snapshot and the snapshots on disk.' },
      mb_run: { zh: '立刻把配置的目录复制成一份带时间的备份。', en: 'Copies the configured directory into a dated snapshot now.' },
      mb_tidy_done: { zh: '记下整理完成,并在同一次调用里备份。', en: 'Records that the Memory was tidied, and snapshots in the same call.' },
      mb_restore: { zh: '把记忆与插件回滚到某一份备份;不带确认时只报告会改动什么。', en: 'Writes a snapshot back over the Memory and the extensions; without confirm it only reports what would change.' },
      mb_restart: { zh: '重启 Core,让回滚与扩展装卸生效;桌宠会断开几秒。', en: 'Restarts Core so restored files and extension changes take effect; the pet disconnects for a few seconds.' },
    }),
    events: [
      {
        type: 'memory-backup.due',
        description: { zh: '到了整理记忆并备份的时间。', en: 'The time to tidy the Memory and back it up came.' },
        trigger: 'flush',
      },
    ],
  },
};
