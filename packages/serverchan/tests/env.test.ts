import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dotEnvValue, readLanguage } from '../src/env.ts';

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sc-env-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('.env 的几种写法都认', () => {
  withDir((dir) => {
    const file = join(dir, '.env');
    writeFileSync(file, [
      '# 注释',
      'OTHER=1',
      'export SERVERCHAN_SENDKEY=SCT12345Tabcdef',
      'SECOND="sctp12345tabcdef"',
      'THIRD=\'quoted\' # 行尾注释',
      'FOURTH=bare # 行尾注释',
      '',
    ].join('\r\n'));

    assert.equal(dotEnvValue(file, 'SERVERCHAN_SENDKEY'), 'SCT12345Tabcdef');
    assert.equal(dotEnvValue(file, 'SECOND'), 'sctp12345tabcdef');
    assert.equal(dotEnvValue(file, 'THIRD'), 'quoted');
    assert.equal(dotEnvValue(file, 'FOURTH'), 'bare');
    assert.equal(dotEnvValue(file, 'MISSING'), '');
  });
});

test('没有 .env 就回空串，不抛', () => {
  withDir((dir) => {
    assert.equal(dotEnvValue(join(dir, '.env'), 'SERVERCHAN_SENDKEY'), '');
  });
});

test('语言读 config.json；读不到当中文，别的语言读英文', () => {
  withDir((dir) => {
    assert.equal(readLanguage(dir), 'zh');

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en' }));
    assert.equal(readLanguage(dir), 'en');

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'ja' }));
    assert.equal(readLanguage(dir), 'ja');

    writeFileSync(join(dir, 'config.json'), '{ 坏 json');
    assert.equal(readLanguage(dir), 'zh');
  });
});
