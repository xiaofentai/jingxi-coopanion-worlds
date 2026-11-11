/**
 * 本地对比：拿同一批文件，各出一页——记忆卡（memory-card）与记忆板（memory-ledger）。
 *
 * 用法：node scripts/dump.ts <workspace 目录> [config.json]
 * 规则从 config.json 的 `worlds.memory-card` 读，好让两边用同一套规则比。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCard } from '../../memory-card/src/card.ts';
import { buildBoard } from '../src/board.ts';

interface CardConfig {
  folder?: string;
  rule1?: string;
  rule2?: string;
  rule3?: string;
  rule4?: string;
  rule5?: string;
  extraRules?: string;
  totalChars?: number;
  listOthers?: boolean;
  listMax?: number;
  exclude?: string;
}

function rulesOf(cfg: CardConfig): string {
  const slots = [cfg.rule1, cfg.rule2, cfg.rule3, cfg.rule4, cfg.rule5]
    .map((rule) => (rule ?? '').trim())
    .filter(Boolean);
  const extra = (cfg.extraRules ?? '').split(/[;；\n]+/).map((r) => r.trim()).filter(Boolean);
  return [...slots, ...extra].join('; ');
}

function list(text: string): string[] {
  return (text ?? '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

function stamp(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

function today(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

const folder = resolve(process.argv[2] ?? '.');
const configPath = resolve(process.argv[3] ?? join(folder, '..', 'config.json'));

const config = JSON.parse(readFileSync(configPath, 'utf8')) as { worlds?: Record<string, CardConfig> };
const cfg = config.worlds?.['memory-ledger'] ?? config.worlds?.['memory-card'] ?? {};
const rules = rulesOf(cfg);
if (!rules) {
  console.error(`config.json 里没有 worlds.memory-ledger（或 worlds.memory-card）的规则：${configPath}`);
  process.exit(1);
}

const at = stamp();
const shared = {
  folder,
  rules,
  listOthers: cfg.listOthers !== false,
  listMax: typeof cfg.listMax === 'number' ? cfg.listMax : 12,
  exclude: list(cfg.exclude ?? ''),
  stamp: at,
};

const card = buildCard({ ...shared, totalChars: cfg.totalChars ?? 6000, language: 'zh' });
const board = buildBoard({ ...shared, today: today(), language: 'zh' });

const line = (label: string, text: string) => `${label.padEnd(10, ' ')}${text}`;
console.log(`目录：${folder}`);
console.log(`规则：${rules}`);
console.log('');
console.log(line('记忆卡', `${card.card.length} 字　${card.meta}`));
console.log(line('记忆板', `${board.card.length} 字　${board.meta}`));
console.log('');

const byPath = new Map(card.loaded.map((item) => [item.path, item.kept]));
const rows = board.loaded.map((item) => {
  const before = byPath.get(item.path);
  byPath.delete(item.path);
  return `  ${item.path}　卡片 ${before ?? '-'} ／ 板 ${item.kept}　源 ${item.source}`;
});
console.log('每份载入：');
for (const row of rows) console.log(row);
for (const [path, kept] of byPath) console.log(`  ${path}　卡片 ${kept} ／ 板 -（未载入）`);

console.log('');
console.log('覆盖：');
console.log(`  ${board.cover.from ?? '?'} ~ ${board.cover.to ?? '?'}　缺 ${board.cover.missing.length} 天` +
  (board.cover.missing.length ? `：${board.cover.missing.join('、')}` : ''));
for (const dup of board.cover.duplicates) console.log(`  重复 ${dup.date}：${dup.files.join(' 与 ')}`);

// 行级差异：只报记忆板独有、或两边都有但字数不同的行，避免把整张卡打出来
const before = new Set(card.card.split('\n'));
const extra = board.card.split('\n').filter((row) => !before.has(row));
console.log('');
console.log(`记忆板多出来 ${extra.length} 行：`);
for (const row of extra) console.log(`  ${row}`);
