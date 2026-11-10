# world-serverchan

显示名「Server酱」，一个 Cortico World 扩展：bot 想把一句话送到 ta 的手机上时调用 `sc_send`，经 Server酱 推一条通知。桌宠在这里说的话，人离开电脑就看不到了——这个包补的就是这一段。

两种 SendKey（Server酱 Turbo 与 Server酱³）按 Key 的形状自动分辨，各自的推送地址也各按各的拼法；两种都只填一个 Key，不用选服务。

## 两条通道

| | Turbo | Server酱³ |
|---|---|---|
| SendKey | `SCT` 开头 | `sctp` 开头，形如 `sctp<数字>t<令牌>` |
| 推送地址 | `https://sctapi.ftqq.com/<key>.send` | `https://<数字>.push.ft07.com/send/<key>.send` |
| 请求 | `GET`，`title` / `desp` 放查询串 | `POST` JSON，同一组字段 |
| 标签 | 不收 | 收，多个用竖线连 |

³ 的地址里那个数字子域不在配置里，是从 Key 中间取出来的（`sctp1234t…` → `1234.push.ft07.com`）。取不到就报错，不会退回 Turbo 的域名硬发——那样一定失败。设置页留空时读部署目录 `.env` 的 `SERVERCHAN_SENDKEY`。

## 配置（`worlds.serverchan.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 装完要显式打开 |
| `sendkey` | 空 | Server酱 后台的 SendKey；粘整条推送地址也认 |
| `channel` | `auto` | `auto` / `turbo` / `sc3`。只有自动判断错了才手动指定 |

密钥存在设置页（`config.json`）里，或者放在部署目录的 `.env`：

```
SERVERCHAN_SENDKEY=sctp1234txxxxxxxx
```

## 工具

`sc_send`：把一句话推到手机上。

| 参数 | 说明 |
|---|---|
| `title` | 必填，32 字以内，是通知里露出来的那一行 |
| `text` | 正文，Markdown；正文过长（32000 字以上）会被拒 |
| `tags` | Server酱³ 用；Turbo 的 Key 会忽略，并在回执里说明 |

`sc_status`：报当前走哪条通道（Key 打码）、能不能发、今天成功发了几条、上一次的结果。只读，不发东西。

## 环境提示变量

| 变量 | 内容 |
|---|---|
| `sc.state` | 能不能推送、走哪条通道、今天已发几条，如 `Server酱：可用，走 Server酱³，今天已发 2 条。` |

模板在控制台「提示词」页的 `worlds.serverchan.envPrompt` 里改。

## 几件写在行为里的事

- **60 秒内同样的标题和正文不再发**：模型很容易为了"确认自己在线"重复调用，重复的那次会被拒，并说清原因。
- **标题超 32 字、正文过长在本地拦下**，不浪费一次请求，也不占额度。
- **成功只代表 Server酱 收下了**，不代表 ta 已经看到。
- **额度**：免费额度与限频以 Server酱 官网为准；`sc_status` 里的「今天 N 条」只是本地记下的成功次数，不假装知道服务端还剩多少。
- 回执里不出现完整的 SendKey，也不出现推送地址——地址的路径里就带着 Key。

## 安装

在扩展页「手动安装 → 从 npm」里填 `world-serverchan`，装完重启进程，再到设置页填 SendKey 或写进 `.env`。

## 许可

AGPL-3.0-or-later，见随包发出的 `LICENSE`。
