/**
 * 游戏路由：从会话日志认出「在打什么、我是什么身份」，开局时把对应经验推给她。
 *
 * 为什么走推送而不是前缀：前缀在 session 开始时冻结，局中开局改不了它；而
 * `pushDeferred({trigger:'flush'})` 在轮边界投递，这是唯一能把内容送到「开局现场」的路。
 *
 * 为什么映射写在 `games/*.md` 的文件头、不写在代码里：每出一款新游戏就改一次插件，
 * 这条路走不长。文件头写几行，她自己就能加：
 *
 * ```
 * family: werewolf
 * wolf: 当狼
 * witch: 当女巫
 * ```
 */
import type { Block } from './parse.ts';

/** 会话日志里的一条（只取我们要的字段）。 */
export interface LogItem {
  type?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  /** `context.ts` 带过来；测试里没有就不判新鲜度。 */
  ts?: string;
}

/** 宿主事件库里的一条；客厅开局直接从它认，不依赖工具回执。 */
export interface RouteEvent {
  type?: unknown;
  text?: unknown;
  ts?: unknown;
  origin?: unknown;
  cursor?: unknown;
  meta?: unknown;
}

/**
 * 认局只认「刚发生的一局」：回执比这更旧就不当在局中。
 *
 * 日志是「session carries on」——重启不清空，而路由状态一重启就丢。不设新鲜度，
 * 每次重启都会把昨天那条旧的 `starpost_use` 再当新局推一遍（11-25 推了五次）。
 */
export const GAME_FRESH_MS = 30 * 60 * 1000;

/** 认出的一局：玩什么、我是谁、到哪一步。 */
export interface GameState {
  /** 两个平台的 gameId 可能碰巧一样，去重键要带上它。 */
  platform?: 'starpost' | 'parlor';
  family: string;
  gameId: string;
  status: string;
  /** 发牌之前是 null。 */
  role: string | null;
}

/**
 * 星邮的 `scheduled` 是预约，不是开局：预约成功就推会吃掉「一局一次」的名额，
 * 真开局反而漏掉（11-25 的 f071 就是 12:47 预约、13:08 才开局）。
 * day / night / vote 这些算在局中；ended / closed 这类不算。
 */
function liveStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return !!s && !['scheduled', 'waiting', 'open', 'ended', 'closed', 'finished', 'done', 'cancelled', 'canceled', 'over', 'unknown'].includes(s);
}

/** 有时间戳才判新鲜度：测试里的裸条目不带 ts，不该被这条挡住。 */
function fresh(item: LogItem, now = Date.now()): boolean {
  if (!item.ts) return true;
  const t = Date.parse(item.ts);
  return Number.isFinite(t) && now - t <= GAME_FRESH_MS;
}

function failed(text: string): boolean {
  return /操作失败|未知.*操作|调用失败|\berror\b|\bfailed\b/i.test(text);
}

/**
 * 调用后面的所有回执。中间夹着 reasoning / message 照常跳过；
 * `external_event_frame` / `end_turn` 是宿主插进来的边界，不是她的下一次工具调用——
 * 不能在这里断，否则同一局的开局事件会被切走（11-26 19:10 的 started 就在它后面）。
 */
function receiptsAfter(items: readonly LogItem[], index: number): unknown[] {
  const out: unknown[] = [];
  for (let j = index + 1; j < items.length; j += 1) {
    if (items[j]?.type === 'function_call_output') out.push(items[j].output);
    if (items[j]?.type !== 'function_call') continue;
    const name = items[j]?.name;
    if (name === 'external_event_frame' || name === 'end_turn') continue;
    break;
  }
  return out;
}

/** 调用后面的第一个回执；客厅还按「一个回执」认。 */
function receiptAfter(items: readonly LogItem[], index: number): unknown {
  return receiptsAfter(items, index)[0];
}

/** 从一段可能夹着多条事件的回执里，逐个挑出完整 JSON 对象。 */
function jsonObjects(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'string') return [];
  const out: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (start < 0) {
      if (ch === '{') { start = i; depth = 1; inString = false; escape = false; }
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(value.slice(start, i + 1)) as unknown;
          if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
        } catch {
          // 不是完整 JSON 就跳过，别让一条坏事件把整拍打断
        }
        start = -1;
      }
    }
  }
  return out;
}

/**
 * `game.public kind:"started"` 才是真开局；`rules:{wolf:2,…}` 那一段也会在
 * `starpost_use action:"rules"` 的回执里出现，不能拿它单独当触发。
 *
 * 同一批回执里还有 `game.private kind:"role"`——它带 `role`，所以角色档能直接推，
 * 不用再空等三轮。`game.closed` 如果在开局之后出现，这一局按结束处理。
 */
interface ReceiptGame {
  status: string;
  role: string | null;
}

function gameFromReceipts(raws: readonly unknown[], gameId: string): ReceiptGame | null {
  let status = '';
  let role: string | null = null;
  let ended = false;
  const id = gameId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const closed = new RegExp(`\\[星邮 game\\.closed\\]\\s*\\{[^}]*"gameId"\\s*:\\s*"${id}"`);

  for (const raw of raws) {
    const text = String(raw ?? '');
    if (closed.test(text)) {
      ended = true;
      status = '';
      role = null;
    }

    const out = parseJsonLoose(raw);
    if (out && (typeof out.gameId !== 'string' || out.gameId === gameId)) {
      if (typeof out.status === 'string' && liveStatus(out.status)) {
        status = out.status;
        ended = false;
      }
      if (typeof out.ownRole === 'string') role = out.ownRole;
    }

    for (const event of jsonObjects(raw)) {
      if (event.gameId !== gameId) continue;
      if (event.kind === 'role' && typeof event.role === 'string') {
        role = event.role;
        continue;
      }
      const phase = typeof event.phase === 'string' ? event.phase
        : typeof event.status === 'string' ? event.status : '';
      const started = event.kind === 'started'
        || (typeof event.day === 'number' && event.day >= 1 && !!phase && liveStatus(phase));
      if (started) {
        status = phase && liveStatus(phase) ? phase : 'started';
        ended = false;
      }
    }
  }

  if (ended || !status || !liveStatus(status)) return null;
  return { status, role };
}

/**
 * 客厅在发牌那几秒才会给结构化的 `role`，之前只有人话消息「你的身份：预言家」。
 * 这里只把那几个字抠出来，能不能用交给 `games/*` 的文件头映射决定——映射不上就
 * 明说「文件头没写 X 对应哪一块」，不静默当成没身份。
 */
function roleFromMessages(items: readonly LogItem[], near?: LogItem): string | null {
  const nearMs = near?.ts ? Date.parse(near.ts) : NaN;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (typeof item?.output !== 'string') continue;
    if (Number.isFinite(nearMs) && item.ts) {
      const t = Date.parse(item.ts);
      if (Number.isFinite(t) && Math.abs(t - nearMs) > 15 * 60 * 1000) continue;
    }
    const m = /你的身份[：:]\s*([^\s（(，。、]+)/.exec(item.output);
    if (m) return m[1];
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 从一段文本里抠出 JSON：有些回执带前缀（`[回执] {…}`），有些是纯 JSON。 */
function parseJsonLoose(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 客厅那一套。两种入口都认：
 *
 * - `parlor_game_info {op:"state"}`：`table.game` / `tablePrivate.role` 是结构化身份；
 *   `status` 可能在 `table` 上，也可能只在 `tablePrivate` 上（11-25 的回执就是后者）。
 * - `parlor_game_action`：局中动作只有在 playing 时才成功，回执带 `tableId`。
 *   游戏名从同批 `parlor_game_info` 的 `tables[]` 或最近一次 `parlor_table join` 推。
 *
 * 11-25 的真实一局她没在局中调 `state`，所以只留第二种入口才不会整局漏掉。
 */
function detectParlor(items: readonly LogItem[]): GameState | null {
  // tableId → game：动作回执不给游戏名，只能从 state 的桌列表先建索引。
  const tableGames = new Map<string, string>();
  let joinedGame = '';
  for (const item of items) {
    if (item?.type === 'function_call' && item.name === 'parlor_table') {
      const args = asObject(item.arguments);
      const params = args ? asObject(args.params) : null;
      if (typeof params?.game === 'string') joinedGame = params.game;
    }
    if (item?.type !== 'function_call_output') continue;
    const state = parseJsonLoose(item.output);
    if (!Array.isArray(state?.tables)) continue;
    for (const raw of state.tables) {
      const t = asObject(raw);
      if (!t) continue;
      const id = typeof t.tableId === 'string' ? t.tableId : typeof t.id === 'string' ? t.id : '';
      if (id && typeof t.game === 'string') tableGames.set(id, t.game);
    }
  }

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'function_call') continue;
    const name = item.name;
    if (name !== 'parlor_game_info' && name !== 'parlor_game_action') continue;
    if (!fresh(item)) continue;
    const raw = receiptAfter(items, i);
    if (raw === undefined || failed(String(raw))) continue;
    const state = parseJsonLoose(raw);
    if (!state) continue;

    if (name === 'parlor_game_info') {
      const args = asObject(item.arguments);
      if (args && typeof args.op === 'string' && args.op !== 'state') continue;
      const table = asObject(state.table);
      const mine = asObject(state.tablePrivate);
      // 打完的桌子还留在列表里，status 必须正好是 playing。
      const status = String(table?.status ?? mine?.status ?? '');
      if (status !== 'playing') continue;
      const family = typeof table?.game === 'string' ? table.game
        : typeof mine?.game === 'string' ? mine.game : '';
      const gameId = String(table?.tableId ?? table?.id ?? mine?.tableId ?? '');
      if (!family || !gameId) continue;
      const role = typeof mine?.role === 'string' ? mine.role
        : typeof mine?.roleLabel === 'string' ? mine.roleLabel
        : roleFromMessages(items, item);
      return { platform: 'parlor', family, gameId, status, role };
    }

    // 动作回执：ok + tableId 就是「此刻在局中」；身份仍以 state 的结构化字段为先。
    if (state.ok === false || state.error) continue;
    const gameId = typeof state.tableId === 'string' ? state.tableId : '';
    if (!gameId) continue;
    const family = tableGames.get(gameId) ?? joinedGame;
    if (!family) continue;
    return {
      platform: 'parlor', family, gameId, status: 'playing',
      role: roleFromMessages(items, item),
    };
  }
  return null;
}

/**
 * 从日志末尾认出当前这一局。
 *
 * 取**最后一局**：一局打完她会再开，旧的不该顶掉新的。身份从这条 gameId 的回执里读，
 * 所以不会把上一局的身份带过来。
 *
 * **按「平台」写，不按游戏**：认星邮的 `starpost_use` 和客厅的
 * `parlor_game_info` / `parlor_game_action`；至于玩的是哪款（`family`）交给
 * `games/*` 文件头的 `family:` 去配。所以两个平台出新游戏都不用改这里。
 *
 * 再要接第三个平台时，就是在这里加一段——先看一眼它的 `function_call_output`，
 * 别照着猜。星邮给英文 `ownRole`、客厅给英文 `role` 或中文身份，映射统一走文件头。
 */
export function detectGame(items: readonly LogItem[]): GameState | null {
  // 客厅的信息更结构化，先试它；两个平台不会同时开局
  const parlor = detectParlor(items);
  if (parlor) return parlor;
  return detectStarpost(items);
}

/**
 * 星邮那一套（`starpost_use`）。保留原来的 family / gameId / status / ownRole 结构，
 * 但**必须拿到这一条调用自己的成功回执**：11-25 那次 `join` 回的是「未知狼人杀操作」，
 * 旧代码只看调用就当在局中，于是每次重启都把这条失败记录再推一遍。
 *
 * family 和 gameId 也从同一条调用里取，不跨条拼——日志里有 `family: help` 这种调用，
 * 拼上别的 gameId 会认出根本不存在的局。
 *
 * `scheduled` 只说明占到了座，真开局要从同批回执夹带的 `game.public` / `game.wolf`
 * 事件里认；否则 12:47 的预约会吃掉名额，13:08 真正开局反而没得推。
 */
function detectStarpost(items: readonly LogItem[]): GameState | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'function_call' || item.name !== 'starpost_use') continue;
    if (!fresh(item)) continue;
    const args = asObject(item.arguments);
    if (!args) continue;
    const inner = asObject(args.argsJson);
    const gameId = typeof inner?.gameId === 'string' ? inner.gameId
      : typeof args.gameId === 'string' ? args.gameId : '';
    const family = typeof args.family === 'string' ? args.family
      : typeof inner?.family === 'string' ? inner.family : '';
    if (!gameId || !family || family === 'help') continue;

    const raws = receiptsAfter(items, i);
    if (!raws.length || failed(String(raws[0]))) continue;
    const game = gameFromReceipts(raws, gameId);
    if (!game) continue;
    return { platform: 'starpost', family, gameId, status: game.status, role: game.role };
  }
  return null;
}

/**
 * 客厅的「看身份」消息就是开局：它一定在发牌之后出现，文本里还带着自己的身份。
 *
 * `parlor.started` 只是连接建立，不能当开局；`【…·夜晚】你的身份：…` 会反复出现，
 * 所以只认 `·看身份】` 这一种。客厅消息没有 tableId，先用 cursor 做这一局的 key。
 */
export function detectParlorStart(events: readonly RouteEvent[], now = Date.now()): GameState | null {
  let found: { role: string; at: number; key: string } | null = null;
  let endedAt = 0;
  for (const event of events) {
    if (String(event?.type ?? '') !== 'parlor.message') continue;
    const text = String(event?.text ?? '');
    const at = Date.parse(String(event?.ts ?? ''));
    if (!Number.isFinite(at) || now - at > GAME_FRESH_MS) continue;
    if (text.includes('终局') || text.includes('游戏结束')) {
      endedAt = Math.max(endedAt, at);
      continue;
    }
    const m = /【狼人杀·[^】]*·看身份】[\s\S]*?你的身份[：:]\s*([^\s（(，。、]+)/.exec(text);
    if (!m) continue;
    const key = `parlor:${String(event?.cursor ?? '') || at}`;
    if (!found || at >= found.at) found = { role: m[1], at, key };
  }
  if (!found || found.at <= endedAt) return null;
  return { platform: 'parlor', family: 'werewolf', gameId: found.key, status: 'playing', role: found.role };
}

/** 文件头里那张映射：`family: werewolf` + `wolf: 当狼`。 */
export interface FamilyMap {
  family: string;
  /** 英文身份 → 中文块名。键一律小写。 */
  roles: Record<string, string>;
}

/**
 * 从文件头解析映射。
 *
 * 只认 `键: 值` 形状的行，键是英文标识符——所以「规则速记：6 人局 = …」这种中文说明
 * 不会被误当成映射。
 */
export function parseFamilyMap(front: string): FamilyMap | null {
  let family = '';
  const roles: Record<string, string> = {};
  for (const raw of front.split('\n')) {
    // 键允许中文：星邮给英文 `ownRole: "witch"`，客厅给的是 `女巫`，两边都得能对上。
    // 限定「不含标点、不超过 12 字」，所以「规则速记：6 人局 = …」那种说明句不会被误吃。
    const m = /^([a-zA-Z\u4e00-\u9fa5_]{1,12})\s*[:：]\s*(\S.*)$/.exec(raw.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'family') family = value;
    else roles[key] = value;
  }
  return family ? { family, roles } : null;
}

/** 找一块：先精确、再包含。标题带尾巴（`当狼（11-16 十格）`）也要认出来。 */
export function pickBlock(blocks: readonly Block[], name: string): Block | null {
  const wanted = name.trim();
  if (!wanted) return null;
  return (
    blocks.find((block) => block.title.trim() === wanted) ??
    blocks.find((block) => block.title.includes(wanted)) ??
    null
  );
}

/**
 * 推送是**纯文本**，不渲染 markdown——实测推出去之后 `## 读局` 和 `**加粗**`
 * 原样露在屏幕上，每个星号都是噪音。所以这里把标记剥掉，标题换成【】。
 */
function plain(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '【$1】')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}

/** 一块渲染成注入文本；标题换成【】，正文去掉 markdown 标记。 */
function render(block: Block): string {
  const head = block.heading ? `${block.heading}\n` : '';
  return plain(`${head}${block.body}`.trim());
}

export interface Injection {
  text: string;
  /** 给调用方记账/去重用。 */
  gameId: string;
}

/**
 * 拼一次注入。
 *
 * 三种情况都返回文本，**绝不返回空字符串**：找不到角色块时要把「这份里有什么」说出来，
 * 否则路由失败是静默的——那比不推更糟。
 */
export function buildInjection(
  state: GameState,
  file: string,
  blocks: readonly Block[],
  roleName: string | null,
): Injection {
  const readBlock = pickBlock(blocks, '读局');
  const roleBlock = roleName ? pickBlock(blocks, roleName) : null;
  const who = state.role ? `${state.role}${roleName ? ` → ${roleName}` : ''}` : '（这局拿不到身份，下面给目录你自己挑）';
  const name = file.replace(/^games\//, '').replace(/\.md$/, '');
  const out: string[] = [`你在打${name}（family: ${state.family}），身份：${who}。`];

  if (state.role && roleName && !roleBlock) {
    const names = blocks.map((block) => block.title).join('、');
    out.push(`（这份里没有「${roleName}」这一块，只有：${names}。下面是读局。）`);
  } else if (state.role && !roleName) {
    out.push(`（文件头没写 ${state.role} 对应哪一块，你自己挑。）`);
  }

  if (readBlock) out.push('', render(readBlock));
  if (roleBlock) out.push('', render(roleBlock));

  // **没有角色块时**补一份目录：认不出身份的平台（客厅还没暴露身份字段）就靠这个，
  // 她知道自己是谁，看一眼目录自己 `ml_block(action="view")` 就行了。
  // 有角色块时不给——省一次阅读，也别让目录挤掉正文。
  if (!roleBlock) {
    const others = blocks.filter((block) => block !== readBlock);
    if (others.length) {
      out.push('', '这份文件里还有这些块（要看哪块：`ml_block(action="view", block="…")`）：');
      for (const block of others) {
        const raw = block.entries[0]?.text ?? block.body.split('\n').find((line) => line.trim()) ?? '';
        // **先剥标记再截断**：反过来的话，`**加粗**` 会被切成一半，成对的星号剥不掉，
        // 屏幕上就留一个孤零零的 `**`（实测过）
        out.push(`- ${block.title} · ${block.entries.length} 条 · ${plain(raw).slice(0, 24)}`);
      }
    }
  }

  return { text: plain(out.join('\n').trim()), gameId: state.gameId };
}
