// Cline Key 使用情况面板 —— 浏览器半边（零构建手写 bundle）。
//
// 与 dsh-better-archive 同一个已验证的形态：CJS factory + ModuleLoader 包装，
// React 经 require("react") 取用，UI 组件全部来自 DSH 自己的
// @deepseek-ai/dsh-client-ui-primitives（浏览器内核基线模块，无需在
// dsh.client.external 里声明），因此配色、圆角、焦点环、亮暗主题全部继承宿主。
//
// 数据来自主机半边（index.js）注册的同源只读路由
// GET /opencode-free-bridge/cline-keys，每 5 秒轮询一次（页面不可见时跳过）。
// 该路由只回 8 位哈希标签与**掩码预览**（首尾各 4 位），key 原文既不在响应里，
// 也不在日志与磁盘状态文件里。
//
// 面板挂在设置页的 `settings.section` 座位：DSH 自己用同一个座位承载
// 「通用」「模型」等内置分区，所以这里不需要自绘任何设置页外壳。
window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 完全一致。
  id: 'opencode-free-bridge',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var createElement = React.createElement
    var ui = require('@deepseek-ai/dsh-client-ui-primitives')
    // DSH 自己的按钮；万一该导出缺失（老宿主）就退回原生 button，面板不会整块崩掉。
    var Button = (ui && ui.Button) || 'button'

    /** 设置分区 id（= 插件名）与主机端路由。 */
    var PANEL_ID = 'opencode-free-bridge'
    var ROUTE = '/opencode-free-bridge/cline-keys'
    var LOCALE_NS = 'opencodeFreeBridge'

    /** 轮询间隔：设置页偶尔打开一次，5 秒足够反映冷却变化，代价仅一条本机请求。 */
    var REFRESH_MS = 5000

    // ───────────────────────── 样式（只做布局，颜色全部用 DSH token） ─────────────────────────
    var STYLE_ID = 'dsh-opencode-free-bridge-styles'
    if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
      var styleEl = document.createElement('style')
      styleEl.id = STYLE_ID
      styleEl.dataset.plugin = 'opencode-free-bridge'
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
        '._dsh_ofb_scroll { overflow-x: auto; }',
        '._dsh_ofb_table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 20px; }',
        '._dsh_ofb_table th { position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 500; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, inherit); background: var(--dsw-alias-bg-layer-3); padding: 10px 12px; border-bottom: .5px solid var(--dsw-alias-border-l2); white-space: nowrap; }',
        '._dsh_ofb_table td { padding: 10px 12px; border-bottom: .5px solid var(--dsw-alias-border-l2); vertical-align: top; }',
        '._dsh_ofb_table tr:last-child td { border-bottom: none; }',
        '._dsh_ofb_table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }',
        '._dsh_ofb_mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }',
        '._dsh_ofb_key_cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }',
        '._dsh_ofb_key_preview { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }',
        '._dsh_ofb_badge { display: inline-flex; align-items: center; padding: 0 6px; height: 18px; border-radius: 6px; font-size: 11px; line-height: 18px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); }',
        '._dsh_ofb_pill { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; height: 20px; border-radius: 999px; font-size: 12px; line-height: 20px; white-space: nowrap; }',
        '._dsh_ofb_pill_ready { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }',
        '._dsh_ofb_pill_cooling { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }',
        '._dsh_ofb_cooling_list { display: flex; flex-direction: column; gap: 2px; }',
        '._dsh_ofb_cooling_row { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; }',
        '._dsh_ofb_remaining { color: var(--dsw-alias-state-error-primary); font-variant-numeric: tabular-nums; }',
        '._dsh_ofb_nums { font-variant-numeric: tabular-nums; white-space: nowrap; }',
        '._dsh_ofb_dim { color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_empty { padding: 24px 16px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, inherit); }',
        '._dsh_ofb_error { padding: 12px 14px; border-radius: 12px; font-size: 13px; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }',
        '._dsh_ofb_section_title { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 14px; line-height: 20px; font-weight: 600; }',
        '._dsh_ofb_recent { display: flex; flex-direction: column; }',
        '._dsh_ofb_recent_row { display: flex; align-items: baseline; gap: 10px; padding: 7px 14px; border-bottom: .5px solid var(--dsw-alias-border-l2); font-size: 12.5px; line-height: 18px; }',
        '._dsh_ofb_recent_row:last-child { border-bottom: none; }',
        '._dsh_ofb_recent_time { flex: none; width: 64px; color: var(--dsw-alias-label-tertiary, inherit); font-variant-numeric: tabular-nums; }',
        '._dsh_ofb_recent_model { flex: none; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '._dsh_ofb_recent_decision { min-width: 0; flex: 1 1 auto; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); }',
        '._dsh_ofb_btn_icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }',
        '._dsh_ofb_spin { animation: _dsh-ofb-spin .9s linear infinite; }',
        '@keyframes _dsh-ofb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
      ].join('\n')
      document.head.appendChild(styleEl)
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
      statReady: '可用',
      statCooling: '冷却中',
      statRequests: 'Cline 请求',
      statRotations: '换 Key 恢复',
      statFailFasts: '快速失败',
      statVersion: '插件版本',
      colIndex: '#',
      colKey: 'Key',
      colStatus: '状态',
      colCooling: '冷却模型 / 恢复',
      colUsage: '发送 / 成功 / 限流',
      colLastUsed: '最近使用',
      primaryBadge: 'DSH 主 Key',
      pillReady: '可用',
      pillCooling: '冷却中',
      never: '从未',
      none: '—',
      emptyTitle: '还没有捕获到 Cline Key',
      emptyHint: '当 DSH 发出第一个 Cline 请求（或从 .credentials.yaml 读到额外 Key）后，这里会列出池内的每一把 Key。',
      errorTitle: '读取 Key 池状态失败：{message}',
      recentTitle: '最近决策',
      recentEmpty: '暂无请求记录',
      agoSeconds: '{n} 秒前',
      agoMinutes: '{n} 分钟前',
      agoHours: '{n} 小时前',
      resetIn: '{time} 后恢复',
    }

    var enDict = {
      nav: 'Cline Keys',
      title: 'Cline key usage',
      refresh: 'Refresh',
      refreshing: 'Loading…',
      updatedAt: 'updated {time}',
      autoRefresh: 'auto-refresh every 5s',
      statPool: 'Keys in pool',
      statReady: 'Ready',
      statCooling: 'Cooling',
      statRequests: 'Cline requests',
      statRotations: 'Rotations',
      statFailFasts: 'Fail-fasts',
      statVersion: 'Plugin version',
      colIndex: '#',
      colKey: 'Key',
      colStatus: 'Status',
      colCooling: 'Cooling model / reset',
      colUsage: 'Sent / OK / Limited',
      colLastUsed: 'Last used',
      primaryBadge: 'DSH primary key',
      pillReady: 'ready',
      pillCooling: 'cooling',
      never: 'never',
      none: '—',
      emptyTitle: 'No Cline key captured yet',
      emptyHint: 'Once DSH sends its first Cline request (or extra keys are read from .credentials.yaml), every key in the pool is listed here.',
      errorTitle: 'Failed to read the key pool: {message}',
      recentTitle: 'Recent decisions',
      recentEmpty: 'No request recorded yet',
      agoSeconds: '{n}s ago',
      agoMinutes: '{n}m ago',
      agoHours: '{n}h ago',
      resetIn: 'resets in {time}',
    }

    /** 当前语言是否中文；locale 服务缺失时退回浏览器语言。 */
    function isZh() {
      var active = ''
      try {
        active = localeService ? String(localeService.getSnapshot().active || '') : ''
      } catch {
        active = ''
      }
      if (!active && typeof navigator !== 'undefined') active = String(navigator.language || '')
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
     * 轮询主机端只读路由。返回 [state, reload]：
     *   state.phase 为 'loading' | 'ready' | 'error'；
     *   state.data 保留上一次成功的数据，所以一次网络抖动不会把面板清空。
     */
    function useStatus() {
      var [state, setState] = React.useState({ phase: 'loading', data: null, error: '', at: 0 })
      var [nonce, setNonce] = React.useState(0)

      React.useEffect(
        function () {
          var alive = true
          function load() {
            // 页面不可见时不轮询（设置页开着但切走了）
            if (typeof document !== 'undefined' && document.hidden) return
            fetch(ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
              .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status)
                return res.json()
              })
              .then(function (data) {
                if (!alive) return
                setState({ phase: 'ready', data: data, error: '', at: Date.now() })
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

    /** 一把 key 的状态药丸：有冷却记录就是「冷却中」。 */
    function StatusPill(props) {
      var cooling = props.cooling && props.cooling.length > 0
      return createElement('span', {
        className: cooling ? '_dsh_ofb_pill _dsh_ofb_pill_cooling' : '_dsh_ofb_pill _dsh_ofb_pill_ready',
      }, cooling ? t('pillCooling') : t('pillReady'))
    }

    /** 冷却列：每个模型一行，带恢复倒计时与绝对时刻。 */
    function CoolingCell(props) {
      var cooling = props.cooling || []
      if (cooling.length === 0) return createElement('span', { className: '_dsh_ofb_dim' }, t('none'))
      return createElement('div', { className: '_dsh_ofb_cooling_list' },
        cooling.map(function (row, index) {
          var remaining = remainingOf(row.readyAt)
          return createElement('div', { key: index, className: '_dsh_ofb_cooling_row' },
            createElement('span', { className: '_dsh_ofb_mono' }, row.model),
            remaining
              ? createElement('span', { className: '_dsh_ofb_remaining' }, remaining)
              : null,
            createElement('span', { className: '_dsh_ofb_dim' }, '(' + stampOf(row.readyAt) + ')'),
          )
        }),
      )
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
      var head = createElement('thead', null,
        createElement('tr', null,
          createElement('th', null, t('colIndex')),
          createElement('th', null, t('colKey')),
          createElement('th', null, t('colStatus')),
          createElement('th', null, t('colCooling')),
          createElement('th', null, t('colUsage')),
          createElement('th', null, t('colLastUsed')),
        ),
      )
      var body = createElement('tbody', null,
        keys.map(function (key) {
          var stats = key.stats || {}
          return createElement('tr', { key: key.label || String(key.index) },
            createElement('td', { className: '_dsh_ofb_dim' }, String(key.index)),
            createElement('td', null,
              createElement('div', { className: '_dsh_ofb_key_cell' },
                createElement('span', null,
                  createElement('span', { className: '_dsh_ofb_key_preview' }, key.preview || t('none')),
                  key.isRequestKey
                    ? createElement('span', { className: '_dsh_ofb_badge', style: { marginLeft: 6 } }, t('primaryBadge'))
                    : null,
                ),
                createElement('span', { className: '_dsh_ofb_caption _dsh_ofb_mono' }, key.label),
              ),
            ),
            createElement('td', null, createElement(StatusPill, { cooling: key.cooling })),
            createElement('td', null, createElement(CoolingCell, { cooling: key.cooling })),
            createElement('td', { className: '_dsh_ofb_nums' },
              String(stats.sent || 0) + ' / ' + String(stats.ok || 0) + ' / ' + String(stats.limited || 0),
            ),
            createElement('td', null,
              createElement('div', null, agoOf(stats.lastUsedAt)),
              stats.lastModel
                ? createElement('div', { className: '_dsh_ofb_caption _dsh_ofb_mono' }, stats.lastModel)
                : null,
            ),
          )
        }),
      )
      return createElement('div', { className: '_dsh_ofb_card' },
        createElement('div', { className: '_dsh_ofb_scroll' },
          createElement('table', { className: '_dsh_ofb_table' }, head, body),
        ),
      )
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

    // ───────────────────────── 设置分区 ─────────────────────────
    function ClineKeysSection() {
      var [state, reload] = useStatus()
      var data = state.data
      var totals = (data && data.totals) || {}

      var header = createElement('div', { className: '_dsh_ofb_head' },
        createElement('div', null,
          createElement('h2', { className: '_dsh_ofb_h2' }, t('title')),
          createElement('div', { className: '_dsh_ofb_caption' },
            state.at
              ? t('updatedAt', { time: clockOf(state.at) }) + ' · ' + t('autoRefresh')
              : t('refreshing'),
          ),
        ),
        createElement(Button, {
          variant: 'outline',
          onClick: reload,
          icon: createElement(RefreshIcon, { spinning: state.phase === 'loading' }),
        }, t('refresh')),
      )

      var stats = createElement('div', { className: '_dsh_ofb_stats' },
        createElement(Stat, { key: 'pool', value: totals.poolSize ?? 0, label: t('statPool') }),
        createElement(Stat, { key: 'ready', value: totals.readyKeys ?? 0, label: t('statReady') }),
        createElement(Stat, { key: 'cooling', value: totals.coolingKeys ?? 0, label: t('statCooling') }),
        createElement(Stat, { key: 'req', value: totals.clineRequests ?? 0, label: t('statRequests') }),
        createElement(Stat, { key: 'rot', value: totals.rotations ?? 0, label: t('statRotations') }),
        createElement(Stat, { key: 'ff', value: totals.failFasts ?? 0, label: t('statFailFasts') }),
        createElement(Stat, { key: 'ver', value: data ? String(data.version || '') : '—', label: t('statVersion') }),
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
          createElement(KeyTable, { key: 'table', keys: data.keys }),
          createElement(RecentList, { key: 'recent', recent: data.recent }),
        ]
      }

      return createElement('div', { className: '_dsh_ofb_root' }, header, stats, body)
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
          }, 'opencode-free-bridge: locale dictionaries')
          localeCtx.effect(function () {
            return function () {
              if (localeService === locale) localeService = undefined
            }
          }, 'opencode-free-bridge: locale detach')
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

    exports.name = 'opencode-free-bridge'
    exports.inject = ['slots']
    exports.apply = apply

    return module.exports
  },
})
