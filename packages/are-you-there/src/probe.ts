/**
 * 锁屏探针：Windows 锁屏时会拉起 `LogonUI.exe`，解锁之后它退出。
 *
 * 宿主没有系统事件可以订阅，所以只能轮询。`tasklist` 一次调用几毫秒，比 `powershell` 快一个量级；
 * 失败（超时、进程起不来）当作「不知道」，绝不当成「解锁」。
 *
 * 只依赖 node 内置模块，测试不需要宿主源码。
 */
import { execFile } from 'node:child_process';

/** 一次 `tasklist` 最多等多久。机器忙的时候它也慢，但再慢就没意义了。 */
export const PROBE_TIMEOUT_MS = 5_000;

/** 连续读到几次同一个结果才算数；一次读数可能是 `tasklist` 自己的抖动。 */
export const CONFIRM_READS = 2;

/** 只看这一个进程。参数固定，所以测试可以拿它比对。 */
export const TASKLIST_ARGS: readonly string[] = ['/NH', '/FO', 'CSV', '/FI', 'IMAGENAME eq LogonUI.exe'];

export interface ProbeResult {
  /** `true` 锁着、`false` 解锁着、`null` 读不到（非 Windows 或命令失败）。 */
  locked: boolean | null;
  /** 失败原因，给工具回执用；成功时为空串。 */
  error: string;
}

/** 把「跑一次 tasklist 并拿到 stdout」抽出来，测试可以换掉。 */
export type TasklistRunner = (args: readonly string[], timeoutMs: number) => Promise<string>;

export const runTasklist: TasklistRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      'tasklist',
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

/**
 * CSV 输出里出现 `LogonUI.exe` 就是锁着。
 *
 * 没有匹配时 `tasklist` 打的提示语随系统语言变（「信息: 没有运行的任务…」），所以只认进程名，
 * 不去认提示语。
 */
export function parseTasklist(stdout: string): boolean {
  return /logonui\.exe/i.test(stdout);
}

/** 读一次锁屏状态。非 Windows 直接返回「不知道」，不发命令。 */
export async function probeLocked(run: TasklistRunner = runTasklist, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if (process.platform !== 'win32') return { locked: null, error: 'not windows' };
  try {
    return { locked: parseTasklist(await run(TASKLIST_ARGS, timeoutMs)), error: '' };
  } catch (error) {
    return { locked: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 去抖：候选值与连续命中次数。 */
export interface Debounce {
  candidate: boolean | null;
  count: number;
}

export const emptyDebounce = (): Debounce => ({ candidate: null, count: 0 });

/** 读失败（`null`）不动候选，只把成功的一次并进去。 */
export function feedReading(prev: Debounce, reading: boolean | null): Debounce {
  if (reading === null) return prev;
  return prev.candidate === reading
    ? { candidate: reading, count: prev.count + 1 }
    : { candidate: reading, count: 1 };
}

/** 连续 `need` 次读到同一结果才交出这个结果，否则 `null`（还不能下结论）。 */
export function confirmedReading(prev: Debounce, need = CONFIRM_READS): boolean | null {
  return prev.candidate !== null && prev.count >= need ? prev.candidate : null;
}
