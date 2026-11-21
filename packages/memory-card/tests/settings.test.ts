import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRules } from '../src/card.ts';
import { MEMORY_CARD_DEFAULTS, type MemoryCardConfigSection } from '../src/config.ts';
import {
  CARD_SETTINGS_FILE, clampSettings, readSettings, rulesText, seedSettings, writeSettings,
  type CardSettings,
} from '../src/settings.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-card-settings-'));
  dirs.push(dir);
  return dir;
}

function cfg(patch: Partial<MemoryCardConfigSection> = {}): MemoryCardConfigSection {
  return { ...MEMORY_CARD_DEFAULTS, ...patch };
}

describe('seeding', () => {
  it('migrates the legacy slots and keeps five of them', () => {
    const seeded = seedSettings(cfg());
    expect(seeded.rules).toHaveLength(5);
    expect(seeded.rules[0]).toEqual({ file: '常驻.md', mode: 'whole', arg: '', maxChars: 2000, cut: 'tail' });
    expect(seeded.rules[2]).toEqual({
      file: '记忆.md', mode: 'marker+outline', arg: '## 按需', maxChars: 1600, cut: 'tail',
    });
    expect(seeded.rules[3]!.file).toBe('');
  });

  it('takes the global settings from the old config', () => {
    const seeded = seedSettings(cfg({ folder: 'notes', totalChars: 4000, listMax: 3, exclude: '' }));
    expect(seeded.folder).toBe('notes');
    expect(seeded.totalChars).toBe(4000);
    expect(seeded.listMax).toBe(3);
    expect(seeded.exclude).toBe('');
  });

  it('drops only the slot whose mode the card cannot do, without shifting the rest', () => {
    const seeded = seedSettings(cfg({
      rule1: 'A.md|whole||100',
      rule2: 'B.md|catalog|30|80',
      rule3: 'C.md|marker|## 按需|900',
      rule4: '',
      rule5: '',
      extraRules: 'D.md|newest|2|300',
    }));
    expect(seeded.rules.map((rule) => rule.file)).toEqual(['A.md', 'C.md', 'D.md', '', '']);
  });
});

describe('the rule text', () => {
  it('writes only the rules that name a file, and parses back cleanly', () => {
    const text = rulesText(seedSettings(cfg()));
    expect(text).toBe(
      '常驻.md|whole||2000|tail; partner/偏好与习惯.md|whole||2000|tail; 记忆.md|marker+outline|## 按需|1600|tail',
    );
    const { rules, errors } = parseRules(text);
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(3);
  });

  it('leaves a rule out when its file is cleared', () => {
    const settings = seedSettings(cfg());
    settings.rules[1]!.file = '';
    expect(rulesText(settings)).not.toContain('偏好与习惯');
  });
});

describe('clamping what the panel sends', () => {
  it('keeps the old value when a field is missing and clamps what is out of range', () => {
    const base = seedSettings(cfg());
    const next = clampSettings({
      folder: '   ',
      totalChars: -5,
      listOthers: 'yes',
      listMax: 999,
      exclude: '',
      rules: [{ file: ' X.md ', mode: 'nope', arg: ' ## 按需 ', maxChars: -1, cut: 'middle' }],
    } as unknown as Partial<CardSettings>, base);
    expect(next.folder).toBe(base.folder);
    expect(next.totalChars).toBe(0);
    expect(next.listOthers).toBe(base.listOthers);
    expect(next.listMax).toBe(100);
    expect(next.exclude).toBe('');
    expect(next.rules[0]).toEqual({
      file: 'X.md', mode: 'whole', arg: '## 按需', maxChars: 0, cut: 'tail',
    });
    expect(next.rules).toHaveLength(5);
  });
});

describe('the settings file', () => {
  it('falls back to the seed when nothing is stored', () => {
    const dir = temp();
    expect(readSettings(dir, dir, cfg()).rules[0]!.file).toBe('常驻.md');
  });

  it('round-trips what was written into config.json', () => {
    const dir = temp();
    const settings = seedSettings(cfg());
    settings.rules[0]!.file = 'A.md';
    writeSettings(dir, settings);
    expect(existsSync(join(dir, CARD_SETTINGS_FILE))).toBe(false);
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      worlds: { 'memory-card': { settings: CardSettings; enabled?: boolean } };
    };
    expect(raw.worlds['memory-card'].settings.rules[0]!.file).toBe('A.md');
    expect(readSettings(dir, dir, cfg()).rules[0]!.file).toBe('A.md');
  });

  it('falls back to the seed when the stored section is not valid', () => {
    const dir = temp();
    writeFileSync(join(dir, 'config.json'), '{"worlds":{"memory-card":{"settings":"bad"}}}', 'utf8');
    expect(readSettings(dir, dir, cfg()).rules[2]!.mode).toBe('marker+outline');
  });

  it('migrates the legacy small file, deletes it, and keeps other config keys', () => {
    const data = temp();
    const bot = temp();
    const legacy = seedSettings(cfg());
    legacy.rules[0]!.file = 'Migrated.md';
    legacy.totalChars = 7000;
    writeFileSync(join(data, CARD_SETTINGS_FILE), JSON.stringify(legacy), 'utf8');
    writeFileSync(join(bot, 'config.json'), JSON.stringify({
      language: 'zh',
      worlds: { 'memory-card': { enabled: true }, 'are-you-there': { enabled: true } },
    }), 'utf8');

    const got = readSettings(bot, data, cfg());
    expect(got.rules[0]!.file).toBe('Migrated.md');
    expect(got.totalChars).toBe(7000);
    expect(existsSync(join(data, CARD_SETTINGS_FILE))).toBe(false);
    const raw = JSON.parse(readFileSync(join(bot, 'config.json'), 'utf8')) as {
      language: string;
      worlds: Record<string, Record<string, unknown>>;
    };
    expect(raw.language).toBe('zh');
    expect(raw.worlds['memory-card']!.enabled).toBe(true);
    expect(raw.worlds['are-you-there']!.enabled).toBe(true);
    expect((raw.worlds['memory-card']!.settings as CardSettings).rules[0]!.file).toBe('Migrated.md');
  });

  it('does not re-read the legacy file once config.json has its own section', () => {
    const data = temp();
    const bot = temp();
    const legacy = seedSettings(cfg());
    legacy.rules[0]!.file = 'Legacy.md';
    writeFileSync(join(data, CARD_SETTINGS_FILE), JSON.stringify(legacy), 'utf8');
    const current = seedSettings(cfg());
    current.rules[0]!.file = 'Current.md';
    writeSettings(bot, current);

    expect(readSettings(bot, data, cfg()).rules[0]!.file).toBe('Current.md');
  });
});
