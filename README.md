# opencode-free-bridge

**OpenCode Zen 免费模型原生无感桥接器 — 专为 DeepSeek Harness (DSH) 打造。**

无需 API Key，无需额外注册，不增加冗余提供商分组，直接激活 DSH 原生自带的 `opencode` 渠道。

---

## ✨ 特性

- **原生渠道无感集成**：直接赋能 DSH 自带的 `opencode` 渠道，模型列表整洁，无需使用带第三方前缀的独立 Adapter。
- **全套官方 CLI 协议特征注入**：
  - 自动模拟官方 CLI User-Agent 与 Client 特征；
  - 动态生成符合规范的 `X-Session-Id`、`x-opencode-session`、`x-session-affinity`，彻底解决 `MissingSessionID` 报错；
  - 每轮请求自动生成唯一 `x-opencode-request` 与项目上下文标识。
- **智能免密兜底**：
  - 未配置 Key（或误填 URL）时，自动无感使用官方匿名通道（`Bearer public`）；
  - 配置了个人真实 Key 时，自动保留并透传，无缝支持全量付费模型。
- **100% 流量精准隔离**：
  - 仅在网络请求目标为 `opencode.ai/zen` 时介入；
  - 对 DeepSeek 官方模型、OpenAI、Claude、Gemini 等其他渠道 100% 原样直通，零副作用。
- **纯原生轻量中间件**：体积仅数 KB，基于 DSH Cordis 插件架构，支持热插拔与无残留卸载。

---

## 📦 安装方法

在终端运行以下命令，将插件安装到 DSH 的 `web` Profile：

```bash
dsh plugin --profile web add github:huahai0202/opencode-free-bridge
```

---

## 🚀 使用说明

1. **重启 DSH**：
   ```bash
   dsh web
   ```
2. **选择模型**：
   在 DSH 网页界面的模型选择器中，直接进入原生 **`opencode`** 分组，选择可用模型（如 `MiMo V2.5 Free` 等）。
3. **开始对话**：
   无需在设置中填写任何 API Key，即可直接发送消息。

---

## 📄 开源许可

[MIT](./LICENSE) © huahai0202
