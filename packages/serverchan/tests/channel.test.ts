import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { maskKey, parseSendKey, type ParseResult, type Target } from '../src/channel.ts';

function target(key: string, choice: 'auto' | 'turbo' | 'sc3' = 'auto'): Target {
  const parsed: ParseResult = parseSendKey(key, choice);
  assert.equal(parsed.ok, true, `${key} 应该认得出来`);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.target;
}

test('Turbo：sctapi.ftqq.com/<key>.send，没有 /send/ 段', () => {
  const t = target('SCT12345Tabcdef');
  assert.equal(t.channel, 'turbo');
  assert.equal(t.host, 'sctapi.ftqq.com');
  assert.equal(t.url, 'https://sctapi.ftqq.com/SCT12345Tabcdef.send');
  assert.equal(t.uid, null);
});

test('Server酱³：数字子域从 Key 里取，路径多一段 /send/', () => {
  const t = target('sctp12345tabcdef');
  assert.equal(t.channel, 'sc3');
  assert.equal(t.uid, '12345');
  assert.equal(t.host, '12345.push.ft07.com');
  assert.equal(t.url, 'https://12345.push.ft07.com/send/sctp12345tabcdef.send');
});

test('两条通道的地址确实不是同一个写法', () => {
  const turbo = target('SCT12345Tabcdef');
  const sc3 = target('sctp12345tabcdef');
  assert.notEqual(turbo.host, sc3.host);
  assert.ok(turbo.url.includes('sctapi.ftqq.com/'));
  assert.ok(!turbo.url.includes('/send/'));
  assert.ok(sc3.url.includes('/send/'));
  assert.ok(sc3.host.startsWith('12345.'));
});

test('sctp 后面没有数字：认不出 ³ 的地址，不偷偷退回 Turbo 域名', () => {
  const parsed = parseSendKey('sctpabc');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, 'no-uid');
  assert.equal(parsed.sendkey, 'sctpabc');
});

test('空的 Key 回 empty', () => {
  for (const raw of ['', '   ']) {
    const parsed = parseSendKey(raw);
    assert.equal(parsed.ok, false);
    if (parsed.ok) continue;
    assert.equal(parsed.problem, 'empty');
  }
});

test('粘整条 Turbo 推送地址也认', () => {
  const t = target('https://sctapi.ftqq.com/SCT12345Tabcdef.send');
  assert.equal(t.channel, 'turbo');
  assert.equal(t.sendkey, 'SCT12345Tabcdef');
  assert.equal(t.url, 'https://sctapi.ftqq.com/SCT12345Tabcdef.send');
});

test('粘整条 Server酱³ 推送地址：uid 从主机名取', () => {
  const t = target('https://12345.push.ft07.com/send/sctp12345tabcdef.send');
  assert.equal(t.channel, 'sc3');
  assert.equal(t.sendkey, 'sctp12345tabcdef');
  assert.equal(t.uid, '12345');
});

test('认不出的网址回 not-a-url，不会被当成 Key 拼进路径', () => {
  const parsed = parseSendKey('https://sct.ftqq.com/sendkey');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, 'not-a-url');
});

test('手工指定通道时按指定的来', () => {
  const turbo = target('sctp12345tabcdef', 'turbo');
  assert.equal(turbo.channel, 'turbo');
  assert.equal(turbo.url, 'https://sctapi.ftqq.com/sctp12345tabcdef.send');

  const broken = parseSendKey('SCT12345Tabcdef', 'sc3');
  assert.equal(broken.ok, false);
  if (broken.ok) return;
  assert.equal(broken.problem, 'no-uid');
});

test('maskKey 只露头尾', () => {
  assert.equal(maskKey('SCT12345Tabcdef'), 'SCT123…cdef');
  assert.equal(maskKey('abc'), 'ab…');
  assert.equal(maskKey('   '), '');
});
