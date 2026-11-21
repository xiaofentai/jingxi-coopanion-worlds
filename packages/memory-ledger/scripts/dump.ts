/**
 * 本地出卡对比的残余入口：现在只看 ledger 自己的三份索引。
 *
 * 用法：node scripts/dump.ts <workspace 目录> [config.json]
 * 规则从 config.json 的 `worlds.memory-ledger.settings` 段读；整份文件归 memory-card，不在这里对照。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildBoard } from '../src/board.ts';
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
const stamp = `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
const today = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;

const board = buildBoard({
  folder,
  rules,
  listOthers: false,
  listMax: 0,
  exclude: [],
  stamp,
  today,
  language: 'zh',
});

const line = (label: string, text: string) => `${label.padEnd(10, ' ')}${text}`;
console.log(`目录：${folder}`);
console.log(`规则：${rules}`);
console.log('');
console.log(line('记忆树网', `${board.card.length} 字　${board.meta}`));
console.log('');
console.log('每份载入：');
for (const item of board.loaded) {
  console.log(`  ${item.path}　目录 ${item.kept} 字／源 ${item.source} 字`);
}
console.log('');
console.log('覆盖：');
console.log(`  ${board.cover.from ?? '?'} ~ ${board.cover.to ?? '?'}　缺 ${board.cover.missing.length} 天` +
  (board.cover.missing.length ? `：${board.cover.missing.join('、')}` : ''));
for (const dup of board.cover.duplicates) console.log(`  重复 ${dup.date}：${dup.files.join(' 与 ')}`);
