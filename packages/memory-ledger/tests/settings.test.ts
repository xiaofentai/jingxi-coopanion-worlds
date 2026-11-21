import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MemoryLedgerConfigSection } from '../src/config.ts';
import {
  archiveFileOf, clampSettings, fillArchiveTemplate, pastFileOf,
  readSettings, rulesText, seedSettings, todayFileOf, writeSettings,
} from '../src/settings.ts';

const cfg = (part: Partial<MemoryLedgerConfigSection> = {}) => ({
  folder: 'workspace',
  todayFile: '超近期.md',
  pastFile: '近期.md',
  archiveFile: 'archive/大事记-归档.md',
  recallOnSpeak: false,
  preactivate: false,
  preactivatePerDay: 6,
  gameRoute: false,
  rule1: '', rule2: '', rule3: '', rule4: '', rule5: '', extraRules: '',
  listOthers: false, listMax: 12, exclude: '',
  ...part,
} as MemoryLedgerConfigSection);

test('迁移按大事记 / 近期 / 超近期三张卡，带出文件槽和归档模板', () => {
  const settings = seedSettings(cfg({
    folder: '记忆目录',
    todayFile: '当天.md',
    preactivate: true,
    preactivatePerDay: 3,
    rule1: '常驻.md|whole||2000',
    rule2: '大事记.md|catalog|7|90',
    rule4: '超近期.md|catalog|6|',
    extraRules: '近期.md|catalog|20|; 记忆.md|marker|## 按需|1600',
  }));
  assert.equal(settings.folder, '记忆目录');
  assert.equal(settings.preactivate, true);
  assert.equal(settings.preactivatePerDay, 3);
  assert.deepEqual(settings.rules.map((rule) => rule.file), ['大事记.md', '近期.md', '当天.md']);
  assert.deepEqual(settings.rules.map((rule) => rule.days), [7, 20, 6]);
  assert.equal(settings.rules[0]!.archive, 'archive/大事记-归档.md');
  assert.equal(settings.rules[1]!.archive, 'archive/近期-{{YYYY-MM}}.md');
  assert.equal(settings.rules[2]!.archive, '');
  assert.equal(todayFileOf(settings), '当天.md');
  assert.equal(pastFileOf(settings), '近期.md');
  assert.equal(archiveFileOf(settings), 'archive/大事记-归档.md');
  assert.equal(
    rulesText(settings),
    '大事记.md|catalog|7|90; 近期.md|catalog|20|; 当天.md|catalog|6|',
  );
});

test('面板保存时文件名、天数与归档目标都可改，数值被收进范围', () => {
  const settings = seedSettings(cfg());
  const next = clampSettings({
    folder: '另一处',
    preactivatePerDay: 999,
    gameRoute: true,
    rules: [
      { file: '里程碑.md', days: -5, cap: 999999, archive: 'archive/里程碑.md' },
      { file: '旧流水.md', days: 1.7, cap: 0, archive: 'archive/旧流水-{{YYYY-MM}}.md' },
      { file: '新流水.md', days: 3, cap: 0, archive: '' },
    ],
  }, settings);
  assert.equal(next.folder, '另一处');
  assert.equal(next.preactivatePerDay, 20);
  assert.equal(next.gameRoute, true);
  assert.deepEqual(next.rules[0], { file: '里程碑.md', days: 0, cap: 10000, archive: 'archive/里程碑.md' });
  assert.deepEqual(next.rules[1], { file: '旧流水.md', days: 2, cap: 0, archive: 'archive/旧流水-{{YYYY-MM}}.md' });
  assert.deepEqual(next.rules[2], { file: '新流水.md', days: 3, cap: 0, archive: '' });
});

test('归档文件名按日期展开替代符', () => {
  const template = 'archive/近期-{{YYYY-MM}}.md/{{YYYY}}/{{MM}}/{{YYYY-MM-DD}}';
  assert.equal(
    fillArchiveTemplate(template, '2026-11-19'),
    'archive/近期-2026-11.md/2026/11/2026-11-19',
  );
});

test('设置写回 config.json 的自己那段，enabled 和其他 World 一个字不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-settings-'));
  try {
    const original = {
      language: 'zh',
      worlds: {
        'memory-ledger': { enabled: true, rule4: '超近期.md|catalog|4|' },
        'are-you-there': { enabled: true, interval: 30 },
      },
    };
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(original)}\n`, 'utf8');
    const seed = seedSettings(cfg({ rule4: '超近期.md|catalog|6|' }));
    const next = { ...seed, preactivatePerDay: 9 };
    writeSettings(dir, next);
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as typeof original;
    assert.equal(raw.language, 'zh');
    assert.equal(raw.worlds['are-you-there']!.enabled, true);
    assert.equal(raw.worlds['memory-ledger']!.enabled, true);
    assert.equal(raw.worlds['memory-ledger']!.rule4, '超近期.md|catalog|4|');
    assert.deepEqual(readSettings(dir, cfg()).preactivatePerDay, 9);
    assert.deepEqual(readSettings(dir, cfg()).rules, next.rules);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读不到设置段时退回迁移值；段坏了也不让 World 起不来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-settings-'));
  try {
    const seed = seedSettings(cfg({ rule4: '超近期.md|catalog|6|' }));
    // 没有 config.json
    assert.deepEqual(readSettings(dir, cfg({ rule4: '超近期.md|catalog|6|' })), seed);
    // 有 config.json 但没有自己的段
    writeFileSync(join(dir, 'config.json'), '{"worlds":{"other":{"enabled":true}}}', 'utf8');
    assert.deepEqual(readSettings(dir, cfg({ rule4: '超近期.md|catalog|6|' })), seed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
