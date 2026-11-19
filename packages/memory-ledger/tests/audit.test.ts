import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { audit, insideFolder, readRuleDocs } from '../src/audit.ts';
import { parseRules } from '../src/board.ts';

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ml-audit-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  return dir;
}

test('月块进 catalog 也不查首行：它没有「这个月的一句话」', () => {
  const long = '很长的一条'.repeat(20);
  const dir = folder({ '大事记.md': `## 2026-11\n- ${long}\n- 乙\n` });
  const report = audit(dir, '大事记.md|catalog|3650|80', '2026-11-13', 2026, '');
  const aboutFirst = report.tidy.filter((item) => item.reason.includes('首行'));
  assert.equal(aboutFirst.length, 0, JSON.stringify(aboutFirst));
});

test('日块的首行照样查：超长要报', () => {
  const long = '很长的一句话'.repeat(12);
  const dir = folder({ '超近期.md': `## 11-13\n- ${long}\n- 乙\n` });
  const report = audit(dir, '超近期.md|catalog|4|', '2026-11-13', 2026, '');
  assert.ok(report.tidy.some((item) => item.reason.includes('首行') && item.reason.includes('超过')));
});

test('到期按块数算：4 块刚好不报，第 5 块进来自动报最旧那块', () => {
  const four = ['11-11', '11-12', '11-13', '11-14'].map((day) => `## ${day}\n- x`).join('\n\n');
  const five = `## 11-10\n- w\n\n${four}`;
  const dirA = folder({ '超近期.md': four });
  assert.equal(audit(dirA, '超近期.md|catalog|4|', '2026-11-15', 2026, '').overdue.length, 0, '4 块=容量满，不催');

  const dirB = folder({ '超近期.md': five });
  const report = audit(dirB, '超近期.md|catalog|4|', '2026-11-15', 2026, '');
  assert.equal(report.overdue.length, 1);
  assert.equal(report.overdue[0].handle, '2026-11-10');
  assert.equal(report.overdue[0].days, 6);
  assert.equal(report.overdue[0].window, 4);
});

test('月块的条目上限照样报：不查首行不等于不管', () => {
  const dir = folder({ '大事记.md': '## 2026-11\n- 甲\n- 乙\n- 丙\n' });
  const report = audit(dir, '大事记.md|catalog|3650|2', '2026-11-13', 2026, '');
  assert.ok(report.tidy.some((item) => item.reason.includes('3/2 条')));
});

test('分区抽查：三段各取头尾，共 6 条，不重复', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `- **10-${String(i + 1).padStart(2, '0')}**：第 ${i + 1} 件事。`);
  const dir = folder({ '大事记.md': `# 大事记\n\n## 2026-10\n${rows.join('\n')}\n` });
  const report = audit(dir, '大事记.md|full||80', '2026-11-13', 2026, '');
  const lines = report.samples[0].lines;
  assert.equal(lines.length, 6);
  assert.equal(new Set(lines).size, 6);
  assert.match(lines[0], /10-01/);
  assert.match(lines.at(-1), /10-30/);
});


