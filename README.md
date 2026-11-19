# 鲸汐的 World

给 Coopanion 写的 World 扩展，每个包独立发布到 npm。

| 包 | 目录 | 用途 |
|---|---|---|
| [`world-memory-card`](https://www.npmjs.com/package/world-memory-card) | [`packages/memory-card`](packages/memory-card) | 把目录里的 Markdown 裁成一页卡，每次交接放进系统前缀 |
| [`coopanion-world-memory-backup`](https://www.npmjs.com/package/coopanion-world-memory-backup) | [`packages/memory-backup`](packages/memory-backup) | 到点提醒整理记忆，整理完备份数据目录，之后可按任意一份回滚 |
| [`world-are-you-there`](https://www.npmjs.com/package/world-are-you-there) | [`packages/are-you-there`](packages/are-you-there) | 轮询屏幕锁没锁，把「人现在在不在桌前」写进环境提示 |
| [`world-serverchan`](https://www.npmjs.com/package/world-serverchan) | [`packages/serverchan`](packages/serverchan) | 填一个 Server酱 SendKey，让 bot 把一句话推到 ta 的手机上 |
| [`world-cache-keepalive`](https://www.npmjs.com/package/world-cache-keepalive) | [`packages/cache-keepalive`](packages/cache-keepalive) | 空档变长前补一条不要求回应的内部事件，让上游的前缀缓存不过期；一次缓存失效约合三千拍心跳 |

## 安装

在 Coopanion 的扩展页「手动安装 → 从 npm」里填包名，装完重启进程。配置项与用法见各包自己的 README。

## 开发

每个包是独立的 npm 包，各带 `package.json`、`tsconfig.json` 与测试：

```bash
cd packages/memory-card
pnpm install
pnpm test
pnpm typecheck
```

需要 Node 22 以上。`src/` 里就是运行时真正加载的源码，没有构建步骤。

### 改界面（`webui.js` / `webui.css`）之后

开发时用 `link:` 把包指到仓库里，改完代码**要把该包 `package.json` 的 `version` 加一，再重启宿主**，否则改动看不见。

面板产物的地址是 `/assets/extensions/<包>/<版本>/webui.js|webui.css`，版本段对扩展包来说只有包版本号；宿主按 `max-age=31536000, immutable` 发这两份文件，版本不变 URL 就不变，浏览器会一直用第一次拿到的旧副本——改了样式却「没生效」，多半是这一条。宿主自带的 World 走 `core/bundled-panels.ts`，版本后面还拼一段内容 hash；`link:` 装进来的扩展没有，只能靠改版本号。

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。每个包目录下也各有一份，随 npm 包一起发布。
