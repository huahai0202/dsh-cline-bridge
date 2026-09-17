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
    - 主 Key 完全由用户在 DSH 设置中配置，原生透传直通，不设代码层内置 Key 兜底；
    - **可选**多 Key 池：额外提供 Key 后，撞到「每日免费额度」类限流会自动换 Key 重发（未提供额外 Key 时行为与之前完全一致，零影响）。
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

## 🔁 Cline 多 Key 自动切换（可选）

Cline 的免费额度是**按 Key + 按模型**的每日上限，撞限流时服务端返回：

```json
429 {"code":"INFERENCE_CAP_ERROR",
     "message":"Error 429: Daily free limit reached on model deepseek/deepseek-v4.1-flash. Try again in 22h 47m"}
```

重试窗口以小时计，退避等待毫无意义，只能换 Key。插件位于 openai SDK 之下、pi-ai 的 `retryProviderRequest` 之上，**是唯一能「换 Key 重发」的层次**：只要换 Key 后拿到成功响应就直接返回，上层根本看不到那次 429。

> DSH 原生不支持多 Key：`apiKeyEnv` 是单个凭据引用，路由在请求进入 pi-ai 前只解析出一个 Key，pi-ai 的重试也始终复用同一个 Key。所以这个能力只能由插件在 fetch 层提供。

### 提供额外 Key 的三种方式（可组合）

| 方式 | 用法 |
| --- | --- |
| **DSH 凭据仓库**（推荐） | 在凭据中存 `CLINE_API_KEY_2`、`CLINE_API_KEY_3`…（插件默认探测 `_2`~`_10`），通过 `ctx.credentials.resolve(ref)` 读取，Key 不进代码与配置文件 |
| **启动环境变量** | 启动 DSH 前设置 `CLINE_API_KEYS=k2,k3`（逗号/空格/分号分隔），或直接 `CLINE_API_KEY_2`、`CLINE_API_KEY_3`… |
| **插件 config** | 在 profile 的 `cordis.patch.yml` 里给条目加配置（支持 `!!js` 表达式） |

```yaml
# 加在 profile 的 cordis.patch.yml（即 ~/.dsh/profiles/web/cordis.patch.yml）。
# 注意用 id 定向覆盖，不要用 insert —— 后者会挂载第二个插件实例、把 fetch 包两层。
- id: opencode-free-bridge
  config:
    clineKeys:
      - !!js process.env.CLINE_API_KEY
      - !!js process.env.CLINE_API_KEY_2
    # 可选：自建中转 / 测试用的目标匹配串（默认 api.cline.bot）
    # clineMatch: 'my-cline-proxy.example'
    # 可选：报文里解析不出重试窗口时的默认冷却（毫秒，默认 15 分钟）
    # clineCooldownMs: 900000
    # 可选：主 key 已知在冷却时，首发送就改用健康 key（默认 false，保持「先试主 key」的可预测行为）
    # skipCoolingRequestKey: true
    # 可选：额度状态落盘位置（默认 <DSH_HOME 或 ~/.dsh>/.opencode-free-bridge-cline-quota.json）
    # quotaStatePath: 'D:/somewhere/quota.json'
    # 可选：全池冷却时是否快速失败（默认 true）
    # allCoolingFailFast: false
    # 可选：最早恢复时刻至少还有这么久，才快速失败（毫秒，默认 5 分钟；设 0 表示只要全池冷却就快速失败）
    # failFastMinMs: 300000
```

### 用报错里的「恢复时刻」做的三件事

那份 429 报文里的 `Try again in 22h 47m` 是一个可直接使用的**绝对恢复时刻**，插件把它变成了三件事：

1. **额度状态跨进程持久化。** 冷却状态（key 的 8 位哈希标签 + 模型 + 恢复时刻 + 服务端原始报文）每 500ms 去抖后原子落盘到 `.opencode-free-bridge-cline-quota.json`，**文件里没有任何 key 原文**。于是 DSH 重启后不必再靠"撞一次才知道"——启动第一次请求就已经知道主 key 被限到几点，直接走健康 key。
2. **全池冷却时快速失败。** 若所有已知 key 在该模型上的最早恢复时刻还在 `failFastMinMs`（默认 5 分钟）之外，插件**不发**那个注定失败的请求，直接回放磁盘上缓存的服务端原始 429 并附 `x-should-retry: false`，让上层立即放弃而不是空等退避。若恢复时刻已在阈值内，则照常尝试（避免因服务端倒计时取整而误判）。
3. **恢复时间可观测。** 日志会打印绝对恢复时间（如"最早 12:40 恢复"），自检快照里也带 `readyInMin`。

> 缓存成功后会清掉该 key 的冷却记录，所以状态是自纠正的：一旦某个 key 实际已经恢复，它下一次成功就会把磁盘记录抹掉。

凭据仓库方式则是直接在 `~/.dsh/.credentials.yaml` 的 `refs` 下追加（或用 DSH Web 设置里的凭据页）：

```yaml
version: 1
refs:
  CLINE_API_KEY: "…"      # 主 key，DSH 已配置
  CLINE_API_KEY_2: "…"    # 插件会自动探测 _2 ~ _10
```

### 行为约定

- **首发送默认始终使用 DSH 里配置的那个 Key**，轮换只作为兜底；即使该 Key 已被本地记为「冷却中」也仍会先试一次（本地冷却只是推测，服务端额度可能已重置，先试一次更可预测）。
  - 代价是：当主 Key 在某模型上被限了一整天时，每一轮都会先白撞一次 429 再换 Key。若想省掉这次白撞，把 `skipCoolingRequestKey: true` 打开，首发送就会直接改用健康 Key（实测数据见下）。
- 撞限流后按 **`key + 模型`** 维度记录冷却：同一个 Key 在模型 A 上耗尽，不影响它在模型 B 上继续用；重试窗口优先从报文的 `Try again in 22h 47m` 解析，解析不出则用 `clineCooldownMs`。
- 挑选备用 Key 时用 **LRU + 跳过该模型已冷却者**，避免把压力集中到某一个 Key。
- 备用 Key 全部失败时区分收尾：**额度耗尽类**（`INFERENCE_CAP_ERROR` / 报文含 `Daily free limit` / 窗口 ≥ 10 分钟）会附加 `x-should-retry: false`，让 pi-ai 立即放弃而不是空等退避；**瞬时限流**则原样返回，交给 pi-ai 按 `retry-after` 自行重试。
- Key 原文永不写日志，只记录 8 位哈希标签；额度状态落盘时同样只写标签，**文件里不含任何 key**。
- 冷却状态跨 DSH 重启保留（见下「用报错里的恢复时刻做的三件事」）；缓存成功后自动清除对应记录。

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
node tools/cline-key-check.mjs    # Cline 多 Key 轮换：本地 mock 服务器复刻 429，无需真实 Key
```

可用 `ZEN_FREE_MODEL=xxx node tools/zen-check.mjs --live` 指定探测用的免费模型。

`cline-key-check.mjs` 覆盖：换 Key 恢复、按模型冷却、LRU 选 Key、三种 Key 来源（config / 环境变量 / 凭据仓库）、单 Key 与瞬时限流下的收尾差异、**额度状态跨重启持久化**、**全池冷却快速失败**。

> 自检默认把额度状态写到临时目录，不会碰你真实的 `.opencode-free-bridge-cline-quota.json`。

---

## 📄 开源许可

[MIT](./LICENSE) © huahai0202
