# 鲸汐的 World

给 Coopanion 写的 World 扩展，每个包独立发布到 npm。

| 包 | 目录 | 用途 |
|---|---|---|
| [`world-memory-card`](https://www.npmjs.com/package/world-memory-card) | [`packages/memory-card`](packages/memory-card) | 把目录里的 Markdown 裁成一页卡，每次交接放进系统前缀 |
| [`coopanion-world-memory-backup`](https://www.npmjs.com/package/coopanion-world-memory-backup) | [`packages/memory-backup`](packages/memory-backup) | 到点提醒整理记忆，整理完备份数据目录，之后可按任意一份回滚 |

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

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。每个包目录下也各有一份，随 npm 包一起发布。
