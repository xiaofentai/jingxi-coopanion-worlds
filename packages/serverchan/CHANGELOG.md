# Server酱

## 0.1.0

- 新增 World `serverchan`（显示名「Server酱」）：把一句话经 Server酱 推到 ta 的手机上，用于 ta 不在电脑前时也能收到。
- 两种通道按 SendKey 的形状自动分辨，并各按各的地址拼法：Turbo 用 `https://sctapi.ftqq.com/<key>.send`（`GET` + query），Server酱³ 从 Key 里取出数字子域拼成 `https://<数字>.push.ft07.com/send/<key>.send`（`POST` + JSON）。`sctp` 开头却没有数字时报错，不退回 Turbo 域名硬发。
- 设置页留空时读部署目录 `.env` 的 `SERVERCHAN_SENDKEY`；密钥不进回执，`sc_status` 里只露头尾。
- 工具 `sc_send`（写）：标题 32 字以内、正文 Markdown；支持 `tags`，Turbo 忽略并在回执里说明。同一标题与正文 60 秒内不重复发。
- 工具 `sc_status`（读）：通道（打码）、能否发送、今天成功几条、上一次结果。
- 环境提示变量 `sc.state`，告诉 bot 现在能不能推、走哪条通道、今天发了几条。
- 运行记录写在 `<data>/serverchan.json`（原子改写），只存上次结果与本地计数，不存正文。
- 市场标签 `internet` / `requires-key` / `im`。
