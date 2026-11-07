/** Package entry: the loader reads the default export when `cortico.kind` is `world`. */
import { MEMORY_BACKUP } from './definition.ts';

export default MEMORY_BACKUP;
export { MEMORY_BACKUP };
export { MEMORY_BACKUP_ID, MEMORY_BACKUP_DEFAULTS, memoryBackupConfigGroup, memoryBackupConfigOptions } from './config.ts';
export type { BackupScope, MemoryBackupConfigSection, ReminderSchedule } from './config.ts';
export { MemoryBackupWorld, MEMORY_BACKUP_TOOL_DECLS } from './world.ts';
export { MANIFEST_FILE, clearSnapshots, listSnapshots, takeSnapshot } from './backup.ts';
export type { SnapshotManifest, SnapshotOptions, SnapshotResult } from './backup.ts';
