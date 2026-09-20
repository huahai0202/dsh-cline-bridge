// Cline Key 使用情况面板 —— 浏览器半边（零构建手写 bundle）。
//
// 与 dsh-better-archive 同一个已验证的形态：CJS factory + ModuleLoader 包装，
// React 经 require("react") 取用，UI 组件全部来自 DSH 自己的
// @deepseek-ai/dsh-client-ui-primitives（浏览器内核基线模块，无需在
// dsh.client.external 里声明），因此配色、圆角、焦点环、亮暗主题全部继承宿主。
//
// 数据来自主机半边（index.js）注册的同源只读路由 GET /dsh-cline-bridge/keys，
// 每 5 秒轮询一次（页面不可见时跳过）；导入 / 重置统计 / 选定「使用中」的 Key
// 走三条同源写路由（POST JSON，主机端闸门一致）。
// 该路由只回 8 位哈希标签与**掩码预览**（首尾各 4 位），key 原文既不在响应里，
// 也不在日志与磁盘状态文件里。
//
// 面板挂在设置页的 `settings.section` 座位：DSH 自己用同一个座位承载
// 「通用」「模型」等内置分区，所以这里不需要自绘任何设置页外壳。
window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 完全一致。
  id: 'dsh-cline-bridge',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var createElement = React.createElement
    var ui = require('@deepseek-ai/dsh-client-ui-primitives')
    // DSH 自己的按钮。这里不再回退到原生 'button'：该导出是宿主的静态导出，且
    // package.json 的 dsh.client.inject 已声明这个依赖，回退分支不可达；真回退过去
    // 反而会把 variant/icon 当成非法 DOM 属性，坏得更隐蔽。
    var Button = ui.Button

    /** 设置分区 id（= 插件名）与主机端路由。 */
    var PANEL_ID = 'dsh-cline-bridge'
    var ROUTE = '/dsh-cline-bridge/keys'
    // 导入是写路径：POST JSON，主机端另有同源 + Content-Type + 体积上限三道闸。
    var IMPORT_ROUTE = '/dsh-cline-bridge/keys/import'
    // 重置统计也是写路径：同样 POST JSON，主机端走同一套闸门
    var RESET_ROUTE = '/dsh-cline-bridge/keys/stats/reset'
    // 选定「使用中」的 Key：第三条写路径，闸门与前两条完全一致
    var SELECT_ROUTE = '/dsh-cline-bridge/keys/select'
    var LOCALE_NS = 'dshClineBridge'

    /** 轮询间隔：设置页偶尔打开一次，5 秒足够反映冷却变化，代价仅一条本机请求。 */
    var REFRESH_MS = 5000

    // ───────────────────────── 样式（只做布局，颜色全部用 DSH token） ─────────────────────────
    // 每次加载都**覆盖**样式内容，而不是「已存在就跳过」：插件更新后客户端 bundle 可能
    // 在不刷新页面的情况下被换掉（HMR / 热重载），若只按 id 判断存在就会一直沿用旧 CSS，
    // 表现为「新结构配旧样式」——布局错乱且极难排查（表头换行、对齐错位就是这么来的）。
    var STYLE_ID = 'dsh-cline-bridge-styles'
    if (typeof document !== 'undefined') {
      var styleEl = document.getElementById(STYLE_ID)
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = STYLE_ID
        styleEl.dataset.plugin = 'dsh-cline-bridge'
        document.head.appendChild(styleEl)
      }
      styleEl.textContent = [
        '._dsh_ofb_root { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 900px; margin: 0 auto; box-sizing: border-box; color: var(--dsw-alias-label-primary, inherit); }',
        '._dsh_ofb_head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; min-height: 36px; }',
        '._dsh_ofb_h2 { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }',
        '._dsh_ofb_caption { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_stats { display: flex; flex-wrap: wrap; gap: 8px; }',
        // 统计小卡：DSH 设置卡片同款表面（layer-3 填充 + 描边高度）
        '._dsh_ofb_stat { display: flex; flex-direction: column; gap: 2px; min-width: 92px; padding: 8px 12px; border-radius: 12px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-elevation-stroke); }',
        '._dsh_ofb_stat_value { font-size: 16px; line-height: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }',
        '._dsh_ofb_stat_label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_card { border-radius: 14px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-elevation-stroke); overflow: hidden; }',
        // 模型筛选药丸：沿用 DSH 的胶囊造型与语义色（选中态用 business-primary 的淡底）
        '._dsh_ofb_filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }',
        '._dsh_ofb_filter_label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, inherit); margin-right: 2px; }',
        '._dsh_ofb_chip { display: inline-flex; align-items: center; max-width: 220px; height: 24px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l4); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); font: inherit; font-size: 12px; line-height: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }',
        '._dsh_ofb_chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
        '._dsh_ofb_chip_on, ._dsh_ofb_chip_on:hover { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); color: var(--dsw-alias-state-business-primary); font-weight: 500; }',
        // 「使用」按钮：表格里每把 Key 一个（与模型芯片同款胶囊，但更窄——列宽有限）。
        // 选中态与芯片选中态同一语义色，一眼能看出哪把在「使用中」。
        '._dsh_ofb_usebtn { display: inline-flex; align-items: center; justify-content: center; max-width: 100%; height: 22px; padding: 0 9px; border: .5px solid var(--dsw-alias-border-l4); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); font: inherit; font-size: 12px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }',
        '._dsh_ofb_usebtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
        '._dsh_ofb_usebtn:disabled { opacity: .5; cursor: default; }',
        '._dsh_ofb_usebtn_on, ._dsh_ofb_usebtn_on:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); color: var(--dsw-alias-state-business-primary); font-weight: 500; }',
        '._dsh_ofb_scroll { overflow-x: auto; }',
        // 固定表格布局 + 百分比列宽 + **表头也裁剪**：列宽按比例跟着容器走，
        // 任何一列内容超出都在自己的格子里显示省略号，绝不越界压到隔壁列。
        // （表头若只有 nowrap 而没有裁剪，窄侧栏里几列标题就会挤成一片。）
        // min-width 只保到「七列都还放得下各自最关键内容」的下限（520px）：再高就会在
        // 窄侧栏里逼出横向滚动条——「使用」列被推到屏幕外，要拖滚动条才看得见。
        '._dsh_ofb_table { width: 100%; min-width: 520px; table-layout: fixed; border-collapse: collapse; font-size: 12.5px; line-height: 18px; }',
        '._dsh_ofb_table th { text-align: left; font-weight: 500; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary, inherit); background: var(--dsw-alias-bg-layer-3); padding: 9px 8px; border-bottom: .5px solid var(--dsw-alias-border-l2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '._dsh_ofb_table td { padding: 9px 8px; border-bottom: .5px solid var(--dsw-alias-border-l2); vertical-align: middle; overflow: hidden; }',
        '._dsh_ofb_table tr:last-child td { border-bottom: none; }',
        '._dsh_ofb_table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }',
        '._dsh_ofb_clip { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '._dsh_ofb_mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }',
        '._dsh_ofb_key_cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }',
        '._dsh_ofb_key_preview { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }',
        '._dsh_ofb_pill { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; height: 20px; border-radius: 999px; font-size: 12px; line-height: 20px; white-space: nowrap; }',
        '._dsh_ofb_pill_ready { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }',
        '._dsh_ofb_pill_cooling { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }',
        // 冷却列：模型单独一行（可省略），倒计时与绝对时刻另起一行，避免挤在一起换行
        '._dsh_ofb_cooling_line { display: flex; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; }',
        '._dsh_ofb_remaining { color: var(--dsw-alias-state-error-primary); font-variant-numeric: tabular-nums; }',
        '._dsh_ofb_nums { font-variant-numeric: tabular-nums; white-space: nowrap; }',
        '._dsh_ofb_model_small { font-size: 11.5px; }',
        // 「上游渠道」列（第一张表，替代原「请求 / Token」列）：不是预期上游时用警示色——
        // 用户关心的就是「这把有没有漂走」。正常值用默认文字色（事实陈述，不需强调）。
        '._dsh_ofb_up_other { color: var(--dsw-alias-state-error-primary, #d4380d); font-weight: 500; }',
        '._dsh_ofb_dim { color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_empty { padding: 24px 16px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_error { padding: 12px 14px; border-radius: 12px; font-size: 13px; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }',
        '._dsh_ofb_section_title { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 14px; line-height: 20px; font-weight: 600; }',
        '._dsh_ofb_recent { display: flex; flex-direction: column; }',
        // 按模型用量卡片：面板恒定在某个模型的筛选下，每把 Key 就一行——Key 预览
        // 占满剩余宽度（可省略），数字与时间右对齐定宽，谁也不会把谁顶走。
        // 模型名不再进这张卡：筛选芯片已经说明了当前看的是哪个模型，重复一遍纯属占宽。
        '._dsh_ofb_usage { display: flex; flex-direction: column; }',
        '._dsh_ofb_usage_head { display: flex; align-items: baseline; gap: 12px; padding: 7px 14px; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary, inherit); border-bottom: .5px solid var(--dsw-alias-border-l2); }',
        '._dsh_ofb_usage_head > span { white-space: nowrap; }',
        '._dsh_ofb_usage_row { display: flex; align-items: center; gap: 12px; padding: 8px 14px; font-size: 12px; line-height: 18px; border-bottom: .5px solid var(--dsw-alias-border-l2); }',
        '._dsh_ofb_usage_row:last-child { border-bottom: none; }',
        '._dsh_ofb_usage_lead { flex: 1 1 auto; min-width: 0; }',
        // 数值一律「一个数一列、各自有标签」：把 2/2/0 拆成 发送|成功|限流 三列、
        // 输入|输出 两列，标签直接压在自己的数字上方。这样每个数字的含义不用猜、
        // 也不靠悬停，而且短标签（2 字）在任何字号下都不会被折行。
        '._dsh_ofb_usage_req { flex: none; width: 176px; display: flex; gap: 6px; font-variant-numeric: tabular-nums; }',
        '._dsh_ofb_usage_req > span, ._dsh_ofb_tokennums > span { flex: 1 1 0; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; }',
        // token 单元：上面一根占比条、下面 输入|输出 两个数字。条长按同卡内最大用量归一到 100%，
        // 段内再按 输入:输出 拆分——「哪把 key 用得多」一眼可比，纯数字做不到。
        '._dsh_ofb_tokencell { flex: none; width: 152px; display: flex; flex-direction: column; gap: 3px; }',
        '._dsh_ofb_tokennums { display: flex; gap: 6px; font-variant-numeric: tabular-nums; }',
        '._dsh_ofb_bar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: var(--dsw-alias-bg-module-platform); }',
        '._dsh_ofb_bar_fill { display: flex; height: 100%; border-radius: 3px; overflow: hidden; min-width: 2px; }',
        '._dsh_ofb_bar_in { background: var(--dsw-alias-state-business-primary); }',
        '._dsh_ofb_bar_out { flex: 1 1 auto; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }',
        '._dsh_ofb_usage_time { flex: none; width: 84px; text-align: right; color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_usage_rest { padding: 8px 14px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_usage_total { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_recent_row { display: flex; align-items: baseline; gap: 10px; padding: 7px 14px; border-bottom: .5px solid var(--dsw-alias-border-l2); font-size: 12.5px; line-height: 18px; }',
        '._dsh_ofb_recent_row:last-child { border-bottom: none; }',
        '._dsh_ofb_recent_time { flex: none; width: 64px; color: var(--dsw-alias-label-tertiary, inherit); font-variant-numeric: tabular-nums; }',
        '._dsh_ofb_recent_model { flex: none; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '._dsh_ofb_recent_decision { min-width: 0; flex: 1 1 auto; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); }',
        '._dsh_ofb_btn_icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }',
        '._dsh_ofb_spin { animation: _dsh-ofb-spin .9s linear infinite; }',
        '@keyframes _dsh-ofb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
        // 统计行里的动作位（版本卡右边）：与统计小卡同高、垂直居中
        '._dsh_ofb_action { display: flex; align-items: center; }',
        '._dsh_ofb_head_actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }',
        // 导入弹窗：遮罩用中性半透明（不依赖具体 token 名），卡片沿用 DSH 的表面与描边
        '._dsh_ofb_overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .38); }',
        '._dsh_ofb_dialog { display: flex; flex-direction: column; gap: 10px; width: min(540px, 100%); max-height: 100%; overflow: auto; padding: 16px; border-radius: 14px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-elevation-stroke), 0 18px 48px rgba(0, 0, 0, .3); }',
        '._dsh_ofb_dialog_title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }',
        '._dsh_ofb_textarea { width: 100%; min-height: 104px; box-sizing: border-box; resize: vertical; padding: 8px 10px; border: .5px solid var(--dsw-alias-border-l4); border-radius: 10px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary, inherit); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; }',
        '._dsh_ofb_textarea:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }',
        '._dsh_ofb_dialog_actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }',
        '._dsh_ofb_import_summary { display: flex; flex-direction: column; gap: 3px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); }',
        '._dsh_ofb_import_ok { color: var(--dsw-alias-state-business-primary); }',
        '._dsh_ofb_import_flat { color: var(--dsw-alias-label-tertiary, inherit); }',
      ].join('\n')
    }

    // ───────────────────────── i18n（跟随 DSH 语言设置） ─────────────────────────
    // 模块级字典是 t() 的真源；同时注册进 DSH 的 locale 注册表，好让座位标签
    // （register 的 `locale: LOCALE_NS`）也走同一套文案。
    var localeService

    var zhDict = {
      nav: 'Cline Key',
      title: 'Cline Key 使用情况',
      refresh: '刷新',
      refreshing: '读取中…',
      updatedAt: '更新于 {time}',
      autoRefresh: '每 5 秒自动刷新',
      statPool: '池内 Key',
      statReadyFor: '该模型可用',
      statCoolingFor: '该模型冷却',
      filterLabel: '按模型查看',
      statRequests: 'Cline 请求',
      statRotations: '换 Key 恢复',
      statFailFasts: '快速失败',
      statVersion: '插件版本',
      importKey: '导入 Key',
      importTitle: '导入 Cline Key',
      importHint: '一行一把，也可用空格 / 逗号分隔。写入凭据仓库的空闲槽位（CLINE_API_KEY_2 ~ _10），池内已存在的自动跳过；导入后立刻参与轮换。',
      importPlaceholder: 'sk_...',
      importConfirm: '导入',
      importCancel: '取消',
      importBusy: '导入中…',
      importEmpty: '请先粘贴至少一把 Key',
      importImported: '已导入 {n} 把',
      importDuplicates: '跳过 {n} 把（池内已存在）',
      importRejected: '忽略 {n} 条（格式不符）',
      importFailed: '写入失败 {n} 把',
      importRefsLeft: '剩余空闲槽位 {n} 个',
      importRefsUnknown: '{n} 个槽位状态不明（凭据服务暂时读不出），已跳过：{refs}',
      importNoRefs: '空闲槽位已满：请先把不用的 CLINE_API_KEY_n 从凭据里删掉',
      reasonTooShort: '太短',
      reasonTooLong: '太长',
      reasonUnsupportedChars: '含控制字符',
      reasonNoFreeRef: '没有空闲槽位',
      reasonOverLimit: '超出单次上限',
      statsSince: '统计自 {time} 起累计 · 跨重启保留',
      resetStats: '重置统计',
      resetConfirm: '确认重置',
      resetBusy: '重置中…',
      resetDone: '统计已重置',
      resetFailed: '重置失败：{message}',
      colIndex: '#',
      colKey: 'Key',
      colStatus: '状态',
      colCooling: '冷却 / 恢复',
      colUsage: '上游渠道',
      colUpstreamNone: '—',
      colUpstreamTitle: '这把 Key 在**当前模型**上最近一次实际走的上游（网关汇报）。同一模型的上游可能逐次不同，所以每把 Key 各记各的；没观测到就是「—」，不猜。',
      colLastUsed: '最近使用',
      colUse: '使用',
      useSet: '使用',
      useActive: '使用中',
      useHint: '选定后本模型的首发送优先使用这把 Key；撞限流仍照常换 Key 重发',
      useClearHint: '点击取消选定（本模型的首发送回到 DSH 配置的 Key）',
      useMissing: '本模型选定的 Key 已不在池中（首发送回到 DSH 配置的 Key）',
      useNoModel: '还不知道有哪些模型：先发一次请求再选',
      selectFailed: '切换失败：{message}',
      pillReady: '可用',
      pillCooling: '冷却中',
      never: '从未',
      none: '—',
      emptyTitle: '还没有捕获到 Cline Key',
      emptyHint: '当 DSH 发出第一个 Cline 请求（或从 .credentials.yaml 读到额外 Key）后，这里会列出池内的每一把 Key。',
      errorTitle: '读取 Key 池状态失败：{message}',
      recentTitle: '最近决策',
      recentEmpty: '暂无请求记录',
      usageTitle: '按模型用量',
      usageColSent: '发送',
      usageColOk: '成功',
      usageColFailed: '失败',
      usageColLimited: '限流',
      usageColInput: '输入',
      usageColCache: '缓存命中',
      tokenExact: '输入 {input} / 输出 {output}',
      cacheExact: '缓存命中 {cached} / 输入 {input}',
      cacheNone: '—',
      cacheTitle: '输入侧缓存命中率 = 缓存命中 token ÷ 输入 token（累计，按 token 加权）。命中率高说明长上下文大多按缓存计价、更省额度；换 Key 或换上游后若明显掉下来，就是缓存没接上。',
      cacheTitleNone: '这个模型上还没有带 token 的请求，算不出命中率（显示「—」而不是 0%）。',
      usageTotal: '合计',
      usageRestScoped: '其余 {n} 把在该模型上没用过',
      usageEmpty: '还没有按模型的用量记录',
      agoSeconds: '{n} 秒前',
      agoMinutes: '{n} 分钟前',
      agoHours: '{n} 小时前',
      importRefJoin: '、',
    }

    var enDict = {
      nav: 'Cline Keys',
      title: 'Cline key usage',
      refresh: 'Refresh',
      refreshing: 'Loading…',
      updatedAt: 'updated {time}',
      autoRefresh: 'auto-refresh every 5s',
      statPool: 'Keys in pool',
      statReadyFor: 'Ready for model',
      statCoolingFor: 'Cooling on model',
      filterLabel: 'By model',
      statRequests: 'Cline requests',
      statRotations: 'Rotations',
      statFailFasts: 'Fail-fasts',
      statVersion: 'Plugin version',
      importKey: 'Import keys',
      importTitle: 'Import Cline keys',
      importHint: 'One key per line (spaces or commas also work). They are stored in the free credential slots (CLINE_API_KEY_2 ~ _10); keys already in the pool are skipped, and new ones rotate immediately.',
      importPlaceholder: 'sk_...',
      importConfirm: 'Import',
      importCancel: 'Cancel',
      importBusy: 'Importing…',
      importEmpty: 'Paste at least one key first',
      importImported: 'Imported {n}',
      importDuplicates: 'Skipped {n} (already in the pool)',
      importRejected: 'Ignored {n} (bad format)',
      importFailed: 'Failed to store {n}',
      importRefsLeft: '{n} free slot(s) left',
      importRefsUnknown: '{n} slot(s) skipped — state unknown (the credentials service could not read them): {refs}',
      importNoRefs: 'No free slots left: remove an unused CLINE_API_KEY_n from the credentials first',
      reasonTooShort: 'too short',
      reasonTooLong: 'too long',
      reasonUnsupportedChars: 'control characters',
      reasonNoFreeRef: 'no free slot',
      reasonOverLimit: 'over the per-import limit',
      statsSince: 'Counted since {time} · kept across restarts',
      resetStats: 'Reset stats',
      resetConfirm: 'Confirm reset',
      resetBusy: 'Resetting…',
      resetDone: 'Stats reset',
      resetFailed: 'Reset failed: {message}',
      colIndex: '#',
      colKey: 'Key',
      colStatus: 'Status',
      colCooling: 'Cooling / reset',
      colUsage: 'Upstream',
      colUpstreamNone: '—',
      colUpstreamTitle: 'The upstream this key actually used most recently on the **current model** (as reported by the gateway). Upstreams can differ per request, so each key keeps its own record; “—” means nothing observed yet — never guessed.',
      colLastUsed: 'Last used',
      colUse: 'Use',
      useSet: 'Use',
      useActive: 'In use',
      useHint: 'The first send for this model uses this key; rotation on rate limit is unchanged',
      useClearHint: 'Click to clear (this model falls back to the key configured in DSH)',
      useMissing: 'The key selected for this model is no longer in the pool (the first send falls back to the DSH key)',
      useNoModel: 'No model known yet — send a request first',
      selectFailed: 'Switch failed: {message}',
      pillReady: 'ready',
      pillCooling: 'cooling',
      never: 'never',
      none: '—',
      emptyTitle: 'No Cline key captured yet',
      emptyHint: 'Once DSH sends its first Cline request (or extra keys are read from .credentials.yaml), every key in the pool is listed here.',
      errorTitle: 'Failed to read the key pool: {message}',
      recentTitle: 'Recent decisions',
      recentEmpty: 'No request recorded yet',
      usageTitle: 'Usage by model',
      usageColSent: 'Sent',
      usageColOk: 'OK',
      usageColFailed: 'Failed',
      usageColLimited: 'Limited',
      usageColInput: 'In',
      usageColCache: 'Cache hit',
      tokenExact: 'In {input} / Out {output}',
      cacheExact: 'Cache hit {cached} / input {input}',
      cacheNone: '—',
      cacheTitle: 'Input-side cache hit rate = cached tokens ÷ input tokens (cumulative, token-weighted). A high rate means long context is mostly billed as cache, saving quota; a drop after switching key or upstream means the cache did not carry over.',
      cacheTitleNone: 'No token-bearing request on this model yet, so no rate can be computed (shown as “—” rather than 0%).',
      usageTotal: 'Total',
      usageRestScoped: '{n} more key(s) unused on this model',
      usageEmpty: 'No per-model usage recorded yet',
      agoSeconds: '{n}s ago',
      agoMinutes: '{n}m ago',
      agoHours: '{n}h ago',
      importRefJoin: ', ',
    }

    /** 当前语言是否中文；locale 服务缺失时退回浏览器语言。 */
    function isZh() {
      var active = ''
      try {
        active = localeService ? String(localeService.getSnapshot().active || '') : ''
      } catch {
        active = ''
      }
      if (!active) active = String(navigator.language || '')
      return active.toLowerCase().indexOf('zh') === 0
    }

    /** 取一条文案；`{name}` 占位符由 params 插值。 */
    function t(key, params) {
      var dict = isZh() ? zhDict : enDict
      var text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
      if (params) {
        for (var name in params) {
          if (Object.prototype.hasOwnProperty.call(params, name)) {
            text = text.split('{' + name + '}').join(String(params[name]))
          }
        }
      }
      return text
    }

    // ───────────────────────── 格式化 ─────────────────────────
    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    /** 面板顶部「更新于 HH:MM:SS」。 */
    function clockOf(ts) {
      if (!ts) return '—'
      var d = new Date(ts)
      if (isNaN(d.getTime())) return '—'
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    }

    /** 冷却恢复时刻：短格式日期 + 时分。 */
    function stampOf(ts) {
      if (!ts) return '—'
      var d = new Date(ts)
      if (isNaN(d.getTime())) return '—'
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    /** 剩余时间：1d3h / 5h12m / 42m，语言无关。 */
    function remainingOf(readyAt) {
      var ms = Number(readyAt) - Date.now()
      if (!isFinite(ms) || ms <= 0) return ''
      var totalMin = Math.max(1, Math.round(ms / 60000))
      var days = Math.floor(totalMin / 1440)
      var hours = Math.floor((totalMin % 1440) / 60)
      var minutes = totalMin % 60
      if (days > 0) return days + 'd' + hours + 'h'
      if (hours > 0) return hours + 'h' + pad2(minutes) + 'm'
      return minutes + 'm'
    }

    /** 模型短名：去掉 `provider/` 前缀，好让它在窄列里完整可读；完整名由 title 承载。 */
    function shortModel(model) {
      var text = model ? String(model) : ''
      var at = text.lastIndexOf('/')
      return at >= 0 && at < text.length - 1 ? text.slice(at + 1) : text
    }

    /** Token 数压缩显示：1234 → 1.2k，12300 → 12.3k，1234567 → 1.23M。 */
    function formatTokens(value) {
      var n = Number(value) || 0
      if (n < 1000) return String(n)
      if (n < 1000000) {
        var k = n / 1000
        // 十万以内保留一位小数（12.3k），再大就取整（123k）；整数不留 .0
        return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))) + 'k'
      }
      return (n / 1000000).toFixed(2) + 'M'
    }

    /** 「输入/输出」两个 token 数。 */
    function tokenPair(tokens) {
      var row = tokens || {}
      return formatTokens(row.input) + '/' + formatTokens(row.output)
    }

    /** 「最近使用」的相对时间。 */
    function agoOf(ts) {
      if (!ts) return t('never')
      var sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
      if (sec < 60) return t('agoSeconds', { n: sec })
      var min = Math.round(sec / 60)
      if (min < 60) return t('agoMinutes', { n: min })
      return t('agoHours', { n: Math.round(min / 60) })
    }

    // ───────────────────────── 数据获取 ─────────────────────────
    /**
     * 轮询主机端只读路由（写路由不参与轮询）。返回 [state, reload]：
     *   state.phase 为 'loading' | 'ready' | 'error'；
     *   state.data 保留上一次成功的数据，所以一次网络抖动不会把面板清空。
     */
    function useStatus() {
      var [state, setState] = React.useState({ phase: 'loading', data: null, error: '', at: 0 })
      var [nonce, setNonce] = React.useState(0)

      React.useEffect(
        function () {
          var alive = true
          // 上一次响应的 ETag。带上它做条件请求：载荷没变时主机端回 304，
          // 省掉整份 JSON 的传输与解析——而 5 秒一轮的轮询里绝大多数轮次都没变。
          // 放在 effect 闭包里（而不是 ref）：重新订阅时本来就该重新校验一次。
          var etag = ''
          function load() {
            // 页面不可见时不轮询（设置页开着但切走了）
            if (typeof document !== 'undefined' && document.hidden) return
            var headers = { accept: 'application/json' }
            if (etag) headers['if-none-match'] = etag
            fetch(ROUTE, { headers: headers, cache: 'no-store' })
              .then(function (res) {
                // 304：内容没变，沿用手里那份数据，只把「更新于」的时间往前推
                if (res.status === 304) return { notModified: true }
                if (!res.ok) throw new Error('HTTP ' + res.status)
                var next = res.headers.get('etag')
                if (next) etag = next
                return res.json().then(function (data) { return { data: data } })
              })
              .then(function (result) {
                if (!alive) return
                if (result.notModified) {
                  // 不能把 data 置空：304 的语义就是「继续用你手里那份」
                  setState(function (prev) {
                    return { phase: prev.data ? 'ready' : prev.phase, data: prev.data, error: '', at: Date.now() }
                  })
                  return
                }
                setState({ phase: 'ready', data: result.data, error: '', at: Date.now() })
              })
              .catch(function (error) {
                if (!alive) return
                var message = error && error.message ? error.message : String(error)
                setState(function (prev) {
                  return { phase: prev.data ? 'ready' : 'error', data: prev.data, error: message, at: Date.now() }
                })
              })
          }
          load()
          var timer = setInterval(load, REFRESH_MS)
          return function () {
            alive = false
            clearInterval(timer)
          }
        },
        [nonce],
      )

      return [state, function () { setNonce(function (n) { return n + 1 }) }]
    }

    // ───────────────────────── 子组件 ─────────────────────────
    function Stat(props) {
      return createElement('div', { className: '_dsh_ofb_stat' },
        createElement('span', { className: '_dsh_ofb_stat_value' }, String(props.value)),
        createElement('span', { className: '_dsh_ofb_stat_label' }, props.label),
      )
    }

    function RefreshIcon(props) {
      return createElement('svg', {
        className: props && props.spinning ? '_dsh_ofb_btn_icon _dsh_ofb_spin' : '_dsh_ofb_btn_icon',
        viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        createElement('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9' }),
        createElement('path', { d: 'M13.5 2.5V5H11' }),
      )
    }

    /** 一把 key 的状态药丸。冷却判定只看**当前筛选的模型**：
     *  在 deepseek 上被限、在 glm 上健康，是常态而不是异常——把两者混在一起显示
     *  会让人以为这把 key 彻底不能用了。 */
    function StatusPill(props) {
      var cooling = props.cooling && props.cooling.length > 0
      return createElement('span', {
        className: cooling ? '_dsh_ofb_pill _dsh_ofb_pill_cooling' : '_dsh_ofb_pill _dsh_ofb_pill_ready',
      }, cooling ? t('pillCooling') : t('pillReady'))
    }

    /** 按模型查看的筛选条：只列模型本身。
     *  没有「全部模型」选项——冷却与用量都是 `key + 模型` 维度，把两个模型的数字
     *  合并起来既读不出「这把 key 现在到底能不能用」，也让同一行里混着不同模型的
     *  可用性；所以面板恒定处在「某个模型」的视图下。
     *
     *  芯片上**不再挂上游徽标**：上游已经按 key 显示在 Key 表的「上游渠道」列里，
     *  芯片上再标一次是同一个信息重复出现（用户指出后移除）。芯片只负责选模型。 */
    function ModelFilter(props) {
      var models = props.models || []
      var active = props.active
      if (models.length === 0) return null
      return createElement('div', { className: '_dsh_ofb_filters' },
        createElement('span', { className: '_dsh_ofb_filter_label' }, t('filterLabel')),
        models.map(function (row) {
          return createElement('button', {
            key: row.id,
            type: 'button',
            title: row.id,
            'aria-pressed': row.id === active ? 'true' : 'false',
            className: row.id === active ? '_dsh_ofb_chip _dsh_ofb_chip_on' : '_dsh_ofb_chip',
            onClick: function () { props.onChange(row.id) },
          }, shortModel(row.id))
        }),
      )
    }

    /** 冷却列：面板恒定按某个模型看，所以一把 key 在这里最多只有一条记录，
     *  只显示「倒计时 + 恢复时刻」即可——是哪个模型由上面的筛选条决定，
     *  模型名再重复一遍纯属占宽（完整模型名在筛选芯片的 title 里）。 */
    function CoolingCell(props) {
      var row = (props.cooling || [])[0]
      if (!row) return createElement('span', { className: '_dsh_ofb_dim' }, t('none'))
      var remaining = remainingOf(row.readyAt)
      return createElement('span', { className: '_dsh_ofb_cooling_line' },
        remaining ? createElement('span', { className: '_dsh_ofb_remaining' }, remaining) : null,
        createElement('span', { className: '_dsh_ofb_dim' }, stampOf(row.readyAt)),
      )
    }

    /** 表格列宽（固定布局，百分比）：按比例跟着容器走，窄侧栏里每一列都还能放下
     *  自己的最关键内容（序号一位、掩码预览 9 个字符、状态药丸、冷却倒计时、
     *  三位数用量、相对时间、「使用」按钮两三个字）。
     *  Key 列只放 9 个字符的掩码，给多了就是它和「状态」之间那片空白——这是本次
     *  把 20% 收紧到 17% 的原因（列宽按百分比分配，窄容器里会等比缩，所以每列都必须够用）。
     *  表头同样带裁剪，所以列再窄也只是自己显示省略号，不会挤到隔壁列身上。
     *  容器低于 min-width(520px) 时才退回横向滚动。
     *  注意：第 5 列从「请求 / Token」改成了「上游渠道」（用户要求移除用量列），宽度不变；
     *  上游名最长如 togetherai / deepinfra，14% 放得下，超长由裁剪类处理。 */
    var COLUMN_WIDTHS = ['5%', '17%', '13%', '22%', '14%', '14%', '15%']

    /** 行内「使用」按钮：把某把 Key 设为**当前模型**上「使用中」的那把（首发送优先用它）。
     *  再点一次已选中的那把＝取消（该模型的首发送回到 DSH 配置的 Key）。
     *  选定按模型独立——按钮作用于面板当前筛选的那个模型。 */
    function UseButton(props) {
      var noModel = !props.model
      return createElement('button', {
        type: 'button',
        className: props.active ? '_dsh_ofb_usebtn _dsh_ofb_usebtn_on' : '_dsh_ofb_usebtn',
        'aria-pressed': props.active ? 'true' : 'false',
        // 还不知道有哪些模型时选不了：选定必须落在某个模型上，否则就是一次注定 400 的请求
        disabled: Boolean(props.busy) || noModel,
        title: noModel ? t('useNoModel') : props.active ? t('useClearHint') : t('useHint'),
        // onClick 直接返回 promise：自检点一下就能 await 到这次 POST 完成（与导入弹窗同款写法）
        onClick: function () { return props.onSelect(props.label, props.active) },
      }, props.active ? t('useActive') : t('useSet'))
    }

    function KeyTable(props) {
      var keys = props.keys || []
      if (keys.length === 0) {
        return createElement('div', { className: '_dsh_ofb_card' },
          createElement('div', { className: '_dsh_ofb_empty' },
            createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('emptyTitle')),
            createElement('div', null, t('emptyHint')),
          ),
        )
      }
      var colgroup = createElement('colgroup', null,
        COLUMN_WIDTHS.map(function (width, index) {
          return createElement('col', { key: index, style: { width: width } })
        }),
      )
      var head = createElement('thead', null,
        createElement('tr', null,
          createElement('th', null, t('colIndex')),
          createElement('th', null, t('colKey')),
          createElement('th', null, t('colStatus')),
          createElement('th', null, t('colCooling')),
          createElement('th', null, t('colUsage')),
          createElement('th', null, t('colLastUsed')),
          createElement('th', null, t('colUse')),
        ),
      )
      // 面板恒定处在「某个模型」的视图下（筛选条没有「全部模型」），所以状态/冷却/
      // 用量/最近使用一律只看该模型；没有模型可筛时 activeModel 为空字符串，
      // 于是每把 key 都显示「可用 / — / 0 0 0 / 从未」，这也是准确的（什么都没发生过）。
      var activeModel = props.activeModel || ''
      // 选定的「使用中」Key（载荷里只有 8 位标签）：只用来给对应那行点亮按钮
      var selectionLabel = props.selection || ''
      // 预期上游（主机端按模型下发，来自**配置**而非观测）：只给「不是它」的值加警示色——
      // 用户关心的就是「这把有没有漂走」。它不代表插件做过任何干预（插件不干预路由）。
      var preferred = props.preferred || ''
      var body = createElement('tbody', null,
        keys.map(function (key) {
          var cooling = (key.cooling || []).filter(function (row) { return row.model === activeModel })
          var modelRow = (key.models || {})[activeModel]
          // 上游渠道：这把 Key 在**当前模型**上最近一次实际走的上游。
          // 逐 key 各记各的（主机端按 key+模型记，不是拿模型维度的结论复制给每行——
          // 那看着像事实、其实是编的）。没观测到就是空串 → 显示「—」，绝不猜一个名字。
          var upstream = (modelRow && modelRow.upstream && modelRow.upstream.provider) || ''
          // 「最近使用」也只看该模型：从没在该模型上跑过就老老实实显示「从未」
          var lastUsedAt = modelRow ? modelRow.lastUsedAt : 0
          return createElement('tr', { key: key.label || String(key.index) },
            createElement('td', { className: '_dsh_ofb_dim' }, String(key.index)),
            createElement('td', null,
              createElement('div', { className: '_dsh_ofb_key_cell' },
                // 只显示掩码预览，不再显示 8 位哈希标签：标签是内部标识（日志与额度状态
                // 文件用它索引），对「认出这是哪把 Key」没有帮助，摆在面板上只是噪音。
                // 不拿标签当 preview 为空时的兜底——那等于把刚移除的东西又放回来；
                // 关掉 maskKeyPreview 时这一格就是「—」，每把 Key 仍由 # 列区分。
                createElement('span', { className: '_dsh_ofb_clip _dsh_ofb_key_preview' }, key.preview || t('none')),
              ),
            ),
            createElement('td', null, createElement(StatusPill, { cooling: cooling })),
            createElement('td', null, createElement(CoolingCell, { cooling: cooling })),
            createElement('td', null,
              createElement('span', {
                className: '_dsh_ofb_clip' + (upstream && upstream !== preferred ? ' _dsh_ofb_up_other' : ''),
                title: t('colUpstreamTitle'),
              }, upstream || t('colUpstreamNone')),
            ),
            createElement('td', null,
              // 只显示相对时间：模型名放进 title（悬停可见）。模型名有 30 多个字符，
              // 放在这一列会把列撑宽、把行撑高，而筛选条已经能按模型分别查看了。
              createElement('span', { className: '_dsh_ofb_clip', title: activeModel }, agoOf(lastUsedAt)),
            ),
            createElement('td', null,
              createElement(UseButton, {
                label: key.label,
                active: Boolean(key.label) && key.label === selectionLabel,
                // 选定落在「当前模型」上：按钮要知道自己是在给哪个模型选
                model: activeModel,
                busy: props.busy,
                onSelect: props.onSelect,
              }),
            ),
          )
        }),
      )
      return createElement('div', { className: '_dsh_ofb_card' },
        createElement('div', { className: '_dsh_ofb_scroll' },
          createElement('table', { className: '_dsh_ofb_table' }, colgroup, head, body),
        ),
      )
    }

    /** 输入侧的缓存命中率：`cached / input`（两者都是输入 token 的细分，cached ⊂ input）。
     *
     *  分母刻意不用 total：那会把输出也算进去、系统性压低命中率。
     *  累计比值天然是「按 token 加权平均」，正是想看的量。input 为 0（该模型上还没跑过）
     *  返回 null —— 面板显示「—」，而不是把「没有数据」呈现成「命中率 0%」。
     *  夹在 [0,1]：上报异常时不能把面板弄出个 >100%。 */
    function cacheRateOf(tokens) {
      var input = Number((tokens || {}).input) || 0
      var cached = Number((tokens || {}).cached) || 0
      if (input <= 0) return null
      return Math.min(1, Math.max(0, cached / input))
    }

    /** Token 单元：占比条 + 「输入 | 缓存命中%」两个数字。
     *
     *  条的**长度**按同卡内最大输入量归一（「哪把 key 用得多」一眼可比，纯数字做不到）；
     *  条的**内部分段**是「缓存命中 : 未命中」——这是把「输出」列换成「缓存命中%」
     *  后的新语义：一眼看出这把 key 的长上下文有多少是按缓存计价的。
     *
     *  命中率直接从 tokens 算（原始数就在载荷里，不额外下发派生字段）。 */
    function TokenCacheCell(props) {
      var tokens = props.tokens || {}
      var input = Number(tokens.input) || 0
      var cached = Number(tokens.cached) || 0
      var rate = cacheRateOf(tokens)
      var scale = props.maxInput > 0 ? Math.min(1, input / props.maxInput) : 0
      // 悬停提示跟随语言（走词典，避免英文界面冒出中文）
      var exact = t('tokenExact', { input: input, output: Number(tokens.output) || 0 })
      var cacheTip = rate === null
        ? t('cacheTitleNone')
        : t('cacheExact', { cached: cached, input: input }) + ' · ' + t('cacheTitle')
      return createElement('div', { className: '_dsh_ofb_tokencell' },
        createElement('div', { className: '_dsh_ofb_bar', title: cacheTip },
          input > 0
            ? createElement('div', { className: '_dsh_ofb_bar_fill', style: { width: (scale * 100).toFixed(1) + '%' } },
                createElement('div', { className: '_dsh_ofb_bar_in', style: { width: (rate * 100).toFixed(1) + '%' } }),
                createElement('div', { className: '_dsh_ofb_bar_out' }),
              )
            : null,
        ),
        createElement('div', { className: '_dsh_ofb_tokennums' },
          createElement('span', { title: exact }, formatTokens(input)),
          createElement('span', { title: cacheTip }, rate === null ? t('cacheNone') : Math.round(rate * 100) + '%'),
        ),
      )
    }

    /** 按模型用量明细：每把 Key 一行，列出它在**当前模型**上的实际用量（请求 + token）。
     *  面板恒定在某个模型的筛选下（筛选条没有「全部模型」），模型名写在筛选芯片上就够了，
     *  这里再列一遍纯属占宽——所以每行就是 Key 预览 + 哈希标签 + 数字。在该模型上
     *  没用过的 key 折叠成一行提示，避免半张卡都是「没用过」。 */
    function UsageByModel(props) {
      var keys = props.keys || []
      var activeModel = props.activeModel || ''
      var blocks = []
      var unused = 0
      keys.forEach(function (key) {
        var models = key.models || {}
        var list = Object.keys(models)
          .filter(function (model) { return model === activeModel })
          .sort(function (a, b) { return (models[b].lastUsedAt || 0) - (models[a].lastUsedAt || 0) })
        if (list.length) blocks.push({ key: key, models: list })
        else unused += 1
      })

      // 归一化基准与合计都按「当前显示出来的行」算。
      // 条长按**输入量**归一（不再按 input+output）：这一列现在讲的是输入侧的缓存效率，
      // 条长就该对应输入规模。
      var maxInput = 1
      var sum = { sent: 0, ok: 0, failed: 0, limited: 0, input: 0, output: 0, cached: 0 }
      blocks.forEach(function (block) {
        block.models.forEach(function (model) {
          var stat = block.key.models[model] || {}
          var tokens = stat.tokens || {}
          maxInput = Math.max(maxInput, Number(tokens.input) || 0)
          sum.sent += Number(stat.sent) || 0
          sum.ok += Number(stat.ok) || 0
          sum.failed += Number(stat.failed) || 0
          sum.limited += Number(stat.limited) || 0
          sum.input += Number(tokens.input) || 0
          sum.output += Number(tokens.output) || 0
          sum.cached += Number(tokens.cached) || 0
        })
      })
      // 合计行的命中率与每行同口径（cached / input 的累计比值）；无输入时显示「—」
      var sumCache = sum.input > 0 ? Math.round((sum.cached / sum.input) * 100) + '%' : t('cacheNone')

      var title = createElement('div', { className: '_dsh_ofb_head', style: { minHeight: 0 } },
        createElement('h3', { className: '_dsh_ofb_section_title', style: { margin: 0 } }, t('usageTitle')),
        blocks.length
          ? createElement('span', { className: '_dsh_ofb_caption _dsh_ofb_usage_total' },
              t('usageTotal') + ' ' + sum.sent + '/' + sum.ok + '/' + sum.failed + '/' + sum.limited + ' · ' + formatTokens(sum.input) + '/' + formatTokens(sum.output) + ' · ' + t('usageColCache') + ' ' + sumCache)
          : null,
      )

      var body
      if (blocks.length === 0) {
        body = createElement('div', { className: '_dsh_ofb_card' },
          createElement('div', { className: '_dsh_ofb_empty' }, t('usageEmpty')),
        )
      } else {
        var items = [
          // 表头与数据行用同一套单元格类：三个请求数、两个 token 数各自一列，
          // 标签就压在自己的数字上方，含义不用猜、也不靠悬停。
          createElement('div', { key: 'head', className: '_dsh_ofb_usage_head' },
            createElement('span', { className: '_dsh_ofb_usage_lead' }, t('colKey')),
            createElement('span', { className: '_dsh_ofb_usage_req' },
              createElement('span', null, t('usageColSent')),
              createElement('span', null, t('usageColOk')),
              createElement('span', null, t('usageColFailed')),
              createElement('span', null, t('usageColLimited')),
            ),
            createElement('span', { className: '_dsh_ofb_tokencell' },
              createElement('span', { className: '_dsh_ofb_tokennums' },
                createElement('span', null, t('usageColInput')),
                createElement('span', { title: t('cacheTitle') }, t('usageColCache')),
              ),
            ),
            createElement('span', { className: '_dsh_ofb_usage_time' }, t('colLastUsed')),
          ),
        ]
        blocks.forEach(function (block) {
          // 筛选条决定了这张卡只看一个模型，所以每把 Key 恰好一行——
          // key 标识与它的数字合成一行，不再先标题行、再模型行地摊开。
          var model = block.models[0]
          var stat = block.key.models[model] || {}
          items.push(
            createElement('div', { key: block.key.label, className: '_dsh_ofb_usage_row' },
              createElement('span', { className: '_dsh_ofb_dim' }, String(block.key.index)),
              // Key 列只有掩码预览（哈希标签已从面板移除，见表格 Key 单元格的说明）。
              // `_dsh_ofb_usage_lead` 必须留在这一格上：它负责占满剩余宽度，
              // 挪走或删掉会让后面几列不再右对齐。
              createElement('span', { className: '_dsh_ofb_clip _dsh_ofb_mono _dsh_ofb_usage_lead' }, block.key.preview || t('none')),
              createElement('span', { className: '_dsh_ofb_usage_req' },
                createElement('span', null, String(stat.sent || 0)),
                createElement('span', null, String(stat.ok || 0)),
                createElement('span', null, String(stat.failed || 0)),
                createElement('span', null, String(stat.limited || 0)),
              ),
              createElement(TokenCacheCell, { tokens: stat.tokens, maxInput: maxInput }),
              createElement('span', { className: '_dsh_ofb_usage_time' }, agoOf(stat.lastUsedAt)),
            ),
          )
        })
        if (unused > 0) {
          items.push(createElement('div', { key: 'rest', className: '_dsh_ofb_usage_rest' },
            t('usageRestScoped', { n: unused })))
        }
        body = createElement('div', { className: '_dsh_ofb_card' },
          createElement('div', { className: '_dsh_ofb_usage' }, items),
        )
      }

      return createElement('div', null, title, body)
    }

    function RecentList(props) {
      var recent = props.recent || []
      var rows = recent.slice().reverse()
      return createElement('div', null,
        createElement('h3', { className: '_dsh_ofb_section_title' }, t('recentTitle')),
        createElement('div', { className: '_dsh_ofb_card' },
          rows.length === 0
            ? createElement('div', { className: '_dsh_ofb_empty' }, t('recentEmpty'))
            : createElement('div', { className: '_dsh_ofb_recent' },
                rows.map(function (row, index) {
                  return createElement('div', { key: index, className: '_dsh_ofb_recent_row' },
                    createElement('span', { className: '_dsh_ofb_recent_time' }, clockOf(Date.parse(row.at))),
                    createElement('span', { className: '_dsh_ofb_recent_model', title: row.model }, row.model || t('none')),
                    createElement('span', { className: '_dsh_ofb_recent_decision' }, row.decision || ''),
                  )
                }),
              ),
        ),
      )
    }

    /** 「导入 Key」按钮：只负责开弹窗；开关状态挂在面板根组件上，
     *  这样弹窗的开关与 5 秒轮询各管各的，谁也不重置谁。 */
    function ImportButton(props) {
      return createElement('div', { className: '_dsh_ofb_action' },
        createElement(Button, {
          variant: 'outline',
          title: t('importHint'),
          onClick: props.onClick,
          icon: createElement(PlusIcon, null),
        }, t('importKey')),
      )
    }

    function PlusIcon() {
      return createElement('svg', {
        className: '_dsh_ofb_btn_icon', viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': 'true',
      },
        createElement('path', { d: 'M8 3.5v9' }),
        createElement('path', { d: 'M3.5 8h9' }),
      )
    }

    /** 主机端给的原因码 → 文案。未知码原样显示：吞掉它只会让排查更难。 */
    function reasonText(code) {
      var map = {
        'too-short': 'reasonTooShort',
        'too-long': 'reasonTooLong',
        'unsupported-chars': 'reasonUnsupportedChars',
        'no-free-ref': 'reasonNoFreeRef',
        'over-limit': 'reasonOverLimit',
      }
      var key = map[String(code)]
      return key ? t(key) : String(code || '')
    }

    /** 导入结果摘要：一行一类。成功那行顺带列出落到的 ref——用户真正想知道的就是这个。
     *  所有文字都来自主机端的摘要（ref / 标签 / 掩码 / 原因码），面板不再加工 Key 材料。 */
    function importSummary(data) {
      var rows = []
      var imported = data.imported || []
      if (imported.length) {
        rows.push(createElement('div', { key: 'ok', className: '_dsh_ofb_import_ok' },
          t('importImported', { n: imported.length }) + ' · ' + imported.map(function (row) { return row.ref }).join(t('importRefJoin')),
        ))
      }
      var duplicates = data.duplicates || []
      if (duplicates.length) {
        rows.push(createElement('div', { key: 'dup' }, t('importDuplicates', { n: duplicates.length })))
      }
      var rejected = data.rejected || []
      if (rejected.length) {
        rows.push(createElement('div', { key: 'rej' }, t('importRejected', { n: rejected.length }) + ' · ' +
          rejected.slice(0, 4).map(function (row) { return (row.preview || t('none')) + ' ' + reasonText(row.reason) }).join('；')))
      }
      var failed = data.failed || []
      if (failed.length) {
        rows.push(createElement('div', { key: 'fail' }, t('importFailed', { n: failed.length }) + ' · ' +
          failed.map(function (row) { return row.ref + ' ' + row.message }).join('；')))
      }
      rows.push(createElement('div', { key: 'refs', className: '_dsh_ofb_import_flat' },
        Number(data.refsFree) > 0 ? t('importRefsLeft', { n: data.refsFree }) : t('importNoRefs')))
      // 状态不明的槽位（凭据服务抖动读不出）：主机端已跳过它们，这里说明为什么没往里写
      var refsUnknown = data.refsUnknown || []
      if (refsUnknown.length) {
        rows.push(createElement('div', { key: 'unknown', className: '_dsh_ofb_import_flat' },
          t('importRefsUnknown', { n: refsUnknown.length, refs: refsUnknown.join(t('importRefJoin')) })))
      }
      return createElement('div', { className: '_dsh_ofb_import_summary' }, rows)
    }

    /** 导入弹窗：粘贴 → POST → 摘要。
     *  submit 直接挂在 onClick 上（async 函数的返回值 React 会忽略），这样自检里能 await 它，
     *  断言「点一下确实发出了一次 POST」。失败只影响这一次导入，绝不动面板轮询。 */
    function ImportDialog(props) {
      var [text, setText] = React.useState('')
      var [busy, setBusy] = React.useState(false)
      var [result, setResult] = React.useState(null)
      var [error, setError] = React.useState('')

      function close() {
        if (busy) return
        if (props.onClose) props.onClose()
      }

      // Esc 关闭。面板 platform 是 web，document 必然存在且完整，所以不再为
      // 「document 缺失 / 没有 addEventListener」留分支——那种宿主本来也渲染不出面板。
      React.useEffect(function () {
        if (!props.open) return undefined
        function onKey(event) {
          if (event && event.key === 'Escape') close()
        }
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('keydown', onKey)
        }
      }, [props.open, busy])

      async function submit() {
        if (busy) return
        var payload = String(text || '').trim()
        if (!payload) {
          setError(t('importEmpty'))
          setResult(null)
          return
        }
        setBusy(true)
        setError('')
        try {
          var res = await fetch(IMPORT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ keys: payload }),
          })
          var data = null
          try { data = await res.json() } catch (parseError) { data = null }
          if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
          setResult(data)
          setText('')
          if (props.onDone) props.onDone()
        } catch (requestError) {
          setResult(null)
          setError(requestError && requestError.message ? requestError.message : String(requestError))
        } finally {
          setBusy(false)
        }
      }

      if (!props.open) return null
      return createElement('div', {
        className: '_dsh_ofb_overlay',
        onClick: function (event) { if (event.target === event.currentTarget) close() },
      },
        createElement('div', { className: '_dsh_ofb_dialog', role: 'dialog', 'aria-label': t('importTitle') },
          createElement('h3', { className: '_dsh_ofb_dialog_title' }, t('importTitle')),
          createElement('div', { className: '_dsh_ofb_caption' }, t('importHint')),
          createElement('textarea', {
            className: '_dsh_ofb_textarea',
            value: text,
            spellCheck: false,
            placeholder: t('importPlaceholder'),
            disabled: busy,
            onChange: function (event) { setText(event.target.value) },
          }),
          result ? importSummary(result) : null,
          error ? createElement('div', { className: '_dsh_ofb_error' }, error) : null,
          createElement('div', { className: '_dsh_ofb_dialog_actions' },
            createElement(Button, { variant: 'outline', onClick: close, disabled: busy }, t('importCancel')),
            createElement(Button, { onClick: submit, disabled: busy }, busy ? t('importBusy') : t('importConfirm')),
          ),
        ),
      )
    }

    // ───────────────────────── 设置分区 ─────────────────────────
    function ClineKeysSection() {
      var [state, reload] = useStatus()
      // 导入弹窗的开关放在这一层：弹窗要盖在整块面板上，而不是被塞进统计行的 flex 布局里
      var [importOpen, setImportOpen] = React.useState(false)
      // 「重置统计」是两段式：先点一下变「确认重置」（4 秒后自动撤回），再点才真的发请求。
      // 统计一旦清零无法撤销，多这一下可以避免误触。
      var [resetArmed, setResetArmed] = React.useState(false)
      var [resetBusy, setResetBusy] = React.useState(false)
      var [resetNote, setResetNote] = React.useState('')
      // 选定「使用中」的 Key：busy 记着正在切换的那把（按钮禁用用），note 是失败提示
      var [selectBusy, setSelectBusy] = React.useState('')
      var [selectNote, setSelectNote] = React.useState('')

      React.useEffect(function () {
        if (!resetArmed) return undefined
        var timer = setTimeout(function () { setResetArmed(false) }, 4000)
        return function () { clearTimeout(timer) }
      }, [resetArmed])

      /** 重置累计统计（计数 / token / 最近决策）。冷却与额度不受影响。 */
      async function doReset() {
        if (resetBusy) return
        if (!resetArmed) {
          setResetArmed(true)
          setResetNote('')
          return
        }
        setResetArmed(false)
        setResetBusy(true)
        try {
          var res = await fetch(RESET_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            cache: 'no-store',
            body: '{}',
          })
          var payload = null
          try { payload = await res.json() } catch (parseError) { payload = null }
          if (!res.ok) throw new Error((payload && payload.error) || ('HTTP ' + res.status))
          setResetNote(t('resetDone'))
          reload()
        } catch (requestError) {
          setResetNote(t('resetFailed', { message: requestError && requestError.message ? requestError.message : String(requestError) }))
        } finally {
          setResetBusy(false)
        }
      }

      /** 为**当前模型**选定 / 取消「使用中」的 Key（该模型的首发送优先用它）。写路由成功后
       *  重拉一次：徽标、状态与统计一起刷新，不必等下一次 5 秒轮询。 */
      async function doSelect(label, active) {
        if (selectBusy) return
        setSelectBusy(label)
        setSelectNote('')
        try {
          var res = await fetch(SELECT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            cache: 'no-store',
            // 选定是「模型 + 标签」两维的；点已选中的那把＝取消（空标签是主机端约定的清除写法）
            body: JSON.stringify({ model: activeModel, label: active ? '' : label }),
          })
          var payload = null
          try { payload = await res.json() } catch (parseError) { payload = null }
          if (!res.ok) throw new Error((payload && payload.error) || ('HTTP ' + res.status))
          reload()
        } catch (requestError) {
          setSelectNote(t('selectFailed', { message: requestError && requestError.message ? requestError.message : String(requestError) }))
        } finally {
          setSelectBusy('')
        }
      }
      // 面板恒定按某个模型看（筛选条没有「全部模型」）。'' = 还没手动选过，此时跟着
      // 「当前正在用的模型」（主机端给的 currentModel）走；用 '' 而不是初始快照，
      // 是因为首次渲染时数据还没到，这样默认值会随数据自动落位。
      var [picked, setPicked] = React.useState('')
      var data = state.data
      var totals = (data && data.totals) || {}
      var models = (data && data.models) || []
      var activeModel = picked || (data && data.currentModel) || (models[0] && models[0].id) || ''
      // 选中的模型可能已经从配置里消失（改了 cline 提供方的模型表）：回落到第一个可用模型
      if (!models.some(function (row) { return row.id === activeModel })) activeModel = (models[0] && models[0].id) || ''
      var keys = (data && data.keys) || []
      // 当前模型的**预期**上游（来自配置，与观测无关）：Key 表的「上游渠道」列据此上警示色。
      // 刻意不取 `upstream.preferred`——观测是内存态，重启后为空，那样警示色就永远不出现。
      var preferredUpstream = (models.find(function (row) { return row.id === activeModel }) || {}).preferred || ''
      // 选定的「使用中」Key：载荷是「模型 → 8 位标签」的映射，取**当前模型**那一条。
      // 它已不在池中（凭据被删）时单独给一行提示——否则用户只会看到徽标莫名消失，
      // 却不知道这个模型的首发送已经回到 DSH 配置的 Key。
      var selectionLabel = (data && data.selection && data.selection[activeModel]) || ''
      var selectionMissing = Boolean(selectionLabel) && !keys.some(function (key) { return key.label === selectionLabel })

      // 概览讲的就是当前模型上的情况
      var coolingCount = keys.filter(function (key) {
        return (key.cooling || []).some(function (row) { return row.model === activeModel })
      }).length
      var readyCount = keys.length - coolingCount

      var header = createElement('div', { className: '_dsh_ofb_head' },
        createElement('div', null,
          createElement('h2', { className: '_dsh_ofb_h2' }, t('title')),
          createElement('div', { className: '_dsh_ofb_caption' },
            state.at
              ? t('updatedAt', { time: clockOf(state.at) }) + ' · ' + t('autoRefresh')
              : t('refreshing'),
          ),
        ),
        createElement('div', { className: '_dsh_ofb_head_actions' },
          selectNote ? createElement('span', { className: '_dsh_ofb_caption' }, selectNote) : null,
          resetNote ? createElement('span', { className: '_dsh_ofb_caption' }, resetNote) : null,
          createElement(Button, {
            variant: 'outline',
            onClick: doReset,
            disabled: resetBusy,
          }, resetBusy ? t('resetBusy') : resetArmed ? t('resetConfirm') : t('resetStats')),
          createElement(Button, {
            variant: 'outline',
            onClick: reload,
            icon: createElement(RefreshIcon, { spinning: state.phase === 'loading' }),
          }, t('refresh')),
        ),
      )

      // 累计统计的时间起点由主机端给出（存在状态文件里，跨重启沿用），
      // 所以「插件更新后数字还在」这件事在面板上有据可查，而不是凭空冒出来的大数字。
      var statsSince = Number(totals.since) || 0
      var statsNote = statsSince
        ? createElement('div', { className: '_dsh_ofb_caption' }, t('statsSince', { time: stampOf(statsSince) }))
        : null

      var filters = ModelFilter({ models: models, active: activeModel, onChange: setPicked })

      var stats = createElement('div', { className: '_dsh_ofb_stats' },
        createElement(Stat, { key: 'pool', value: keys.length, label: t('statPool') }),
        createElement(Stat, { key: 'ready', value: readyCount, label: t('statReadyFor') }),
        createElement(Stat, { key: 'cooling', value: coolingCount, label: t('statCoolingFor') }),
        createElement(Stat, { key: 'req', value: totals.clineRequests ?? 0, label: t('statRequests') }),
        createElement(Stat, { key: 'rot', value: totals.rotations ?? 0, label: t('statRotations') }),
        createElement(Stat, { key: 'ff', value: totals.failFasts ?? 0, label: t('statFailFasts') }),
        createElement(Stat, { key: 'ver', value: data ? String(data.version || '') : '—', label: t('statVersion') }),
        // 版本卡右边的入口：把粘贴进来的 Key 写进凭据仓库（写路由见主机半边）
        createElement(ImportButton, { key: 'import', onClick: function () { setImportOpen(true) } }),
      )

      var body
      if (state.phase === 'error') {
        body = createElement('div', { className: '_dsh_ofb_error' }, t('errorTitle', { message: state.error }))
      } else if (!data) {
        body = createElement('div', { className: '_dsh_ofb_card' },
          createElement('div', { className: '_dsh_ofb_empty' }, t('refreshing')),
        )
      } else {
        body = [
          createElement(KeyTable, {
            key: 'table',
            keys: keys,
            activeModel: activeModel,
            // 当前模型的预期上游（配置里的值）：给「不是预期上游」的行加警示色
            preferred: preferredUpstream,
            // 选定的「使用中」Key（8 位标签）与切换入口；切换进行中时按钮一并禁用
            selection: selectionLabel,
            busy: Boolean(selectBusy),
            onSelect: doSelect,
          }),
          createElement(UsageByModel, { key: 'usage', keys: keys, activeModel: activeModel }),
          createElement(RecentList, { key: 'recent', recent: data.recent }),
        ]
      }

      return createElement('div', { className: '_dsh_ofb_root' },
        header,
        stats,
        statsNote,
        // 选定的 Key 已不在池中时说明一句：首发送已经回到 DSH 配置的 Key
        selectionMissing ? createElement('div', { className: '_dsh_ofb_caption' }, t('useMissing')) : null,
        filters,
        body,
        // 弹窗始终挂在树里（关闭时自己返回 null），hook 槽位因此保持稳定
        createElement(ImportDialog, {
          open: importOpen,
          onClose: function () { setImportOpen(false) },
          // 导入成功后立刻重拉一次：主机端已在响应前强制重扫过池子，所以这里能马上看到新 Key
          onDone: reload,
        }),
      )
    }

    // ───────────────────────── 插件装配 ─────────────────────────
    function apply(ctx) {
      var slots = ctx.get('slots')

      // 语言包用**非门控**的 ctx.inject 挂载：即使 locale 服务缺席，
      // 面板也必须照常出现（只是文案退回模块级字典）。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['locale'], function (localeCtx) {
          var locale = localeCtx.get('locale')
          if (!locale || typeof locale.register !== 'function') return
          localeService = locale
          localeCtx.effect(function () {
            var offZh = locale.register(LOCALE_NS, 'zh', zhDict)
            var offEn = locale.register(LOCALE_NS, 'en', enDict)
            return function () {
              if (typeof offZh === 'function') offZh()
              if (typeof offEn === 'function') offEn()
            }
          }, 'dsh-cline-bridge: locale dictionaries')
          localeCtx.effect(function () {
            return function () {
              if (localeService === locale) localeService = undefined
            }
          }, 'dsh-cline-bridge: locale detach')
        })
      }

      // 座位注册：settings.section 由 DSH 的设置页声明，inject 会等到它出现。
      return slots.inject('settings.section', function () {
        return slots.register(
          {
            name: 'settings.section',
            id: PANEL_ID,
            order: 95,
            label: function () { return t('nav') },
            locale: LOCALE_NS,
          },
          ClineKeysSection,
        )
      })
    }

    exports.name = 'dsh-cline-bridge'
    exports.inject = ['slots']
    exports.apply = apply

    return module.exports
  },
})
