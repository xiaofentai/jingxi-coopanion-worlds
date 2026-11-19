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

/** 会话日志里的一条（只取我们要的三个字段）。 */
export interface LogItem {
  type?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
}

/** 认出的一局：玩什么、我是谁、到哪一步。 */
export interface GameState {
  family: string;
  gameId: string;
  status: string;
  /** 发牌之前是 null。 */
  role: string | null;
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
 * 客厅那一套（`parlor_game_info {op:"state"}`）。
 *
 * 它比星邮还清楚：`table.game` 是游戏名，`tablePrivate.role` 是**英文**身份
 * （`wolf` / `witch` / `seer` / `villager`），和星邮的 `ownRole` 同名，
 * 所以文件头那份映射两边通用。
 *
 * 只在 `status === 'playing'` 时认——打完的桌子还留在列表里，不判这个会一直当成在局中。
 */
function detectParlor(items: readonly LogItem[]): GameState | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'function_call' || item.name !== 'parlor_game_info') continue;
    const args = asObject(item.arguments);
    if (args && typeof args.op === 'string' && args.op !== 'state') continue;
    // 回执紧跟在调用后面
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[j]?.type !== 'function_call_output') continue;
      const state = parseJsonLoose(items[j].output);
      const table = state ? asObject(state.table) : null;
      const mine = state ? asObject(state.tablePrivate) : null;
      if (!table || !mine) break;
      if (String(table.status ?? '') !== 'playing') break;
      const family = typeof table.game === 'string' ? table.game : '';
      const gameId = String(table.tableId ?? table.id ?? '');
      if (!family || !gameId) break;
      const role = typeof mine.role === 'string' ? mine.role : null;
      return { family, gameId, status: String(table.status ?? ''), role };
    }
    break;
  }
  return null;
}

/**
 * 从日志末尾认出当前这一局。
 *
 * 取**最后一局**：一局打完她会再开，旧的不该顶掉新的。身份从这条 gameId 的回执里读，
 * 所以不会把上一局的身份带过来。
 *
 * **按「平台」写，不按游戏**：认星邮的 `starpost_use` 和客厅的 `parlor_game_info`，
 * 至于玩的是哪款（`family`）交给文件头的 `family:` 去配。所以两个平台出新游戏都不用改这里。
 *
 * 再要接第三个平台时，就是在这里加一段——先看一眼它的 `function_call_output`，
 * 别照着猜。两个平台给的身份都是英文（`ownRole` / `role`），所以不需要翻译。
 */
export function detectGame(items: readonly LogItem[]): GameState | null {
  // 客厅的信息更结构化，先试它；两个平台不会同时开局
  const parlor = detectParlor(items);
  if (parlor) return parlor;
  return detectStarpost(items);
}

function detectStarpost(items: readonly LogItem[]): GameState | null {
  let family = '';
  let gameId = '';

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'function_call' || item.name !== 'starpost_use') continue;
    const args = asObject(item.arguments);
    if (!args) continue;
    const inner = asObject(args.argsJson);
    if (!gameId && typeof inner?.gameId === 'string') gameId = inner.gameId;
    if (!family && typeof args.family === 'string') family = args.family;
    if (family && gameId) break;
  }
  if (!family || !gameId) return null;

  let status = '';
  let role: string | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'function_call_output') continue;
    const out = String(item.output ?? '');
    if (!out.includes(gameId)) continue;
    const st = /"status"\s*:\s*"([^"]*)"/.exec(out);
    if (st) status = st[1];
    const rl = /"ownRole"\s*:\s*(null|"([^"]*)")/.exec(out);
    if (rl) role = rl[2] ?? null;
    break;
  }

  return { family, gameId, status, role };
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
  const who = state.role ? `${state.role}${roleName ? ` → ${roleName}` : ''}` : '（还没发牌）';
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
