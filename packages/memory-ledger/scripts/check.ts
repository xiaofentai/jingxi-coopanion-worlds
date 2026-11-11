/**
 * 体检：只读，把记忆的结构打出来——每份几块、日期到哪、缺哪天、哪天重复。
 *
 * 用法：node scripts/check.ts <workspace 目录> [config.json]
 * 规则从 config.json 的 `worlds.memory-card` 读，好和现在用的那套对齐。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audit, auditLines } from '../src/audit.ts';

interface CardConfig {
  rule1?: string;
  rule2?: string;
  rule3?: string;
  rule4?: string;
  rule5?: string;
  extraRules?: string;
}

function rulesOf(cfg: CardConfig): string {
  const slots = [cfg.rule1, cfg.rule2, cfg.rule3, cfg.rule4, cfg.rule5]
    .map((rule) => (rule ?? '').trim())
    .filter(Boolean);
  const extra = (cfg.extraRules ?? '').split(/[;；\n]+/).map((r) => r.trim()).filter(Boolean);
  return [...slots, ...extra].join('; ');
}

const folder = resolve(process.argv[2] ?? '.');
const configPath = resolve(process.argv[3] ?? join(folder, '..', 'config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8')) as { worlds?: Record<string, CardConfig> };
// 先看这份 World 自己的配置；没有就退回记忆卡的，方便切回时继续用
const rules = rulesOf(config.worlds?.['memory-ledger'] ?? config.worlds?.['memory-card'] ?? {});
if (!rules) {
  console.error(`config.json 里没有 worlds.memory-ledger（或 worlds.memory-card）的规则：${configPath}`);
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
