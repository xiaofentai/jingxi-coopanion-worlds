import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSendKey, type Target } from '../src/channel.ts';
import { pushTo, type FetchLike } from '../src/send.ts';

interface Captured {
  url: string;
  init: RequestInit;
}

function turboTarget(): Target {
  const parsed = parseSendKey('SCT12345Tabcdef');
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.target;
}

function sc3Target(): Target {
  const parsed = parseSendKey('sctp12345tabcdef');
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.target;
}

function recorder(body = '{"code":0,"message":"","data":{}}', status = 200): { fetcher: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status });
  };
  return { fetcher, calls };
}

test('Turbo 走 GET + query，Key 在路径里、标题与正文在查询串里', async () => {
  const { fetcher, calls } = recorder();
  const outcome = await pushTo(turboTarget(), { title: '该出门了', desp: '**带上伞**' }, fetcher);

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.body, undefined);
  const url = new URL(call.url);
  assert.equal(url.origin, 'https://sctapi.ftqq.com');
  assert.equal(url.pathname, '/SCT12345Tabcdef.send');
  assert.equal(url.searchParams.get('title'), '该出门了');
  assert.equal(url.searchParams.get('desp'), '**带上伞**');
});

test('Server酱³ 走 POST + JSON，地址里有 /send/', async () => {
  const { fetcher, calls } = recorder();
  const outcome = await pushTo(sc3Target(), { title: '日志跑完了', desp: '回来看一眼', tags: ['工作', '构建'] }, fetcher);

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url, 'https://12345.push.ft07.com/send/sctp12345tabcdef.send');
  const headers = call.init.headers as Record<string, string>;
  assert.match(headers['content-type']!, /application\/json/);
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    title: '日志跑完了',
    desp: '回来看一眼',
    tags: '工作|构建',
  });
});

test('Server酱³ 不带标签时 body 里没有 tags 这个键', async () => {
  const { fetcher, calls } = recorder();
  await pushTo(sc3Target(), { title: '在吗', desp: '' }, fetcher);
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal('tags' in body, false);
});

test('Turbo 收到 tags 就报「被忽略」，请求里不会带', async () => {
  const { fetcher, calls } = recorder();
  const outcome = await pushTo(turboTarget(), { title: '标题', desp: '正文', tags: ['工作'] }, fetcher);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ignored, ['tags']);
  assert.ok(!calls[0]!.url.includes('tags='));
});

test('code 不为 0 算被拒收，带上服务端的原因', async () => {
  const { fetcher } = recorder('{"code":40001,"message":"bad sendkey"}');
  const outcome = await pushTo(turboTarget(), { title: '标题', desp: '' }, fetcher);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.code, 40001);
  assert.equal(outcome.message, 'bad sendkey');
  assert.equal(outcome.status, 200);
});

test('HTTP 500 单独算一类', async () => {
  const { fetcher } = recorder('{"code":0,"message":""}', 500);
  const outcome = await pushTo(turboTarget(), { title: '标题', desp: '' }, fetcher);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, 'http');
  assert.equal(outcome.status, 500);
});

test('返回不是 JSON 时留一小段原文', async () => {
  const { fetcher } = recorder('<html>gateway</html>', 200);
  const outcome = await pushTo(turboTarget(), { title: '标题', desp: '' }, fetcher);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, 'not-json');
  assert.ok(outcome.message.includes('gateway'));
});

test('连不上与超时分开报', async () => {
  const offline: FetchLike = async () => {
    throw new Error('getaddrinfo ENOTFOUND sctapi.ftqq.com');
  };
  const a = await pushTo(turboTarget(), { title: '标题', desp: '' }, offline);
  assert.equal(a.ok, false);
  if (!a.ok) {
    assert.equal(a.kind, 'network');
    assert.ok(a.message.includes('ENOTFOUND'));
  }

  const slow: FetchLike = async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };
  const b = await pushTo(turboTarget(), { title: '标题', desp: '' }, slow);
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.kind, 'timeout');
});

test('结果里不出现 Key，免得回执把它带进对话', async () => {
  const { fetcher } = recorder();
  const outcome = await pushTo(turboTarget(), { title: '标题', desp: '' }, fetcher);
  const dump = JSON.stringify(outcome);
  assert.ok(!dump.includes('SCT12345Tabcdef'));
  assert.ok(!dump.includes('sctapi.ftqq.com'));
});
