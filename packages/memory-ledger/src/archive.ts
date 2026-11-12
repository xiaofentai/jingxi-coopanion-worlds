/**
 * 归档文件的准备。
 *
 * 为什么单独一个文件：`world.ts` 会 import `cortico/*`，那是宿主的模块钩子才解析得了的路径，
 * 在普通 `node --test` 里 import 不了。把这段纯 fs 的代码挪出来，它就能被单独测。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ARCHIVE_FRONT, DEFAULT_ARCHIVE_FILE } from './config.ts';

/** 记忆目录下的相对路径 → 绝对路径；越界（绝对路径、`..`）返回 null。 */
export function landingSpot(folder: string, rel: string): string | null {
  const wanted = (rel ?? '').trim().replaceAll('\\', '/') || DEFAULT_ARCHIVE_FILE;
  if (isAbsolute(wanted) || /^[a-zA-Z]:/.test(wanted) || wanted.split('/').includes('..')) return null;
  const full = resolve(join(folder, wanted));
  const prefix = `${resolve(folder)}${folder.includes('\\') || process.platform === 'win32' ? '\\' : '/'}`;
  return full.startsWith(prefix) ? full : null;
}

/**
 * 启用时把归档文件建出来，返回它的绝对路径。
 *
 * 两个原因：设置页的文件选择器只能选到已存在的文件；第一次 `ml_forget` 也不该因为
 * 「目标不存在」失败。建不出来返回 null——读路径不受影响，真正的写入还会再试一次。
 */
export function ensureArchiveFile(folder: string, rel: string): string | null {
  const full = landingSpot(folder, rel);
  if (!full) return null;
  try {
    if (!existsSync(full)) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, ARCHIVE_FRONT, 'utf8');
    }
    return full;
  } catch {
    return null;
  }
}

/**
 * 归档目录下所有 `.md` 里出现过的日期（`## 2026-11-05` 这种块标题）。
 *
 * 只扫标题、不解析正文——归档会越积越大，每次生成前缀都全文 parse 太贵。
 * 用途只有一个：把搬走的那些天算回覆盖里，否则「中间某天搬走」会被误报成缺口。
 */
export function archivedDates(folder: string, archiveRel: string, year: number): string[] {
  const full = landingSpot(folder, archiveRel);
  if (!full) return [];
  const dir = dirname(full);
  const out: string[] = [];
  try {
    if (!existsSync(dir)) return [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const text = readFileSync(join(dir, name), 'utf8');
      // 两种标题都认：`## 11-05`（日块的短格式）和 `## 2026-11-05`
      for (const m of text.matchAll(/^##\s+(?:(\d{4})-)?(\d{2})-(\d{2})\b/gm)) {
        out.push(`${m[1] ?? year}-${m[2]}-${m[3]}`);
      }
    }
  } catch {
    return [];
  }
  return out;
}
