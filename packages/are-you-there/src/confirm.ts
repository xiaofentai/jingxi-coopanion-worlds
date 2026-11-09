/**
 * 空闲到阈值之后的「一次判定」：看看前台是什么窗口、屏幕在不在变，再决定要不要真的判成离开。
 *
 * 两块都不需要模型：前台窗口只是进程名与标题，屏幕只是两次取样后的像素差分。画面留在子进程里，
 * 不落盘，也不发给任何人。
 *
 * 解析函数是纯的，测试不需要 Windows；只有 `runForeground` / `runScreen` 会真的起 PowerShell。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FOREGROUND_SCRIPT = fileURLToPath(new URL('./foreground.ps1', import.meta.url));
export const SCREEN_SCRIPT = fileURLToPath(new URL('./screen.ps1', import.meta.url));

/** 一次截图差分最多等多久（脚本自己隔 1.8 秒取两帧）。 */
export const SCREEN_TIMEOUT_MS = 15_000;
export const FOREGROUND_TIMEOUT_MS = 10_000;

/** 差分超过这个百分比才算「屏幕在变」；任务栏时钟之类的小动作到不了这里。 */
export const SCREEN_CHANGED_PERCENT = 2;

export interface ForegroundInfo {
  /** 进程名，如 `chrome`。 */
  process: string;
  /** 窗口标题，可能与进程名无关。 */
  title: string;
}

/** `FG 1234 chrome | 标题` → `{ process: 'chrome', title: '标题' }`；`FG NONE` 或别的输出 → null。 */
export function parseForegroundLine(line: string): ForegroundInfo | null {
  const m = /^FG\s+\d+\s+(\S+)\s*\|\s*(.*)$/.exec(line.trim());
  if (!m) return null;
  return { process: m[1]!.toLowerCase(), title: (m[2] ?? '').trim() };
}

/** `SHOT 3.4 1800` → 3.4；`SHOT FAIL ...` 或别的输出 → null。 */
export function parseShotLine(line: string): number | null {
  const m = /^SHOT\s+(\d+(?:\.\d+)?)\s+\d+\s*$/.exec(line.trim());
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

/** 逗号、分号、换行分隔的关键词，全部转小写并去空。 */
export function splitKeywords(text: string): string[] {
  return text
    .split(/[,;，；\n]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/** 进程名或窗口标题里出现任一关键词就算命中（大小写不敏感）。 */
export function mediaMatch(info: ForegroundInfo, keywords: string[]): boolean {
  if (!keywords.length) return false;
  const haystack = `${info.process} ${info.title}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

/** 拿出来给 World 用的两步检查；测试可以换掉。 */
export interface ConfirmProbe {
  foreground(): Promise<ForegroundInfo | null>;
  /** 屏幕变化百分比；读不到就是 null。 */
  screen(): Promise<number | null>;
}

function run(script: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error && !stdout ? null : stdout),
    );
  });
}

export const defaultConfirmProbe: ConfirmProbe = {
  async foreground() {
    if (process.platform !== 'win32') return null;
    const out = await run(FOREGROUND_SCRIPT, FOREGROUND_TIMEOUT_MS);
    return out === null ? null : parseForegroundLine(out);
  },
  async screen() {
    if (process.platform !== 'win32') return null;
    const out = await run(SCREEN_SCRIPT, SCREEN_TIMEOUT_MS);
    return out === null ? null : parseShotLine(out);
  },
};
