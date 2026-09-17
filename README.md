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
    - **可选**多 Key 池：额外提供 Key 后，撞到「每日免费额度」类限流会自动换 Key 重发（未提供额外 Key 时行为与之前完全一致，零影响）；
    - **设置页面板**：在 DSH 设置里新增「Cline Key」分区，逐把列出每个 Key 的来源、掩码预览、健康/冷却状态、各模型的恢复倒计时与**跨重启保留**的累计用量（发送 / 成功 / 限流、输入输出 token）。
    - **累计统计跨重启保留**：每把 Key 的发送/成功/限流、输入输出 token、按模型明细、最近使用时刻，以及三个累计计数与「最近决策」，都按 8 位哈希标签与冷却一起落盘；面板标出统计起点，顶部另有「重置统计」（两段式确认，只清统计、不碰冷却与凭据）。
    - **面板直接导入 Key**：面板右上角（插件版本卡右边）一个「导入 Key」按钮，粘贴一把或多把即可写进凭据仓库的空闲槽位（`CLINE_API_KEY_2`~`_10`），写完立刻进池、当轮即可参与轮换；重复的自动跳过，可用 `keyImport: false` 关掉整条写入口。
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

### 提供额外 Key 的五种方式（可组合）

| 方式 | 用法 |
| --- | --- |
| **设置面板导入（最省事）** | DSH 设置 → **Cline Key** → 右上角「**导入 Key**」：粘贴（一行一把，也认空格/逗号分隔）→ 导入。插件会把它们写进凭据仓库的空闲槽位 `CLINE_API_KEY_2`~`_10`，池内已有的自动跳过，导入完立刻参与轮换 |
| **`.credentials.yaml`（默认）** | 在 `<DSH_HOME>/.credentials.yaml` 的 `refs` 下存 `CLINE_API_KEY_2`、`CLINE_API_KEY_3`…（插件默认探测 `_2`~`_10`）。可用 `clineKeyRefs` 改成别的 ref 名，**未列出的 ref 一律忽略** |
| **启动环境变量** | 启动 DSH 前设置 `CLINE_API_KEYS=k2,k3`（逗号/空格/分号分隔），或直接 `CLINE_API_KEY_2`、`CLINE_API_KEY_3`… |
| **插件 config** | 在 profile 的 `cordis.patch.yml` 里给条目加配置（支持 `!!js` 表达式） |
| **完全不在 DSH 配 key** | 把 Cline 提供方配置里的 `apiKeyEnv` **整个移除**（只清空设置页里的 API 密钥值没用，见下）：请求不带鉴权头，插件在首发送前从池里挑一把兜底（粘性优先、跳过已冷却者），后续撞 429 照常轮换；`fillMissingRequestKey: false` 可关掉 |

> 额外 Key 的解析**不会一次性上锁**：首次未读到（例如文件稍后才出现）会每 2 秒重试，成功读到后每 5 分钟复扫一次——运行期新增的 ref 也会被发现。另外，插件的**写**路径（面板导入）优先走 DSH 的凭据服务，服务写完之后会发 `credentials/reference-updated`；插件订阅了该事件并立刻强制重扫一次，所以「导入 / 在 DSH 设置页改 ref / 手工编辑凭据文件」都会在下一秒进入池子，不必等那 5 分钟。
>
> **为什么读盘仍然直读文件**：凭据服务可能在插件挂载之后才就绪，而读侧不能在服务缺席时失效，所以保留 `.credentials.yaml` 直读作兜底；`ctx.inject(['credentials'], cb)` 只是**可选加速**与写入通道，服务缺席时插件照常工作（导入退化为直写文件）。注意这里用的是子 fiber 的 `ctx.inject`，**不是**模块级 `export const inject = ['credentials']`——后者会把整个插件（含 Zen 头注入）门控在该服务上。
>
> 排查入口：状态文件里带 `diagnostics` 字段（插件版本、`credentialsFileRead`、`poolSize`、`clineRequests`/`rotations`/`failFasts` 计数、`lastDecision`、各 Key 的冷却模型），一眼能看出「为什么没换 Key」。日志里 Key 只以 8 位哈希标签出现。

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
    # 可选：设置面板里是否显示 Key 的首尾各 4 位掩码（默认 true；设 false 则连片段也不下发）
    # maskKeyPreview: false
    # 可选：设置面板的写入口（导入 Key / 重置统计两条 POST 路由，默认 true；设 false 则写路由一律 403，只读面板照常）
    # keyImport: false
    # 可选：DSH 侧没配 key 时，首发送是否从池里挑一把兜底（默认 true）。
    # 关掉场景：clineMatch 指向不需要鉴权的自建中转，此时不该把池里的 key 注入进去
    # fillMissingRequestKey: false
```

### 用报错里的「恢复时刻」做的三件事

那份 429 报文里的 `Try again in 22h 47m` 是一个可直接使用的**绝对恢复时刻**，插件把它变成了三件事：

1. **额度状态与用量统计跨进程持久化。** 冷却状态（key 的 8 位哈希标签 + 模型 + 恢复时刻 + 服务端原始报文）与**用量统计**（每把 key 的发送 / 成功 / 限流、输入输出 token、按模型明细、最近使用时刻，以及 `Cline 请求` / `换 Key 恢复` / `快速失败` 三个累计计数与最近决策）每 500ms 去抖后原子落盘到 `.opencode-free-bridge-cline-quota.json`——**文件里没有任何 key 原文，连掩码也没有**。于是 DSH 重启后不必再靠"撞一次才知道"——启动第一次请求就已经知道主 key 被限到几点，直接走健康 key。
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

- **主 Key 挂载即入池。** 插件从 DSH 设置里 Cline 提供方的 `apiKeyEnv` 解析出主 Key（凭据服务优先，缺席时直读凭据文件），挂载时就把它登记进池子——所以重启后面板立刻是全量，不必先发一条请求才变全。来源仍标 `DSH 请求头`（它本来就是 DSH 会携带的那把）；settings 或凭据服务缺席时静默跳过，行为不变。
- **首发送默认始终使用 DSH 里配置的那个 Key**，轮换只作为兜底；即使该 Key 已被本地记为「冷却中」也仍会先试一次（本地冷却只是推测，服务端额度可能已重置，先试一次更可预测）。
  - 代价是：当主 Key 在某模型上被限了一整天时，每一轮都会先白撞一次 429 再换 Key。若想省掉这次白撞，把 `skipCoolingRequestKey: true` 打开，首发送就会直接改用健康 Key（实测数据见下）。
- 撞限流后按 **`key + 模型`** 维度记录冷却：同一个 Key 在模型 A 上耗尽，不影响它在模型 B 上继续用；重试窗口优先从报文的 `Try again in 22h 47m` 解析，解析不出则用 `clineCooldownMs`。
- 挑选备用 Key 时**粘性优先**：一直用同一把（最近在用的那把），**直到它也撞上限才换下一把**，并始终跳过该模型上已冷却者。原因是 Cline 的免费额度按 `key + 模型` 每日重置：摊开轮换会让池内所有 Key 几乎同时逼近上限、一起失去后备；压着一把烧完再换，池子里才始终留着没动过的额度。面板上会看到某一把的「发送」持续增长、其余保持 0，这是预期形态。
- 备用 Key 全部失败时区分收尾：**额度耗尽类**（`INFERENCE_CAP_ERROR` / 报文含 `Daily free limit` / 窗口 ≥ 10 分钟）会附加 `x-should-retry: false`，让 pi-ai 立即放弃而不是空等退避；**瞬时限流**则原样返回，交给 pi-ai 按 `retry-after` 自行重试。
- Key 原文永不写日志，只记录 8 位哈希标签；额度状态落盘时同样只写标签，**文件里不含任何 key**。设置页面板是唯一的例外通道：它经同源只读路由展示每个 Key 的**首尾各 4 位掩码**（例如 `sk-a…9f2c`），方便你认出是哪一把；可用 `maskKeyPreview: false` 彻底关闭。面板上的「导入 Key」是唯一的**写**通道，且只往 `clineKeyRefs` 名单内的备用 ref 写你亲手粘贴的 Key——它不读取、不回显、也不改动别人的 Key。
- 冷却状态跨 DSH 重启保留（见下「用报错里的恢复时刻做的三件事」）；缓存成功后自动清除对应记录。
- **DSH 侧完全没配 key 也能用**：把 Cline 提供方配置里的 `apiKeyEnv` 整个移除后，请求不带鉴权头，插件在首发送前就从池里挑一把兜底（粘性优先、跳过已冷却者），后续撞 429 照常轮换；`fillMissingRequestKey: false` 可关掉（例如 `clineMatch` 指向免鉴权的自建中转）。注意**只清空设置页里的 API 密钥值是不够的**——pi-ai 只要还配着 `apiKeyEnv` 就会去解析它，解析不到会在请求发出前直接报错，轮换池根本没机会上场。

### 设置页面板（Cline Key）

在 **DSH 设置 → Cline Key** 里可以一眼看到池内每把 Key 的情况（分区由 DSH 自己的 `settings.section` 座位承载，配色与主题全部继承宿主）。

**按模型查看。** 面板顶部是一排模型筛选（**没有「全部模型」选项**），**默认选中你当前正在用的那个模型**。这是必需的——冷却与用量都是 `key + 模型` 维度：一把 Key 在 `deepseek-v4.1-flash` 上撞了每日上限，在 `glm-5.3-flash` 上往往照常可用；把两个模型合并显示，既读不出「这把 Key 现在到底能不能用」，也会让人误以为池子已经没 Key 可用。状态药丸、冷却列、用量列、最近使用**全部只看当前模型**，概览卡的「该模型可用 / 该模型冷却」讲的也是这个模型的可用把数；要看另一个模型就点它对应的芯片。

> **模型清单从哪来**：= DSH 设置里 **Cline 通道（baseURL 命中 `clineMatch` 的提供方）配置的模型** ∪ **实际观察到活动的模型**（流量、冷却记录）。只看流量的话，重启后还没发过请求的模型会整个消失（面板里只剩有冷却记录的那个模型，看着像少了模型）；只看配置的话，临时跑过的其它模型又不会出现。默认筛选项的优先级是：最近一次真实流量的模型 → DSH 的 `agent-default-model`（若它也在 Cline 名下）→ 配置里的第一个。`settings` 服务缺席时自动退化为「只列观察到的模型」，不会报错。

| 列 | 含义 |
| --- | --- |
| **#** | 池内序号，按最近使用倒序 |
| **Key** | 首尾各 4 位的掩码预览 + 8 位哈希标签 |
| **状态** | 可用 / 冷却中（只看当前模型） |
| **冷却 / 恢复** | 该 Key 在当前模型上的恢复倒计时与恢复时刻（是哪个模型由筛选条决定，不再重复显示模型名） |
| **请求 / Token** | 上行：真的发给上游 / 成功 / 撞限流的次数；下行：**输入/输出 token**。都是当前模型的数字（切芯片即切换） |
| **最近使用** | 该模型上的相对时间（从没跑过就显示「从未」）；模型名放在 `title` 里，悬停可见 |

> 表格里的 `16/15/1` 与 `12.3k/1.2k` 是**紧凑写法**（列宽只有百来像素）；每个数字的确切含义在下方的「按模型用量」卡里逐列标注。

面板顶部还有池大小、可用/冷却把数、`Cline 请求` / `换 Key 恢复` / `快速失败` 三个累计计数与插件版本；表格下方依次是**「按模型用量」**与「最近决策」（最近几条请求的模型与决策文本）。面板每 5 秒自动刷新一次（页面不可见时暂停），也可手动刷新。

**累计统计跨重启保留 + 可重置。** 统计行下面那行小字写着**统计起点**（`统计自 09-17 19:39 起累计 · 跨重启保留`）——这些数字不再随插件更新清零：它们与冷却共用同一个状态文件，按每把 key 的 8 位哈希标签恢复（token、发送/成功/限流、按模型明细、最近使用时刻，以及三个累计计数与最近决策）。顺带一个副作用是**「粘性选 Key」也跨重启延续**：恢复的 `lastUsedAt` 让插件重启后仍然接着烧同一把备用 Key，而不是从池头重开一把。

顶部右侧的**「重置统计」**按钮是两段式（先点一下变「确认重置」，4 秒内不点会自动撤回，再点才真的执行）：把计数、token、最近决策与统计起点全部归零并立刻落盘；**冷却与额度不受影响**——那是服务端的事实，不是我们的计数。

**导入 Key（插件版本卡右边的按钮）。** 点开是一个粘贴框（取消按钮 / 点遮罩 / `Esc` 都能关）：**一行一把**（也认空格 / 逗号 / 分号分隔，会顺手剥掉包裹引号与 `Bearer ` 前缀）。提交后插件把每一把落到凭据仓库里**最小的空闲槽位**（`CLINE_API_KEY_2` → `_10`），写完立刻重扫 Key 池，因此导入完当轮就能参与轮换，**不需要重启**。结果按四类收口：

| 结果 | 含义 |
| --- | --- |
| **已导入 n 把** | 写入成功的槽位会逐一列出（如 `CLINE_API_KEY_6`、`CLINE_API_KEY_7`） |
| **跳过 n 把（池内已存在）** | 按 8 位哈希标签判重：已经在池子里的 Key 不会再写一份，也不会多占槽位 |
| **忽略 n 条（格式不符）** | 太短 / 太长 / 含控制字符 / 超出单次上限（20 把）/ 没有空闲槽位，逐条给出掩码与原因 |
| **写入失败 n 把** | 底层写盘报错（例如该 ref 被启动环境变量遮蔽，凭据服务会拒绝写入），原文错误一并回显 |

细节与边界：

- **写入走哪条路**：优先 DSH 凭据服务的 `set()`（带文件锁的原子写 + 变更通知，与 DSH 设置页写凭据同一条路径）；服务缺席或尚未就绪时退化为**直写 `.credentials.yaml`**——同样走「同目录临时文件 + 改名」，并且**不碰文件的其余内容**（`records` 段、注释、行尾风格一律保留）。
- **只写名单内的 ref**：`clineKeyRefs`（默认 `_2`~`_10`）之外的 ref 一律不碰；槽位用尽时明确回 `no-free-ref`，并提示先删掉不用的 `CLINE_API_KEY_n`。
- **不算主 Key**：它不会去改 DSH 里配置的 `CLINE_API_KEY`（那是 `apiKeyEnv` 指向的主 Key）；面板只往备用槽位里加。
- **关掉它**：`keyImport: false` 后写路由一律 403（返回一句说明），只读面板照常工作。

**按模型用量（含 token）。** 面板始终处在某个模型的筛选下（筛选芯片没有「全部模型」），所以这张卡把每把 Key 在**当前模型**上的实际用量压成**一行**——Key 预览 + 哈希标签 + `发送/成功/限流` + **`输入/输出 Token`**（配一根占比条）+ 最近使用时间；标题行给出当前范围的**合计**。模型名不在这张卡里重复出现——它已经写在筛选芯片上了：

```
按模型用量                                        合计 40/39/1 · 37.8k/3.6k
┌──────────────────────────────────────────────────────────────────────┐
│ Key                             发送  成功  限流    输入    输出   最近使用 │
│ 1  sk_l…4444  db694bbf             3     3     0   ▇▇      4.5k    300    4 秒前 │
│ 2  sk_t…8888  761f9875            21    21     0   ▇▇▇▇▇▇▇   21k   2.1k   9 秒前 │
│ 其余 3 把在该模型上没用过                                                │
└──────────────────────────────────────────────────────────────────────┘
```

- **占比条**：条长按同一张卡内的最大用量归一（最大那行占满整条），段内再按 `输入:输出` 拆分（深色＝输入、浅色＝输出），所以「哪把 Key 用得多」一眼可比——纯数字做不到。悬停条或数字都能看到精确值。
- **表头逐列标注**：`发送 | 成功 | 限流` 与 `输入 | 输出` 各自成列，标签就压在自己的数字正上方——含义直接可见、不用记顺序，也不靠悬停；短标签（2 字）在任何字号下都不会被折行。`Token` 列上方是占比条，条与数字同宽同起点。
- **未使用的 Key 折叠成一行**：在该模型上没用过的 Key 不再各占一块（那会让半张卡都是「没用过」）。
- **不标「主 Key」**：开启 `skipCoolingRequestKey` 后，DSH 发来的那把与池内其它 Key 完全同级（该冷却照样被跳过、粘性选择也不偏袒它），标出来是在描述一个并不存在的高低关系。可选 Key 的**来源**（`DSH 请求头` / `config: clineKeys[n]` / `env: …` / `.credentials.yaml: REF`）仍由主机端记录在状态载荷里，只是不在面板上占列。
- token 数按 k/M 压缩显示（`12.3k`、`1.23M`），整数不留 `.0`。
- 这张卡单独存在而不是塞进表格的用量列，是为了给两组数字**逐列标注**并放下占比条；它跟随模型筛选——切芯片即切换整卡内容。模型名同理不再出现在卡里：面板恒定在看某个模型，名字写在筛选芯片上就够了。

> **token 从哪来**：插件位于 openai SDK 之下，是唯一能碰到原始响应体的层次，所以用量只能在这里捞：**流式**（Cline 走的就是这条）取 SSE 里最后一个带 `usage` 的 data chunk——pi-ai 已经带上了 `stream_options.include_usage`；**非流式**取 JSON 体里的 `usage`。实现上把响应体 `tee` 成两路，一路原样交给上层 SDK，另一路只挑 `usage` 读一遍即丢，所以响应内容与流式行为完全不变（自检里专门断言了 SSE 与 usage 原样送达）。只有 2xx 才挂这个观察分支，错误/重试路径一概不碰。用量按 `key + 模型` 记录，同时累加到 Key 级总计，并**按 8 位哈希标签落盘**（与冷却共用同一个状态文件）——所以插件更新 / DSH 重启后这些数字不会清零。

> 表格列宽按**百分比**分配（6 列合计 100%），并且**表头与单元格都做省略号收口**：侧栏窄下来时每一列只会在自己的格子里截断，不会几列标题挤成一片，长模型名也不会把行撑高；容器窄于 560px 时才退回横向滚动。被截断的值（完整模型名等）都放在 `title` 里，鼠标悬停可看全。

> 每把 Key 的**来源**（`DSH 请求头` / `config: clineKeys[n]` / `env: CLINE_API_KEY_n` / `.credentials.yaml: REF`）仍由主机端记录并保留在状态载荷里（自检会断言它），只是不再显示在面板上。原先随「运行参数」卡一起下发的配置摘要（匹配目标、冷却时长、快速失败阈值、掩码开关、凭据文件路径）已从载荷中移除——面板从不需要它，而真正的排查入口是额度状态文件里的 `diagnostics` 字段。

> **数据通道与隐私边界**：主机半边只在 `ctx.inject(['webServer'], …)` 里注册三条同源路由，都带 `no-store`，都不出现任何 Key 原文：
>
> | 路由 | 用途 | 闸门 |
> | --- | --- | --- |
> | `GET /opencode-free-bridge/cline-keys` | **只读**：把池状态交给浏览器半边渲染 | 同源 `Referer` 校验；只允许 `GET`/`HEAD`。只下发哈希标签、掩码预览、来源标签、冷却时刻与计数——**不回显 `config.clineKeys`**，也不含任何 Key 原文；掩码只在内存里现算，磁盘状态文件里连掩码都没有 |
> | `POST /opencode-free-bridge/cline-keys/import` | **写**：把面板里粘贴的 Key 写进备用槽位 | 同源 `Referer` 校验；只允许 `POST`；必须 `application/json`（挡住表单/文本这类无需预检的跨站简单请求）；正文上限 64KB；可用 `keyImport: false` 整条关掉。回包只有 ref、哈希标签与掩码 |
> | `POST /opencode-free-bridge/cline-keys/stats/reset` | **写**：把累计统计归零 | 与导入同一套闸门（`keyImport: false` 一并关掉）。只动统计，不动冷却，也不动凭据 |
>
> 三条路由都只在 `ctx.inject(['webServer'], …)` 的子 fiber 里注册，headless / acp / desktop 这些没有 `webServer` 的 profile 里它们一起缺席，主链路（fetch 补丁）不受影响。全程用 `node tools/cline-panel-check.mjs` 断言：回包不含 Key 原文、写路由的每道闸门、以及磁盘状态文件里连掩码都没有。
>
> **不门控主链路**：路由等待 `webServer` 用的是 `ctx.inject([...])` 子 fiber，而不是模块级 `export const inject = ['webServer']`。后者会把整个插件（包括 fetch 补丁）门控在 webServer 上，让 headless / acp / desktop 等没有 webServer 的 profile 连渠道桥接一起失效。

---

## 🧩 代码结构

主机半边按职责拆分，入口只做装配：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `index.js` | ~613 | 插件入口：装配各模块 + 实现 fetch 层拦截（Zen 头注入 / Cline 换 Key 轮换）+ 面板只读/导入/重置三条路由 |
| `lib/host/defaults.js` | ~48 | 插件版本、各通道可调常量、DSH 路径解析 |
| `lib/host/ids.js` | ~116 | opencode 会话/请求 ID 生成；key 的 8 位哈希标签与掩码预览 |
| `lib/host/quota-state.js` | ~225 | 状态落盘：额度冷却 + **用量统计 / 累计计数**（同一文件、同一去抖写入器）+ 重试窗口解析 |
| `lib/host/request-shape.js` | ~58 | 读请求形状：body 可否重发、模型名、鉴权头读写 |
| `lib/host/credentials.js` | ~87 | 兜底读取 `.credentials.yaml` 的 refs 段；凭据服务缺席时的兜底写入（保留其余内容 + 临时文件改名） |
| `lib/host/key-import.js` | ~106 | 面板导入：粘贴文本解析、空闲 ref 分配、写入编排（不含 Key 原文的返回值） |
| `lib/host/usage.js` | ~95 | Token 用量采集（tee 出只读分支扫 usage） |
| `lib/host/key-pool.js` | ~322 | key 池：来源、按 `key+模型` 冷却、粘性选 Key、按模型用量（按 8 位标签跨重启恢复） |
| `lib/host/status.js` | ~140 | 设置面板的状态载荷（唯一的对外数据出口，字段白名单） |
| `lib/host/http.js` | ~80 | 路由的 JSON 响应、同源校验、带上限的 JSON 正文读取 |
| `lib/client.js` | ~1068 | 浏览器半边：设置页分区（含导入按钮与弹窗、重置统计）（**必须单文件**，见下） |

> **为什么 `lib/client.js` 不能拆分**：DSH 的客户端模块系统是「**一个包 = 一个 bundle**」——`package.json` 的 `exports['./client']` 只能指向单个文件，浏览器侧模块图是 flat 的（每个 bundle 只与平台基线表相连）。bundle 之间互相 `require` 只能通过 `dsh.client.external` 声明，而那要求**另发一个包**。所以除非引入构建步骤（tsdown/esbuild 把多个源文件打成单个 `lib/client.js`，如 `dsh-better-sidebar` 那样），客户端半边只能保持一个手写文件。主机半边没有这个限制，因为 Node ESM 的相对 import 天然支持包内多文件。

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

Zen 的放行规则由服务端随时可能调整，更新插件后建议跑一遍自检。**平时只需要这一条命令**（它依次跑完全部分项，最后打印汇总表）：

```bash
node tools/self-check.mjs            # 一键跑完全部（zen + cline-key + cline-panel）
node tools/self-check.mjs cline-key  # 只跑名字匹配的分项
```

分项文件各自也能单独运行（定位失败时更顺手）：

```bash
node tools/zen-check.mjs          # 离线断言：头部形状、会话稳定性、渠道隔离、dispose 还原
node tools/zen-check.mjs --live   # 追加真实网络调用，确认免费通道确实放行
node tools/cline-key-check.mjs    # Cline 多 Key 轮换：本地 mock 服务器复刻 429，无需真实 Key
node tools/cline-panel-check.mjs  # 设置页面板：只读/导入/重置路由契约 + 统计持久化 + 浏览器半边真实渲染
```

可用 `ZEN_FREE_MODEL=xxx node tools/zen-check.mjs --live` 指定探测用的免费模型。

`cline-key-check.mjs` 覆盖：换 Key 恢复、按模型冷却、**粘性选 Key（先烧完一把再换下一把）**、三种 Key 来源（config / 环境变量 / 凭据仓库）、单 Key 与瞬时限流下的收尾差异、**额度状态跨重启持久化**、**全池冷却快速失败**、**用量统计跨重启持久化（含粘性延续）**。

`cline-panel-check.mjs` 覆盖：

- **主机半边**：路由只在 `ctx.inject(['webServer'])` 里注册（不门控主链路）、同源校验与 `GET`/`HEAD` 限制、载荷**不含任何 Key 原文**且只带首尾掩码、`maskKeyPreview: false` 时连片段也不下发、**磁盘状态文件里连掩码都没有**、用量计数与来源标签正确。
- **导入写路由（L 组）**：非 `POST` → 405、非同源 → 403、非 JSON → 415、坏 JSON → 400、空正文 → 400、超 64KB → 413；正常导入落最小空闲槽位、**凭据文件里真的写对了**、池子**立刻**可见（不等 TTL）、回包只有 ref/标签/掩码、重复导入不占新槽位、脏输入按太短/太长/重复分类、槽位用尽回 `no-free-ref`、**凭据服务缺席时直写文件且保留 records 段**、凭据变更事件触发立刻重扫。
- **统计持久化与重置（P 组）**：请求跑完后状态文件里出现按 8 位标签索引的 `usage` 与 `totals`（且**不含原文与掩码**）；换一个全新实例读同一份文件后，累计计数、每把 Key 的发送/成功/限流、key 级与按模型的 token、统计起点、最近决策**全部还在**；重置路由的三道闸门，以及重置后「计数/token/最近决策归零、统计起点改到当下、冷却与额度不动、结果已落盘」。
- **浏览器半边**：在 `node:vm` 沙箱里用迷你 React 真正渲染（有数据 / 空池 / 请求失败三条路径），断言渲染树里不出现 Key 原文；**导入入口**（N 组）则把整条链路走一遍——按钮长在版本卡右边、点开是粘贴框、提交发出一次带 `application/json` 的 POST、结果以摘要收口并列出落到的 ref、成功后自动重拉一次面板数据、`Esc` 能关掉弹窗；**重置入口**则验证统计起点那行小字、两段式确认（第一次点击不发请求）、第二次点击才 POST、以及重置后的提示。
- **粘性跨重启（cline-key-check 的 P 组）**：故意把插入顺序排成 `k1 → k3 → k2` 并让 `k2` 先用过一次，于是「按 `lastUsedAt` 恢复」与「没恢复、按插入顺序」会挑出**不同**的备用 Key——这条断言才真的在测恢复。

> 自检默认把额度状态写到临时目录，不会碰你真实的 `.opencode-free-bridge-cline-quota.json`。

---

## 📄 开源许可

[MIT](./LICENSE) © huahai0202
