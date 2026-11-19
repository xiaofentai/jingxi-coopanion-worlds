import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MemoryLedgerConfigSection } from '../src/config.ts';
import { clampSettings, readSettings, rulesText, seedSettings, writeSettings } from '../src/settings.ts';

const legacy = (part: Partial<MemoryLedgerConfigSection>) => ({
  rule1: '', rule2: '', rule3: '', rule4: '', rule5: '', extraRules: '', ...part,
} as MemoryLedgerConfigSection);

test('迁移只拿三份 catalog 规则，card 的整份规则不进 ledger', () => {
  const settings = seedSettings(legacy({
    rule1: '常驻.md|whole||2000',
    rule2: '大事记.md|catalog|7|90',
    rule4: '超近期.md|catalog|3|',
    extraRules: '近期.md|catalog|20|; 记忆.md|marker|## 按需|1600',
  }));
  assert.deepEqual(settings.rules, [
    { file: '大事记.md', days: 7, cap: 90 },
    { file: '超近期.md', days: 3, cap: 0 },
    { file: '近期.md', days: 20, cap: 0 },
  ]);
  assert.equal(
    rulesText(settings),
    '大事记.md|catalog|7|90; 超近期.md|catalog|3|; 近期.md|catalog|20|',
  );
});

test('面板保存时文件固定，数值被收进范围', () => {
  const settings = seedSettings(legacy({}));
  const next = clampSettings({
    rules: [
      { file: '别的.md', days: -5, cap: 999999 },
      { file: '别的.md', days: 1.7, cap: 0 },
    ],
  }, settings);
  assert.deepEqual(next.rules[0], { file: '大事记.md', days: 0, cap: 10000 });
  assert.deepEqual(next.rules[1], { file: '超近期.md', days: 2, cap: 0 });
  assert.deepEqual(next.rules[2], settings.rules[2]);
});

test('设置文件能读回；坏了就退回迁移值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-settings-'));
  try {
    const seed = seedSettings(legacy({ rule4: '超近期.md|catalog|6|' }));
    writeSettings(dir, seed);
    assert.deepEqual(readSettings(dir, legacy({})), seed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
