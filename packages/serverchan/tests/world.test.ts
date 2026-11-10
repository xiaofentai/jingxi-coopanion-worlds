import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { SERVERCHAN_DEFAULTS } from '../src/config.ts';
import type { FetchLike } from '../src/send.ts';
import { ServerChanWorld } from '../src/world.ts';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface Captured {
  url: string;
  init: RequestInit;
}

interface Setup {
  sendkey?: string;
  channel?: 'auto' | 'turbo' | 'sc3';
  env?: string;
  language?: string;
  body?: string;
  status?: number;
  now?: number;
}

function setup(opts: Setup = {}) {
  const botDir = mkdtempSync(join(tmpdir(), 'sc-world-'));
  roots.push(botDir);
  const dataDir = join(botDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (opts.env !== undefined) writeFileSync(join(botDir, '.env'), `SERVERCHAN_SENDKEY=${opts.env}\n`);
  if (opts.language !== undefined) writeFileSync(join(botDir, 'config.json'), JSON.stringify({ language: opts.language }));

  const calls: Captured[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(opts.body ?? '{"code":0,"message":""}', { status: opts.status ?? 200 });
  };
  const clock = { at: opts.now ?? Date.parse('2026-11-11T10:00:00Z') };
  const world = new ServerChanWorld({
    cfg: { ...SERVERCHAN_DEFAULTS, enabled: true, sendkey: opts.sendkey ?? '', channel: opts.channel ?? 'auto' },
    timezone: 'Asia/Shanghai',
    botDir,
    dataDir,
    fetcher,
    now: () => clock.at,
  });
  return { world, calls, clock };
}

async function call(world: ServerChanWorld, name: string, args: Record<string, unknown> = {}) {
  const tool = world.tools().find((entry) => entry.name === name);
  assert.ok(tool, `${name} 应该在 tools() 里`);
  const handler = tool.handler;
  assert.ok(handler, `${name} 应该有 handler`);
  const result = await handler(args, {} as never);
  return typeof result === 'string' ? { text: result, failed: false } : { text: result.text, failed: result.failed === true };
}

test('没配 Key：发不出去，回执指向设置页与 .env', async () => {
  const { world, calls } = setup();
  const sent = await call(world, 'sc_send', { title: '标题', text: '正文' });
  assert.equal(sent.failed, true);
  assert.match(sent.text, /SendKey/);
  assert.match(sent.text, /\.env/);
  assert.equal(calls.length, 0);
});

test('Turbo Key：GET 一次，回执说走哪条通道、今天第几条', async () => {
  const { world, calls } = setup({ sendkey: 'SCT12345Tabcdef' });
  const sent = await call(world, 'sc_send', { title: '该出门了', text: '带上伞' });

  assert.equal(sent.failed, false);
  assert.match(sent.text, /已经发到 ta 的手机/);
  assert.match(sent.text, /Server酱 Turbo/);
  assert.match(sent.text, /第 1 条/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.method, 'GET');
  assert.ok(calls[0]!.url.startsWith('https://sctapi.ftqq.com/'));
});

test('Server酱³ Key：POST 到数字子域，标签用竖线连', async () => {
  const { world, calls } = setup({ sendkey: 'sctp12345tabcdef' });
  const sent = await call(world, 'sc_send', { title: '跑完了', text: '回来看一眼', tags: ['工作', '构建'] });

  assert.equal(sent.failed, false);
  assert.match(sent.text, /Server酱³/);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.url, 'https://12345.push.ft07.com/send/sctp12345tabcdef.send');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { title: '跑完了', desp: '回来看一眼', tags: '工作|构建' });
});

test('Turbo 收到标签：照发，但说清标签被省略了', async () => {
  const { world } = setup({ sendkey: 'SCT12345Tabcdef' });
  const sent = await call(world, 'sc_send', { title: '标题', text: '正文', tags: ['工作'] });
  assert.equal(sent.failed, false);
  assert.match(sent.text, /不收标签/);
});

test('60 秒内一模一样的再发会被拒，过了就能再发', async () => {
  const { world, calls, clock } = setup({ sendkey: 'SCT12345Tabcdef' });
  const first = await call(world, 'sc_send', { title: '同一句', text: '同一段' });
  assert.equal(first.failed, false);

  const duplicate = await call(world, 'sc_send', { title: '同一句', text: '同一段' });
  assert.equal(duplicate.failed, true);
  assert.match(duplicate.text, /60 秒/);
  assert.equal(calls.length, 1);

  clock.at += 61_000;
  const later = await call(world, 'sc_send', { title: '同一句', text: '同一段' });
  assert.equal(later.failed, false);
  assert.equal(calls.length, 2);
});

test('被拒收：回执带 code 与原因，状态里留一次失败', async () => {
  const { world } = setup({ sendkey: 'SCT12345Tabcdef', body: '{"code":40001,"message":"bad sendkey"}' });
  const sent = await call(world, 'sc_send', { title: '标题', text: '正文' });
  assert.equal(sent.failed, true);
  assert.match(sent.text, /40001/);
  assert.match(sent.text, /bad sendkey/);

  const status = await call(world, 'sc_status');
  assert.match(status.text, /失败/);
  assert.match(status.text, /今天：0 条/);
});

test('设置留空时读部署目录 .env 的 Key，状态里说明来源', async () => {
  const { world, calls } = setup({ env: 'sctp12345tabcdef' });
  const sent = await call(world, 'sc_send', { title: '标题', text: '正文' });
  assert.equal(sent.failed, false);
  assert.equal(calls[0]!.url, 'https://12345.push.ft07.com/send/sctp12345tabcdef.send');

  const status = await call(world, 'sc_status');
  assert.match(status.text, /\.env/);
  assert.match(status.text, /SERVERCHAN_SENDKEY/);
});

test('状态里 Key 打码，不把整条 Key 写出来', async () => {
  const { world } = setup({ sendkey: 'SCT12345Tabcdef' });
  const status = await call(world, 'sc_status');
  assert.match(status.text, /SCT123…cdef/);
  assert.ok(!status.text.includes('SCT12345Tabcdef'));
});

test('环境提示变量：配好说可用，没配说发不出去', async () => {
  const ready = setup({ sendkey: 'sctp12345tabcdef' });
  const line = ready.world.envPromptVars()['sc.state'] ?? '';
  assert.match(line, /可用/);
  assert.match(line, /Server酱³/);
  assert.match(line, /0 条/);

  const missing = setup();
  assert.match(missing.world.envPromptVars()['sc.state'] ?? '', /还没配/);

  const broken = setup({ sendkey: 'sctpabc' });
  assert.match(broken.world.envPromptVars()['sc.state'] ?? '', /认不出/);
});

test('英文环境说英文', async () => {
  const { world } = setup({ sendkey: 'SCT12345Tabcdef', language: 'en' });
  const sent = await call(world, 'sc_send', { title: 'Dinner', text: 'Come back' });
  assert.match(sent.text, /^Sent to their phone/);

  const status = await call(world, 'sc_status');
  assert.match(status.text, /^Channel:/);
});

test('标题超过 32 字、正文过长都在本地拦下，不发请求', async () => {
  const { world, calls } = setup({ sendkey: 'SCT12345Tabcdef' });
  const long = await call(world, 'sc_send', { title: '一'.repeat(33), text: '正文' });
  assert.equal(long.failed, true);
  assert.match(long.text, /32/);

  const huge = await call(world, 'sc_send', { title: '标题', text: '字'.repeat(32_001) });
  assert.equal(huge.failed, true);
  assert.match(huge.text, /32000/);

  const empty = await call(world, 'sc_send', { title: '   ', text: '正文' });
  assert.equal(empty.failed, true);

  assert.equal(calls.length, 0);
});

test('sctp 开头却没有数字：拒发并说清原因', async () => {
  const { world, calls } = setup({ sendkey: 'sctpabc' });
  const sent = await call(world, 'sc_send', { title: '标题', text: '正文' });
  assert.equal(sent.failed, true);
  assert.match(sent.text, /sctp/);
  assert.equal(calls.length, 0);
});
