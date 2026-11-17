/**
 * 毫米波雷达：HLK-LD2402 接 USB 转 TTL，串口 115200 8N1，正常模式每 165 ms 吐一行。
 *
 * `OFF` 是「范围内没人」，`distance:79` 是「有人在 79 cm」。只管两种行，命令协议交给
 * `radar.ps1`——参数配置只在启动时做一次，走的是同一份脚本。
 *
 * 和 `idle.ts` 一样起一个常驻 PowerShell 读串口，区别是重连更快：拔掉后读操作抛异常、进程退出，
 * 一秒后重来，插回去一两秒就恢复。端口号每次重连都让脚本重新枚举，不缓存。
 *
 * 判定不在这里做。这里只回答「最近一帧是什么、多久以前」，迟滞与阈值在 `decideRadar` 里，
 * 纯函数、不读时钟。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 随包发出的取数脚本。 */
export const RADAR_SCRIPT = fileURLToPath(new URL('./radar.ps1', import.meta.url));

/** 超过这么久没收到新帧就当作「读不到」。传感器 165 ms 一帧，5 秒已经是很宽的余量。 */
export const RADAR_STALE_MS = 5_000;

/** 连续这么久「有人」的距离都在上限之外，说明模块参数被重置或摆位变了。 */
export const RADAR_FAR_LIMIT_MS = 5 * 60_000;

/** 热插拔要快，所以是固定值，不像 `idle.ts` 那样指数退避。 */
const RESTART_MS = 1_000;

const BUFFER_LIMIT = 4 * 1024;

export type RadarLine =
  | { kind: 'ready'; port: string }
  | { kind: 'present'; cm: number }
  | { kind: 'absent' }
  | { kind: 'cfg'; text: string }
  | { kind: 'fail'; reason: string };

/** `radar.ps1` 的一行输出；不认得的行返回 `null`，调用方直接丢掉。 */
export function parseRadarLine(raw: string): RadarLine | null {
  const line = raw.trim();
  if (line === 'ABSENT') return { kind: 'absent' };
  let m = /^PRESENT\s+(\d+)$/.exec(line);
  if (m !== null) return { kind: 'present', cm: Number(m[1]) };
  m = /^READY\s+(\S+)$/.exec(line);
  if (m !== null) return { kind: 'ready', port: m[1]! };
  m = /^CFG\s+(.+)$/.exec(line);
  if (m !== null) return { kind: 'cfg', text: m[1]! };
  m = /^FAIL\s+(\S+)$/.exec(line);
  if (m !== null) return { kind: 'fail', reason: m[1]! };
  return null;
}

/** 一次连接里累计下来的读数，全部是时间戳，不存帧队列。 */
export interface RadarReading {
  /** 最近一帧的时间；没连上时是 0。 */
  at: number;
  /** 当前连接上第一帧的时间。 */
  connectedAt: number | null;
  /** 最近一次「有人在 `maxCm` 以内」的时间。 */
  lastPresentAt: number | null;
  /** 当前这段连续「有人」从什么时候开始；最后一帧不是有人就是 `null`。 */
  presentSince: number | null;
  /** 刚刚结束的那段「有人」有多久，ms；还没结束过就是 `null`。 */
  streakMs: number | null;
  /** 刚刚那段「有人」是什么时候结束的；下一段开始时清空。 */
  streakEndedAt: number | null;
  /** 最近一次「有人」的距离，cm。 */
  cm: number | null;
  /** 当前这段「距离全都超上限」从什么时候开始，`null` 表示最近一帧在范围内。 */
  farSince: number | null;
  /** 这次连接里确认过至少一次「有人」；没有过就先不拿它判离开。 */
  sawNear: boolean;
  /** 端口开着没有。 */
  linked: boolean;
  /** 端口名，给回执看。 */
  port: string;
  /** 读不到的原因；正常时为空串。 */
  problem: string;
}

export const emptyRadarReading = (): RadarReading => ({
  at: 0,
  connectedAt: null,
  lastPresentAt: null,
  presentSince: null,
  streakMs: null,
  streakEndedAt: null,
  cm: null,
  farSince: null,
  sawNear: false,
  linked: false,
  port: '',
  problem: '',
});

/** World 只需要「最近一次读数」，测试可以塞一个假的。 */
export interface RadarSource {
  latest(): RadarReading | null;
}

export interface RadarThresholds {
  /** 只把这么近的人算作「在桌前」，cm。 */
  maxCm: number;
  /** 连续多久没读到人算离开。 */
  absentMs: number;
  /** 连续读到人多久才撤销「离开」。 */
  backMs: number;
}

/** 去抖之后的一次雷达结论。 */
export interface RadarDecision {
  /** 稳定认定桌前有人。 */
  present: boolean;
  /** 稳定认定桌前没人。 */
  absent: boolean;
  /** 连续多久没读到人，`absent` 为真时才有值。 */
  absentMs: number | null;
  /** 最近一次读到的距离，cm。 */
  cm: number | null;
}

/**
 * 把读数翻成结论。三种情况都返回 `null`——还在过渡、读不到、或者这份数据本来就不可信：
 *
 * - 没开、没连上、帧太旧；
 * - 这次连接里从没在 `maxCm` 以内见到过人。模块最大距离被重置成 8.5 m 时，它测到的是
 *   房间里更远的人，距离全是 100–270 cm；这时如果照着「没人在 120 cm 内」判离开，会在人
 *   好好坐着的时候报离开。所以没见过近处的人之前，雷达不表态，让锁屏与键鼠照常工作。
 */
export function decideRadar(
  reading: RadarReading | null,
  now: number,
  thresholds: RadarThresholds,
): RadarDecision | null {
  if (reading === null) return null;
  if (!reading.linked) return null;
  if (reading.at === 0 || now - reading.at > RADAR_STALE_MS) return null;
  if (reading.farSince !== null && now - reading.farSince >= RADAR_FAR_LIMIT_MS) return null;
  if (!reading.sawNear || reading.lastPresentAt === null) return null;

  const absentMs = now - reading.lastPresentAt;
  if (absentMs >= thresholds.absentMs) {
    return { present: false, absent: true, absentMs, cm: reading.cm };
  }
  if (reading.presentSince !== null && now - reading.presentSince >= thresholds.backMs) {
    return { present: true, absent: false, absentMs: null, cm: reading.cm };
  }
  return null;
}

export interface RadarTrackerOptions {
  /** 测试可以换掉脚本路径。 */
  script?: string;
  /** `auto` 让脚本自己枚举 USB 串口；也可以写死 `COM5`。 */
  port?: string;
  /** 模块最大距离，0.1 m 单位；0 表示不碰模块参数。 */
  maxDistance?: number;
  /** 软件侧「在桌前」的上限，cm；配置是活的，所以给个取值函数。 */
  maxCm?: () => number;
}

export class RadarTracker implements RadarSource {
  private child: ChildProcess | null = null;
  private reading: RadarReading = emptyRadarReading();
  private buffer = '';
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWasPresent = false;

  constructor(private readonly opts: RadarTrackerOptions = {}) {}

  /** 拉起子进程；已经在跑就什么都不做。 */
  start(): void {
    this.stopped = false;
    if (this.child !== null) return;
    if (process.platform !== 'win32') {
      this.reading = { ...emptyRadarReading(), problem: 'not-windows' };
      return;
    }
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.opts.script ?? RADAR_SCRIPT,
      '-Port', this.opts.port !== undefined && this.opts.port !== '' ? this.opts.port : 'auto',
      '-MaxDistance', String(this.opts.maxDistance ?? 0),
    ];
    try {
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.reading = emptyRadarReading();
      this.buffer = '';
      this.lastWasPresent = false;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.consume(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text !== '') this.reading = { ...this.reading, problem: text.slice(0, 200) };
      });
      child.on('error', (error) => {
        this.reading = { ...this.reading, linked: false, problem: error.message };
        this.onExit();
      });
      child.on('exit', () => this.onExit());
    } catch (error) {
      this.reading = {
        ...this.reading,
        linked: false,
        problem: error instanceof Error ? error.message : String(error),
      };
      this.scheduleRestart();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    this.reading = emptyRadarReading();
    this.buffer = '';
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 已经退出了
      }
    }
  }

  latest(): RadarReading | null {
    return this.reading.at === 0 && !this.reading.linked ? null : this.reading;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.accept(parseRadarLine(line));
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > BUFFER_LIMIT) this.buffer = '';
  }

  private accept(line: RadarLine | null): void {
    if (line === null) return;
    const now = Date.now();
    switch (line.kind) {
      case 'ready':
        this.reading = { ...this.reading, linked: true, port: line.port, problem: '' };
        return;
      case 'cfg':
        // 模块参数是配置动作，不参与判定；留在 problem 里方便回执照抄
        this.reading = { ...this.reading, problem: '' };
        return;
      case 'fail':
        this.reading = { ...this.reading, linked: false, problem: line.reason };
        return;
      case 'absent':
        this.reading = {
          ...this.reading,
          at: now,
          connectedAt: this.reading.connectedAt ?? now,
          ...this.endStreak(now),
        };
        this.lastWasPresent = false;
        return;
      case 'present': {
        const maxCm = this.opts.maxCm?.() ?? 0;
        const near = maxCm <= 0 || line.cm <= maxCm;
        // 距离在上限之外的帧只更新「看了多远」，不算「有人在桌前」，也不刷新最近有人时间
        const base: RadarReading = {
          ...this.reading,
          at: now,
          connectedAt: this.reading.connectedAt ?? now,
          farSince: near ? null : this.reading.farSince ?? now,
        };
        if (!near) {
          this.reading = { ...base, ...this.endStreak(now) };
          this.lastWasPresent = false;
          return;
        }
        this.reading = {
          ...base,
          lastPresentAt: now,
          presentSince: this.lastWasPresent ? this.reading.presentSince ?? now : now,
          // 新的一段「有人」开始了，上一段的时长留给 World 去判断是不是只是路过
          streakMs: this.lastWasPresent ? this.reading.streakMs : null,
          streakEndedAt: this.lastWasPresent ? this.reading.streakEndedAt : null,
          cm: line.cm,
          sawNear: true,
        };
        this.lastWasPresent = true;
        return;
      }
    }
  }

  /** 一段「有人」刚结束：记下它有多长、什么时候结束的。 */
  private endStreak(now: number): Pick<RadarReading, 'presentSince' | 'streakMs' | 'streakEndedAt'> {
    const since = this.reading.presentSince;
    if (since === null) {
      return {
        presentSince: null,
        streakMs: this.reading.streakMs,
        streakEndedAt: this.reading.streakEndedAt,
      };
    }
    return { presentSince: null, streakMs: now - since, streakEndedAt: now };
  }

  private onExit(): void {
    this.child = null;
    this.reading = { ...this.reading, linked: false };
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.start();
    }, RESTART_MS);
    this.timer.unref();
  }
}
