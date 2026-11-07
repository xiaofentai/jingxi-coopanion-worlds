/**
 * Where the app keeps its data, as far as a World can see it.
 *
 * Coopanion hands its Core `CORTICO_HOME` (`<data>/home`) and `CORTICO_EXTENSIONS_DIR`
 * (`<data>/extensions`), and a deployment sits at `<data>/home/companion`. The directory holding
 * everything the app writes is therefore the parent of the extensions directory, while `home/`
 * sits beside it. A bare Cortico checkout sets the same variable to its own `extensions/`, which has
 * no `home/` beside it; there the deployment's parent is the best answer.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** The entries of the app data directory worth restoring; the rest is Chromium's cache and pnpm's store. */
export const APP_DATA_ENTRIES = ['home', 'extensions', 'logs'] as const;

/** This package's own name: a restore never writes over the copy that is running it. */
export const MEMORY_BACKUP_PACKAGE = 'coopanion-world-memory-backup';

/** True when `dir` is the app data directory: `home/` sits in it. */
export const isAppDataDir = (dir: string): boolean => existsSync(join(dir, 'home'));

/** The directory that holds `home/`, `extensions/` and `logs/`. */
export function appDataRoot(botDir: string): string {
  const extensions = process.env.CORTICO_EXTENSIONS_DIR;
  if (extensions && isAbsolute(extensions)) {
    const candidate = dirname(resolve(extensions));
    if (isAppDataDir(candidate)) return candidate;
  }
  return dirname(resolve(botDir));
}

/** Snapshots go under the user's home directory, where uninstalling the program does not take them. */
export const defaultBackupDir = (): string => join(homedir(), 'Coopanion', 'memory-backups');
