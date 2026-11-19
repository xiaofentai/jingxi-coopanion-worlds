import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PROMPT_VARS, memoryLedgerText } from '../src/text.ts';

test('心跳：份数 + 覆盖区间 + 今天', () => {
  assert.equal(
    memoryLedgerText('zh').health(6, '2026-11-01', '2026-11-13', '2026-11-13'),
    '记忆 6 份｜覆盖 11-01 ~ 11-13｜今天 11-13',
  );
});

test('心跳：一份都没读到的时候也要能一眼看出不对', () => {
  const line = memoryLedgerText('zh').health(0, null, null, '2026-11-13');
  assert.match(line, /记忆 0 份/);
  assert.match(line, /覆盖 —/);
  assert.match(line, /今天 11-13/);
});

test('每个前缀变量都有说明（ml.hint 由开关控制，不走说明表）', () => {
  for (const language of ['zh', 'en'] as const) {
    const vars = memoryLedgerText(language).envPrompt.vars as Record<string, string>;
    for (const name of PROMPT_VARS) {
      if (name === 'ml.hint') continue;
      assert.ok((vars[name] ?? '').length > 0, `${language} 少了 ${name} 的说明`);
    }
  }
});
