# opencode-free-bridge

**OpenCode Zen & Cline 渠道增强桥接器 — 专为 DeepSeek Harness (DSH) 打造。**

无需复杂代理，无需在 DSH 界面手动填写繁琐的客户端自定义头，直接赋能 DSH 原生 `opencode` 渠道与 `cline` 官方中转渠道。

---

## ✨ 特性

- **多渠道官方协议特征自动注入**：
  - **OpenCode Zen 渠道 (`opencode.ai/zen`)**：
    - 严格对齐官方 `session/llm/request.ts` 的头部构造：`User-Agent: opencode/<版本号>`、`x-opencode-client: cli`、`x-opencode-project: global`、`x-opencode-session`、`x-opencode-request`；
    - 按 opencode 官方 ID 规范生成 `x-opencode-session`（`ses_` + 12 位小写十六进制 + 14 位 base62，总长 30），彻底解决 `MissingSessionID` 报错与免费通道 `403 FreeTierError`；
    - 主动剥离 `x-session-affinity` / `X-Session-Id`：官方这两个头只用于「非 opencode 提供方」分支，DSH 底层 pi-ai 却会下发，直接透传会把非规范值带进 Zen 请求；
    - 同一会话稳定复用同一 session ID（服务端据此做路由固定与提示缓存），不同会话自动隔离；
    - 每轮请求自动生成唯一的规范 `x-opencode-request`（对应官方 `input.user.id`）；
    - 未配置 Key（或误填 URL）时自动使用官方匿名通道（`Bearer public`）。
  - **Cline 渠道 (`api.cline.bot`)**：
    - 自动注入完整的 Cline 官方客户端特征头（`user-agent: Cline/4.1.16`、`x-client-type: cline-vscode`、`x-platform: vscode`、`http-referer` 等）；
    - 鉴权完全由用户在 DSH 设置中配置的 Key 决定，原生透传直通，不设代码层内置 Key 兜底。
- **100% 流量精准隔离**：
  - 仅在网络请求目标为 `opencode.ai/zen` 或 `api.cline.bot` 时介入；
  - 对 DeepSeek 官方模型、OpenAI、Claude、Gemini 等其他所有渠道 100% 原样直通，零副作用。
- **纯原生轻量中间件**：体积仅数 KB，基于 DSH Cordis 插件架构，支持热插拔与无残留卸载。

---

## 🔍 免费通道放行条件（实测）

Zen 免费模型（`mimo-v2.5-free`、`nemotron-3.5-lightning-free` 等）由 Console 上游按「客户端指纹」放行，实测规则如下：

| 请求头 | 是否必须 | 说明 |
| --- | --- | --- |
| `x-opencode-session` | ✅ 必须 | 须匹配 `ses_` + **12 位小写十六进制** + 14 位 base62（总长 30）。缺失、`req_`/`msg_` 前缀、大写十六进制、长度不符或任意字符串一律 `403 FreeTierError` |
| `User-Agent` | ✅ 必须 | 只需包含 `opencode/` 前缀；官方源码为裸写 `opencode/${InstallationVersion}`，插件同此。附加 `ai-sdk/...`、`runtime/...` 后缀也能通过，但并非官方所发 |
| `x-opencode-client` / `x-opencode-project` / `x-opencode-request` | ❌ 非必需 | 取值任意、甚至整头省略都能通过（官方取 `flags.client` 默认 `cli`、`context.project.id`、`input.user.id`） |

服务端校验的是**形状**而非来源：会话 ID 中的 12 位十六进制时间戳不参与校验（可用随机值冒充），因此插件用「同一会话稳定映射」的方式生成合法 ID，在不牺牲路由固定与提示缓存的前提下通过校验。

补充实测边界（供后人少走弯路）：

| 会话值 | 结果 |
| --- | --- |
| `ses_` + 12 位小写 hex + 14 位大写字母 / 14 位纯数字 | ✅ 200（第 13 位起只需是 base62） |
| `ses_` + 26 位小写 hex | ✅ 200（恰为合法 base62 子集） |
| `ses_` + 首位字母大写 + 后 25 位 | ❌ 403（**首位必须是小写十六进制**） |
| `ses_` + 64 位 hex（opencode core runner 的 `promptCacheKey` 分支出现过此形态） | ❌ 403 |
| 任意字符串 / UUID / `req_`、`msg_` 前缀 | ❌ 403 |

覆盖面：门禁对 `/v1/chat/completions` 与 `/v1/responses`（`muse-spark-*-free` 走 `@ai-sdk/openai`）**一视同仁**，插件对 `opencode.ai/zen` 全路径生效，无需额外配置。

> ⚠️ 端点错配陷阱：`muse-spark-1.2-contributor-free` / `muse-spark-1.3-contributor-free` **只支持 Responses 端点**（`/v1/responses`）。实测走 `/v1/chat/completions` 会返回 `500 Internal server error`，看起来像服务故障，其实是端点用错了（对照 `mimo-v2.5-free` 走 chat/completions 正常）。DSH 内置目录（pi-ai）已把这两个模型标记为 `openai-responses`，因此在 DSH 中使用无需干预；把这两个 ID 拿去配置只支持 chat/completions 的客户端则会踩坑。

> ⚠️ `deepseek-v4-flash-free` 目前对任何头部组合都返回 `400 Model is unavailable`，属上游模型侧故障，与本插件无关。
>
>  models.dev 上 `opencode` 提供方登记了 29 个免费模型，但 live `/zen/v1/models` 实际仅列出 7 个：`mimo-v2.5-free`、`nemotron-3.5-lightning-free`、`nemotron-3-ultra-free`、`ling-3.0-flash-fin-free`、`muse-spark-1.2-contributor-free`、`muse-spark-1.3-contributor-free`、`deepseek-v4-flash-free`（最后一个即上文 400 的那个）。模型可见性由 DSH 内置目录（pi-ai）决定，与本插件无关。
>
>  关于两个 Muse Spark 免费 SKU：Muse Spark 是 Meta 的模型，Meta 自身分为 Standard（不使用你的数据训练）与 Contributor（允许训练换取折扣）两档；Zen 又加了第三档 Contributor Free（$0，限期收集反馈）。模型有 1.2（2026-08-05）与 1.3（2026-09-02）两代，**Zen 为每一代各发了一个免费 SKU**，所以同时存在两个——不是重复条目。免费池会轮换，以 live `/zen/v1/models` 为准，不要硬编码到文档里。

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

## 🧪 自检

Zen 的放行规则由服务端随时可能调整，更新插件后建议跑一遍自检：

```bash
node tools/zen-check.mjs          # 离线断言：头部形状、会话稳定性、渠道隔离、dispose 还原
node tools/zen-check.mjs --live   # 追加真实网络调用，确认免费通道确实放行
```

可用 `ZEN_FREE_MODEL=xxx node tools/zen-check.mjs --live` 指定探测用的免费模型。

---

## 📄 开源许可

[MIT](./LICENSE) © huahai0202
