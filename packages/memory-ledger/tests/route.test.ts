/** 游戏路由：认局、认身份、拼注入。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInjection, detectGame, parseFamilyMap, pickBlock } from '../src/route.ts';
import { parseDoc } from '../src/parse.ts';

const call = (gameId: string, family: string) => ({
  type: 'function_call',
  name: 'starpost_use',
  arguments: JSON.stringify({ action: 'read', argsJson: JSON.stringify({ gameId }), family }),
});
const receipt = (gameId: string, status: string, ownRole: string | null) => ({
  type: 'function_call_output',
  output: `[回执] ${JSON.stringify({ gameId, status, ownRole, alive: [], day: 1 })}`,
});

test('从日志认出这一局：family、gameId、身份', () => {
  const game = detectGame([call('g1', 'werewolf'), receipt('g1', 'day', 'wolf')]);
  assert.equal(game?.family, 'werewolf');
  assert.equal(game?.gameId, 'g1');
  assert.equal(game?.role, 'wolf');
});

test('发牌前 ownRole 是 null，不认成身份', () => {
  const game = detectGame([call('g1', 'werewolf'), receipt('g1', 'scheduled', null)]);
  assert.equal(game?.role, null);
});

test('取最后一局：打完一局再开，身份不能串局', () => {
  const game = detectGame([
    call('g1', 'werewolf'),
    receipt('g1', 'day', 'wolf'),
    call('g2', 'werewolf'),
    receipt('g2', 'day', 'seer'),
  ]);
  assert.equal(game?.gameId, 'g2');
  assert.equal(game?.role, 'seer');
});

test('没打过牌就返回 null', () => {
  assert.equal(detectGame([{ type: 'function_call', name: 'read_file', arguments: '{}' }]), null);
});

const parlorState = (game: string, status: string, role: string | null, tableId = 't-1') =>
  JSON.stringify({
    ok: true,
    table: { game, status, tableId, phase: 'night' },
    tablePrivate: { role, seatNo: 1 },
  });

test('客厅：parlor_game_info 的 state 就能认出游戏和身份', () => {
  const game = detectGame([
    { type: 'function_call', name: 'parlor_game_info', arguments: JSON.stringify({ op: 'state' }) },
    { type: 'function_call_output', output: parlorState('werewolf', 'playing', 'wolf') },
  ]);
  assert.equal(game?.family, 'werewolf');
  assert.equal(game?.role, 'wolf');
  assert.equal(game?.gameId, 't-1');
});

test('客厅：局已经结束的不算在局中', () => {
  const game = detectGame([
    { type: 'function_call', name: 'parlor_game_info', arguments: JSON.stringify({ op: 'state' }) },
    { type: 'function_call_output', output: parlorState('werewolf', 'ended', 'wolf') },
  ]);
  assert.equal(game, null);
});

test('客厅和星邮都认：谁的信息在就用谁', () => {
  const items = [
    call('g1', 'werewolf'),
    receipt('g1', 'day', 'seer'),
    { type: 'function_call', name: 'parlor_game_info', arguments: JSON.stringify({ op: 'state' }) },
    { type: 'function_call_output', output: parlorState('werewolf', 'playing', 'witch', 't-9') },
  ];
  const game = detectGame(items);
  assert.equal(game?.gameId, 't-9', '客厅优先（更结构化）');
  assert.equal(game?.role, 'witch');
});

test('文件头的映射：只认英文键，中文说明不误吃', () => {
  const front = [
    '# 狼人杀（星邮）',
    '',
    'family: werewolf',
    'wolf: 当狼',
    'witch: 当女巫',
    '',
    '只记经验，不记整局。规则速记：6 人局 = 2 狼 + 1 预言家 + 3 民',
  ].join('\n');
  const map = parseFamilyMap(front);
  assert.equal(map?.family, 'werewolf');
  assert.equal(map?.roles.wolf, '当狼');
  assert.equal(map?.roles.witch, '当女巫');
  assert.equal(Object.keys(map?.roles ?? {}).length, 2, '中文那行不该进来');
});

test('映射键允许中文：星邮给 witch、客厅给女巫，两边都能对上', () => {
  const front = ['family: werewolf', 'witch: 当女巫', '女巫: 当女巫', '狼人: 当狼'].join('\n');
  const map = parseFamilyMap(front);
  assert.equal(map?.roles.witch, '当女巫');
  assert.equal(map?.roles['女巫'], '当女巫');
  assert.equal(map?.roles['狼人'], '当狼');
});

test('中文说明句不会被当成映射（含标点的不算键）', () => {
  const front = ['family: werewolf', '', '只记经验，不记整局。规则速记：6 人局 = 2 狼'].join('\n');
  const map = parseFamilyMap(front);
  assert.deepEqual(Object.keys(map?.roles ?? {}), []);
});

test('文件头没有 family 就不是可路由的文件', () => {
  assert.equal(parseFamilyMap('# 生态箱\n\n只记经验。地箱…'), null);
});

test('取块：精确优先，标题带尾巴也用包含认出来', () => {
  const doc = parseDoc('## 当狼（11-16 十格）\n- a\n\n## 读局\n- b\n', 'games/狼人杀.md', 2026, '2026-11-16');
  assert.equal(pickBlock(doc.blocks, '当狼')?.title, '当狼（11-16 十格）');
  assert.equal(pickBlock(doc.blocks, '读局')?.title, '读局');
  assert.equal(pickBlock(doc.blocks, '当预'), null);
});

test('注入：读局 + 角色块，两块都给全', () => {
  const doc = parseDoc('## 读局\n- 先看票型。\n\n## 当狼\n- 别编时间戳。\n', 'games/狼人杀.md', 2026, '2026-11-16');
  const out = buildInjection(
    { family: 'werewolf', gameId: 'g1', status: 'day', role: 'wolf' },
    'games/狼人杀.md',
    doc.blocks,
    '当狼',
  );
  assert.match(out.text, /你在打狼人杀（family: werewolf），身份：wolf → 当狼/);
  assert.match(out.text, /【读局】\n- 先看票型。/);
  assert.match(out.text, /【当狼】\n- 别编时间戳。/);
});

test('推送是纯文本：markdown 的 ## 和 ** 要剥掉', () => {
  const doc = parseDoc('## 读局\n- **先看票型。** 别只盯语气。\n', 'games/狼人杀.md', 2026, '2026-11-16');
  const out = buildInjection(
    { family: 'werewolf', gameId: 'g1', status: 'day', role: 'wolf' },
    'games/狼人杀.md',
    doc.blocks,
    '当狼',
  );
  assert.doesNotMatch(out.text, /\*\*/, '加粗标记不该露出来');
  assert.doesNotMatch(out.text, /^## /m, '标题要换成【】');
  assert.match(out.text, /【读局】/);
  assert.match(out.text, /先看票型。/);
});

test('注入：角色块不存在时明说，并把这份有哪些块列出来', () => {
  const doc = parseDoc('## 读局\n- a\n\n## 当民\n- b\n', 'games/狼人杀.md', 2026, '2026-11-16');
  const out = buildInjection(
    { family: 'werewolf', gameId: 'g1', status: 'day', role: 'witch' },
    'games/狼人杀.md',
    doc.blocks,
    '当女巫',
  );
  assert.match(out.text, /没有「当女巫」这一块，只有：读局、当民/);
  assert.match(out.text, /【读局】/);
});

test('认不出身份时：读局 + 一份块目录，让她自己挑', () => {
  const doc = parseDoc('## 读局\n- a\n\n## 当狼\n- b\n\n## 当民\n- c\n', 'games/狼人杀.md', 2026, '2026-11-16');
  const out = buildInjection(
    { family: 'werewolf', gameId: 'p1', status: 'playing', role: null },
    'games/狼人杀.md',
    doc.blocks,
    null,
  );
  assert.match(out.text, /身份：（这局拿不到身份，下面给目录你自己挑）/);
  assert.match(out.text, /还有这些块/);
  assert.match(out.text, /- 当狼 · 1 条 · b/);
  assert.match(out.text, /- 当民 · 1 条 · c/);
  assert.doesNotMatch(out.text, /- 读局 ·/, '读局已经整块给了，目录里不该重复');
});

test('有角色块时不给目录：省一次阅读', () => {
  const doc = parseDoc('## 读局\n- a\n\n## 当狼\n- b\n\n## 当民\n- c\n', 'games/狼人杀.md', 2026, '2026-11-16');
  const out = buildInjection(
    { family: 'werewolf', gameId: 'g1', status: 'day', role: 'wolf' },
    'games/狼人杀.md',
    doc.blocks,
    '当狼',
  );
  assert.doesNotMatch(out.text, /还有这些块/);
  assert.match(out.text, /【当狼】\n- b/);
});

test('注入：文件头没写映射时，把角色名和块清单都摆出来', () => {
  const doc = parseDoc('## 读局\n- a\n\n## 当狼\n- b\n', 'games/狼人杀.md', 2026, '2026-11-16');
  const out = buildInjection(
    { family: 'werewolf', gameId: 'g1', status: 'day', role: 'wolf' },
    'games/狼人杀.md',
    doc.blocks,
    null,
  );
  assert.match(out.text, /文件头没写 wolf 对应哪一块/);
  assert.match(out.text, /- 当狼 · 1 条/);
});
