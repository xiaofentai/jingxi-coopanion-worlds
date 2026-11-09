/**
 * 键盘鼠标空闲多久：`GetLastInputInfo` 只有原生调用拿得到，所以让一个常驻 PowerShell 每两秒报一次。
 *
 * 不用一次性 `powershell -Command`：那样每查一次都要重新 `Add-Type` 编译一遍，实测启动就要 0.8 秒，
 * 按轮询间隔反复起进程太浪费。这里只起一次，读不到就退避重来，World 停掉时一并杀掉。
 *
 * 只依赖 node 内置模块，测试可以只测解析。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 随包发出的取值脚本。 */
export const IDLE_SCRIPT = fileURLToPath(new URL('./idle.ps1', import.meta.url));

/** 超过这么久没收到新读数就当作「不知道」，免得进程悄悄死了还拿着半小时前的值当事实。 */
export const STALE_AFTER_MS = 60_000;

const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 60_000;

export interface IdleReading {
  /** 键盘鼠标空闲了多少毫秒。 */
  idleMs: number;
  /** 这个读数是什么时候收到的，epoch ms。 */
  at: number;
}

/** `IDLE 1234` → 1234；`FAIL` 或别的输出 → null。 */
export function parseIdleLine(line: string): number | null {
  const m = /^IDLE\s+(\d+)\s*$/.exec(line.trim());
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

/** World 只需要「最近一次读数」，测试可以塞一个假的。 */
export interface IdleSource {
  latest(): IdleReading | null;
}

export class IdleTracker implements IdleSource {
  private child: ChildProcess | null = null;
  private reading: IdleReading | null = null;
  private buffer = '';
  private failures = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private errorText = '';

  constructor(private readonly script = IDLE_SCRIPT) {}

  /** 拉起子进程；已经在跑就什么都不做。 */
  start(): void {
    this.stopped = false;
    if (this.child !== null) return;
    if (process.platform !== 'win32') {
      this.errorText = 'not windows';
      return;
    }
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.child = child;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.consume(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        this.errorText = chunk.trim().slice(0, 200);
      });
      child.on('error', (error) => {
        this.errorText = error.message;
        this.onExit();
      });
      child.on('exit', () => this.onExit());
    } catch (error) {
      this.errorText = error instanceof Error ? error.message : String(error);
      this.scheduleRestart();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    this.reading = null;
    this.buffer = '';
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 已经退出了
      }
    }
  }

  /** 最近一次读数；太旧或还没读到就返回 null。 */
  latest(): IdleReading | null {
    const reading = this.reading;
    if (reading === null) return null;
    return Date.now() - reading.at <= STALE_AFTER_MS ? reading : null;
  }

  /** 给工具回执用的失败原因，正常为空串。 */
  error(): string {
    return this.latest() === null ? this.errorText : '';
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const idleMs = parseIdleLine(line);
      if (idleMs !== null) {
        this.reading = { idleMs, at: Date.now() };
        this.failures = 0;
        this.errorText = '';
      } else if (line.trim() === 'FAIL') {
        this.errorText = 'GetLastInputInfo failed';
      }
      index = this.buffer.indexOf('\n');
    }
    // 一行异常地长，说明输出不是我们认得的格式，别无限攒着
    if (this.buffer.length > 4096) this.buffer = '';
  }

  private onExit(): void {
    this.child = null;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.timer !== null) return;
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.min(this.failures, 4));
    this.failures += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.start();
    }, delay);
    this.timer.unref();
  }
}
