/**
 * 模型 id 的形状校验：判断一个字符串像不像真实的模型名。
 *
 * 三处必须用同一把尺子：面板载荷（筛选芯片与「当前模型」）、额度状态文件（选定与用量都
 * 按模型名索引）、选定写路由（请求体里带来的模型名）。模型名来自上游请求体，一旦有请求
 * 带了奇怪的 model（手改配置、探针、错误回显），它就会变成筛选芯片、落进状态文件，或让
 * 「使用中」的选定绑到一个永远不会命中的模型上。
 *
 * 刻意只做最低限度的形状校验：
 *   · 非空字符串、长度合理、不含控制字符与换行（避免撑坏面板布局）；
 *   · 至少含一个字母或数字（挡住 '???' / '---' / 空串这类）；
 *   · 排除 readModelOf 用来表示「读不出模型」的 '*'。
 * 不做得更严：模型 id 的形状由各家提供方自定义，猜格式只会误伤。
 */
export function isPlausibleModelId(model) {
  if (typeof model !== 'string') return false
  const value = model.trim()
  if (!value || value === '*' || value.length > 128) return false
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  return /[A-Za-z0-9]/.test(value)
}
