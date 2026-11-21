/**
 * 体检：只读，把三份流水的结构打出来——每份几块、日期到哪、缺哪天、哪天重复。
 *
 * 用法：node scripts/check.ts <workspace 目录> [config.json]
 * 规则和开关一起放在 config.json 的 `worlds.memory-ledger.settings` 段；没建过时从旧规则迁一次。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { audit, auditLines } from '../src/audit.ts';
import { readSettings, rulesText } from '../src/settings.ts';
import type { MemoryLedgerConfigSection } from '../src/config.ts';

const folder = resolve(process.argv[2] ?? '.');
const configPath = resolve(process.argv[3] ?? join(folder, '..', 'config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  worlds?: Record<string, Partial<MemoryLedgerConfigSection>>;
};
const cfg = { ...config.worlds?.['memory-ledger'] } as MemoryLedgerConfigSection;
const rules = rulesText(readSettings(dirname(configPath), cfg));
if (!rules) {
  console.error(`没有可用的索引规则：${configPath}`);
  process.exit(1);
}

const now = new Date();
const two = (n: number) => String(n).padStart(2, '0');
const today = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;

const report = audit(folder, rules, today);
console.log(`目录：${folder}`);
console.log(`规则：${rules}`);
console.log('');
for (const line of auditLines(report, today)) console.log(line);
