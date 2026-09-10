# opencode-free-bridge

**OpenCode Zen & Cline 渠道增强桥接器 — 专为 DeepSeek Harness (DSH) 打造。**

无需复杂代理，无需在 DSH 界面手动填写繁琐的客户端自定义头，直接赋能 DSH 原生 `opencode` 渠道及 `cline` 官方中转渠道。

---

## ✨ 特性

- **多渠道官方协议特征自动注入**：
  - **OpenCode Zen 渠道 (`opencode.ai/zen`)**：
    - 自动模拟官方 CLI User-Agent 与 Client 特征；
    - 动态生成符合规范的 `X-Session-Id`、`x-opencode-session`、`x-session-affinity`，彻底解决 `MissingSessionID` 报错；
    - 每轮请求自动生成唯一 `x-opencode-request` 与上下文标识；
    - 未配置 Key（或误填 URL）时自动使用官方匿名通道（`Bearer public`）。
  - **Cline 渠道 (`api.cline.bot`)**：
    - 自动注入完整的 Cline 官方客户端特征头（`user-agent: Cline/4.1.16`、`x-client-type: cline-vscode`、`x-platform: vscode`、`http-referer` 等）；
    - 鉴权完全由用户在 DSH 设置中配置的 Key 决定，原生透传直通，不设代码层内置 Key 兜底。
- **100% 流量精准隔离**：
  - 仅在网络请求目标为 `opencode.ai/zen` 或 `api.cline.bot` 时介入；
  - 对 DeepSeek 官方模型、OpenAI、Claude、Gemini 等其他所有渠道 100% 原样直通，零副作用。
- **纯原生轻量中间件**：体积仅数 KB，基于 DSH Cordis 插件架构，支持热插拔与无残留卸载。

---

## 📦 安装方法

在终端运行以下命令，将插件安装到 DSH 的 `web` Profile：

```bash
dsh plugin --profile web add github:huahai0202/opencode-free-bridge
```

---

## 🚀 使用说明

### 1. OpenCode Zen
- 重启 DSH：`dsh web`
- 在模型选择器中直接进入 **`opencode`** 分组，无需填写 Key 即可畅享免费模型。

### 2. Cline 渠道
在 DSH 的 `settings.yaml` 中配置 `cline` 提供方（或在 DSH Web 设置中添加自定义提供方）：
- Base URL: `https://api.cline.bot/api/v1`
- 协议: `OpenAI Compatible` (`openai-completions`)
- 请求头无需手动复制，插件会自动拦截补全全部官方认证头部。

---

## 📄 开源许可

[MIT](./LICENSE) © huahai0202
