# 在吗

## 0.1.0

- 新增 World `are-you-there`（显示名「在吗」）：定时查一次屏幕锁没锁，把「ta 现在在不在桌前」作为 `here.state` / `here.lastAway` 两个环境提示变量交给系统前缀。
- 锁定判定用 `Windows` 锁屏时拉起的 `LogonUI.exe`：`tasklist` 一次调用几毫秒，不引原生模块、不联网、不碰用户目录。
- 读数要连续两次一致才算数；`tasklist` 失败或超时只记次数，不改变状态。
- 状态变化推 `are-you-there.changed` 事件（锁屏、解锁各一条，可分别在设置页关掉）；解锁那条附上这次离开了多久。
- 工具 `here_status`：报当前状态、持续时长、上次离开，并当场再查一次锁屏做核对。只读。
- 运行记录写在 `<data>/are-you-there.json`（原子改写），重启后仍知道「这个状态从什么时候开始」。
- 只在 Windows + Coopanion 上验证过；其他平台探针直接回「读不到」，不报错。
- `package.json` 加 npm 的 `os: ["win32"]`，扩展市场据此显示「仅 Windows」并按平台拦安装；`cortico.tags` 定为 `companion`（陪伴），`memory` 之类的既有 id 见官方 `index.json`。
- 文案里指代使用者统一写「ta」（英文用 they），简介改成与记忆卡同一写法的陈述句，全角标点。
