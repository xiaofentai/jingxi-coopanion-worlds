# world-memory-card

本 README 对应 `src/index.ts` 导出的 World（`cortico.api = 6`，id `memory-card`）。

把一个目录里的 Markdown 按规则裁成一张卡，作为环境提示变量放进系统前缀。卡在每次交接重建前缀时重新生成，所以每个 session 开头看到的，都是那一刻磁盘上的样子。

写它的原因：文件里的要求常被跳过。把要它记住的部分放进前缀，比再写一条提醒可靠。

- **只读**：不改、不搬、不新建你目录里的文件，也不写盘。
- **不做模型调用**：纯字符串处理，毫秒级，没有 key，不联网。
- **只多三个变量**：`mc.meta` / `mc.card` / `mc.index`，没有工具、没有定时器。

## 它不做什么

- 不在 session 中途刷新。前缀在一个 session 里是固定的，文件改了要等下一次交接，或在控制台点「立即应用」。
- 不判断内容重要性。留哪一段由规则和字数上限决定，不由模型决定。
- 不删除、不压缩你自己的文件。去重和改写是你自己的事。

## 配置（`worlds.memory-card.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 装完要显式打开 |
| `folder` | `workspace` | 目录，绝对路径或相对部署目录 |
| `rule1`…`rule5` | 空 | 一条规则一项，`路径\|模式\|参数\|字数上限` |
| `extraRules` | 空 | 五个槽不够时写这里，分号分隔 |
| `totalChars` | `6000` | 整张卡的上限，超了从最后一条规则整份丢 |
| `listOthers` | `true` | 没进规则的 `.md` 只列路径与首行 |
| `listMax` | `12` | 最多列几个 |
| `exclude` | `.git,node_modules,archive,handoffs,blobs` | 跳过的目录或文件名，逗号分隔 |

设置页的输入框是单行的，所以一条规则占一项，不要把它们挤在一格里。

### 规则

```
规则 1  偏好与习惯.md|marker|## 按需|1500
规则 2  记忆.md|whole||1500
规则 3  留空
规则 4  留空
规则 5  留空
```

顺序就是优先级：总上限不够时，从最后一条开始整份丢。

| 模式 | 参数 | 取什么 |
|---|---|---|
| `whole` | 留空（两个竖线） | 整份，超上限截尾；上限留空则不单独限制 |
| `marker` | 标题，如 `## 按需` | 从开头到该标题之前；找不到就整份载入并注明 |
| `newest` | 块数 | 按 `## ` 分块，取标题里日期最新的几块，保持文件里的先后 |
| `newest+pin` | `块数,标题` | 同 `newest`，再固定带上标题含该词的块（如 `1,待办`） |

日期从块标题里认：`## 11-05`、`## 2026-11` 都行。没有日期的块不会被 `newest` 选中；文件里出现过哪一年，就用那一年补全 `MM-DD`。

路径相对 `folder`，不能是绝对路径，也不能用 `..` 跳出去。

### 卡片长什么样

```
### 记忆.md（11-07 11:16）

# 记忆

## 名字
...
（已截断：还有 940 字未载入，用 read_file 查看 记忆.md。）

### 未载入的文件

- 另一个文件.md：它自己的首行

问到相关的事，先打开对应文件再答。
```

### 模板

`src/ENV_PROMPT.md` 与 `ENV_PROMPT.en.md` 是默认模板。装好后可以在控制台「提示词」页的 `worlds.memory-card.envPrompt` 里改，保存的版本会盖过包里的。

| 变量 | 内容 |
|---|---|
| `mc.meta` | 读取几份、多少字、生成时间 |
| `mc.card` | 正文，每段带文件名与修改时间 |
| `mc.index` | 未载入文件的清单 |

正文里那三个占位符是模板的一部分，删了对应内容就不会出现在前缀里。

## 安装

在扩展页「手动安装 → 从 npm」里填 `world-memory-card`，装完重启进程。

开发时也可以从本机目录安装，或先打包再装：

```bash
cd packages/world-memory-card
corepack pnpm pack --pack-destination ../../build
corepack pnpm add ../../build/world-memory-card-0.1.2.tgz
```

本地目录是链接安装，源码目录移动后链接会断。

装完重启 Core，在 World 总览打开「记忆卡」，回提示词页填配置。配置改完不需要重启，点「立即应用」或等下一次交接即可。

## 测试

`src/card.ts` 只依赖 node 内置模块，可以脱离框架跑：

```bash
cd packages/world-memory-card
corepack pnpm vitest run
```

`src/world.ts` 依赖 `cortico/*` 的类型与 `isLanguage`，要跑类型检查得先 `git submodule update --init` 并安装依赖。

## 发布

```bash
cd packages/world-memory-card
corepack pnpm pack --pack-destination ../../build
npm publish ../../build/world-memory-card-<version>.tgz
```

发完在 `Pal-AI-Lab/cortico-extensions` 开一条 `[sync] world-memory-card`，扩展页的搜索与索引才会认到它。

- 许可证是 AGPL-3.0-or-later，`LICENSE` 随包发出。
- 扩展页里的工具/事件说明来自 `describe.json`；本世界没有工具和事件，因此不带。
- 文案只有中文与英文两套，其余语言读英文模板。
