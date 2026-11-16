/**
 * 量一下**你这台机器、你这个模型**的缓存有效期，并给出 `afterMinutes` 的建议值。
 *
 * 这个插件的默认值（40 分钟）是在 LongCat-2.5 上测出来的，换一个厂商就是另一组数：
 * 有的前缀缓存只有几分钟，有的按小时的整点失效，有的干脆不缓存、或者不回报缓存命中。
 * 所以装之前先跑这个脚本，别照抄别人的数。
 *
 * 用法：
 *   node scripts/measure.ts                       # 用默认位置（Coopanion 安装目录）
 *   node scripts/measure.ts <usage.jsonl>         # 指定文件
 *
 * 判据只看两件事：距上次调用多久（gap）、这一次有多少 token 没命中缓存（uncached）。
 * 缓存还热着的时候，gap 再大也几乎不产生未命中；一旦整段未命中，说明缓存已经没了。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Row {
  at: number;
  gapMs: number | null;
  prompt: number;
  uncached: number;
}

/** 小于这个间隔的样本不看：交接和配置改动会在这个量级上制造「整段未命中」，那不是缓存过期。 */
const MIN_GAP_MS = 3 * 60_000;
/** 未命中占 prompt 的比例低于它，算「命中良好」。 */
const HIT_RATIO = 0.1;
/** 高于它，算「整段未命中」。 */
const MISS_RATIO = 0.5;

const BUCKETS: Array<{ label: string; from: number; to: number }> = [
  { label: '<3 分', from: 0, to: 3 },
  { label: '3–15 分', from: 3, to: 15 },
  { label: '15–30 分', from: 15, to: 30 },
  { label: '30–45 分', from: 30, to: 45 },
  { label: '45–60 分', from: 45, to: 60 },
  { label: '60–75 分', from: 60, to: 75 },
  { label: '75–90 分', from: 75, to: 90 },
  { label: '90–120 分', from: 90, to: 120 },
  { label: '2–4 小时', from: 120, to: 240 },
  { label: '4 小时以上', from: 240, to: Number.POSITIVE_INFINITY },
];

function defaultPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return join(home, 'AppData', 'Local', 'Programs', 'Coopanion', 'data', 'home', 'companion', 'data', 'usage.jsonl');
}

function load(file: string): Row[] {
  const rows: Array<{ at: number; prompt: number; uncached: number }> = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof rec.ts === 'string' ? Date.parse(rec.ts) : Number.NaN;
    if (!Number.isFinite(ts)) continue;
    const prompt = Number(rec.promptTokens ?? 0);
    const cached = Number(rec.cacheHitTokens ?? 0);
    // 世界自己上报的用量不算主 session 的调用
    if (rec.sessionId !== undefined && rec.sessionId !== 'main') continue;
    rows.push({ at: ts, prompt, uncached: Math.max(0, prompt - cached) });
  }
  rows.sort((a, b) => a.at - b.at);
  return rows.map((r, i) => ({
    ...r,
    gapMs: i === 0 ? null : r.at - rows[i - 1]!.at,
  }));
}

function main(): void {
  const file = process.argv[2] ?? defaultPath();
  if (!existsSync(file)) {
    console.error(`找不到 ${file}`);
    console.error('用法：node scripts/measure.ts <usage.jsonl 的路径>');
    process.exitCode = 1;
    return;
  }

  const rows = load(file);
  if (rows.length < 10) {
    console.error(`只有 ${rows.length} 条调用记录，样本太少，量不出来。`);
    process.exitCode = 1;
    return;
  }

  const totalCached = rows.reduce((sum, r) => sum + (r.prompt - r.uncached), 0);
  console.log(`样本 ${rows.length} 次调用，跨 ${((rows[rows.length - 1]!.at - rows[0]!.at) / 86_400_000).toFixed(1)} 天`);
  console.log(file);
  console.log();

  if (totalCached === 0) {
    console.warn('⚠️ 所有记录的 cacheHitTokens 都是 0：这个上游没有回报缓存命中，');
    console.warn('   说明它可能不做前缀缓存，或者不在 usage 里报。这个插件对你省不到钱，别开。');
    console.warn();
  }

  console.log('距上次调用的间隔 → 缓存命中情况');
  console.log('  间隔          次数        输入 token      未命中 token   未命中率  整段miss');

  interface Stat { label: string; from: number; to: number; n: number; input: number; uncached: number; whole: number; rate: number }
  const stats: Stat[] = [];
  for (const b of BUCKETS) {
    const sub = rows.filter((r) => {
      if (r.gapMs === null || r.prompt <= 0) return false;
      const minutes = r.gapMs / 60_000;
      return minutes >= b.from && minutes < b.to;
    });
    if (sub.length === 0) continue;
    const input = sub.reduce((s, r) => s + r.prompt, 0);
    const uncached = sub.reduce((s, r) => s + r.uncached, 0);
    const whole = sub.filter((r) => r.uncached > r.prompt * MISS_RATIO).length;
    const stat: Stat = { ...b, n: sub.length, input, uncached, whole, rate: uncached / Math.max(1, input) };
    stats.push(stat);
    const pct = (stat.rate * 100).toFixed(2);
    console.log(`  ${b.label.padEnd(12)} ${String(stat.n).padStart(6)} ${input.toLocaleString().padStart(14)}`
      + ` ${uncached.toLocaleString().padStart(14)} ${(pct + '%').padStart(9)} ${String(whole).padStart(7)}`);
  }
  console.log();

  // 只看间隔够长的样本：短间隔上的整段未命中几乎都是交接或改配置，不是缓存过期
  const usable = rows.filter((r) => r.gapMs !== null && r.gapMs >= MIN_GAP_MS && r.prompt > 0);
  const hits = usable.filter((r) => r.uncached <= r.prompt * HIT_RATIO);
  if (hits.length < 5) {
    console.warn('⚠️ 「命中良好」的样本不到 5 个：多半是每次调用都整段未命中（上游不缓存），');
    console.warn('   或者是上下文每隔一轮就被重建。这个插件救不了，别开。');
    return;
  }

  /**
   * 找「未命中率从哪一桶开始跳起来」，而不是拟合一个单阈值。
   *
   * 原因是数据里天然有干扰：闲置几小时后**重启**，只要前缀内容碰巧一模一样，那一次照样命中；
   * 反过来，交接或改配置会让 5 分钟的空档也整段未命中。任何「gap 大于多少就必然过期」的
   * 单阈值拟合都会被这两类样本拉偏（实测会把边界顶到 2000 分钟以上）。
   * 分桶看「整桶的未命中率」稳得多：短间隔的杂音被摊薄，长间隔的离群也不会单独说话。
   */
  const JUMP_RATE = 0.15;
  const MIN_SAMPLES = 5;
  const jumpAt = stats.findIndex((s) => s.n >= MIN_SAMPLES && s.rate >= JUMP_RATE);
  const lastClean = jumpAt <= 0 ? undefined : stats[jumpAt - 1];

  if (jumpAt < 0) {
    const tail = stats[stats.length - 1];
    console.log('样本期内未命中率一次都没跳起来：要么缓存到现在还没过期，要么这张表里没有足够长的空档。');
    if (tail) {
      console.log(`最长的一桶是「${tail.label}」，未命中率 ${(tail.rate * 100).toFixed(2)}%。`);
      console.log(`→ 缓存至少能活 ${tail.to === Number.POSITIVE_INFINITY ? '4 小时以上' : `${tail.to} 分钟`}；`);
      console.log(`   afterMinutes 先填 ${suggest(tail.from * 60_000)} 保守一点，多跑几天再复量。`);
    }
    return;
  }

  const jump = stats[jumpAt]!;
  if (jumpAt === 0) {
    console.log(`最短的一桶「${jump.label}」未命中率就到 ${(jump.rate * 100).toFixed(2)}%：有效期比它还短。`);
    console.log(`→ afterMinutes 填最小值 10，或者干脆别开这个插件（缓存撑不过两拍）。`);
    return;
  }

  const ttlMs = jump.from * 60_000;
  console.log(`未命中率在「${lastClean?.label ?? '—'}」还有 ${((lastClean?.rate ?? 0) * 100).toFixed(2)}%，`
    + `到「${jump.label}」跳到 ${(jump.rate * 100).toFixed(2)}%。`);
  console.log();
  console.log(`→ 缓存有效期大约 ${jump.from} 分钟（落在这两桶的分界上）。`);
  console.log(`→ afterMinutes 建议填 ${suggest(ttlMs)}：留一倍余量，别贴着边界走。`);
  console.log('→ 这个数是这台机器、这个上游、这段时间的性质；换了厂商要重新跑。');
}

/** 取有效期的六成左右，再取整到 5 的倍数，最后夹在插件允许的 10–70 之间。 */
function suggest(ttlMs: number): number {
  const raw = (ttlMs / 60_000) * 0.55;
  const rounded = Math.round(raw / 5) * 5;
  return Math.min(70, Math.max(10, rounded));
}

main();
