/**
 * DSH settings 服务的命名空间读取：兼容新旧两代 API。
 *
 * · 旧版（DSH ≤ 0.1.6）：`settings.get(ns)` 直读该命名空间的解析值。
 * · 新版（DSH 0.1.7+）：设置服务改成表单式 `SettingsForms`，`get` 已移除，
 *   只剩 `describe()`——一次返回**全部**条目的表单描述（ns / value / revision …），
 *   其中 `value` 就是该命名空间的解析值（schema 默认值 → 组合基座 → 用户层）。
 *
 * 服务缺席、命名空间未注册、describe/get 抛错……任何一步出问题都返回 undefined，
 * 调用方按「设置读不到」退化（只列观察到的模型、主 Key 等首次请求再入池），绝不抛错。
 */

/**
 * 建一个命名空间读取器：同一次读取器生命周期内 describe() 只跑一趟。
 *
 * 为什么按读取器缓存而不是按时间缓存：buildStatus 一次构建要读两个命名空间
 * （llm-pi-ai 与 agent-default-model），新版 describe() 每趟都遍历 profile 的
 * 全部条目，两个命名空间共用一趟刚好；缓存跨调用续命则要自己处理失效
 * （新版服务靠 settings/document-updated 事件通知变更，而面板本来就是 5 秒
 * 轮询、每次构建都新建读取器，事件接线在这里没有收益）。
 *
 * @param service 设置服务（可能是任意一代，也可能是 undefined）
 * @returns (ns) => 该命名空间的解析值，读不到返回 undefined
 */
export function createSettingsReader(service) {
  let described // undefined = 还没读过；null = 读过但不可用；数组 = describe() 的返回值
  const rows = () => {
    if (described === undefined) {
      try {
        const list = typeof service?.describe === 'function' ? service.describe() : null
        described = Array.isArray(list) ? list : null
      } catch {
        described = null
      }
    }
    return described
  }
  return (ns) => {
    try {
      // 有 get 的就是旧服务（新版 SettingsForms 没有这个方法），旧 API 直读优先
      if (typeof service?.get === 'function') return service.get(ns)
      const found = rows()?.find((row) => row && row.ns === ns)
      return found ? found.value : undefined
    } catch {
      return undefined
    }
  }
}

/** 一次性读取一个命名空间（低频路径用；一次读多个命名空间请用 createSettingsReader）。 */
export function readSettingsValue(service, ns) {
  return createSettingsReader(service)(ns)
}
