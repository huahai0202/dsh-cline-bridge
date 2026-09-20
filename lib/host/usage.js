/**
 * Token 用量采集：从响应体里捞出 usage。
 *
 * 插件位于 openai SDK 之下，是唯一能碰到原始响应体的层次；采集方式是 tee 出
 * 一路只读分支，原样交给上层 SDK 的那一路完全不受影响。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
// ───────────────────── Token 用量采集 ─────────────────────
// 插件位于 openai SDK 之下，是唯一能碰到原始响应体的层次，所以 token 用量只能在这里捞：
//   · 流式（Cline 走的就是这条）：pi-ai 已经带上 `stream_options.include_usage`，
//     最后一个 data chunk 里带 usage，取**最后一次**（有的网关每个 chunk 都发累计值）。
//   · 非流式：JSON 体里的 usage。
// 实现方式是把响应体 tee 成两路：一路原样交给上层 SDK，另一路自己读一遍、只挑 usage，
// 读完即丢。任何失败都静默跳过——统计绝不能影响请求本身。

/** 把 OpenAI 形状的 usage 归一成四个数（兼容 input_tokens/output_tokens 命名）。 */
export function normalizeUsage(usage) {
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  const input = num(usage?.prompt_tokens ?? usage?.input_tokens)
  const output = num(usage?.completion_tokens ?? usage?.output_tokens)
  const total = num(usage?.total_tokens) || input + output
  const cached = num(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens)
  return { input, output, total, cached }
}

/** 扫 SSE 流，取最后一次 usage 与整条流的耗时（毫秒）。只做「读一遍、丢弃」，占用与响应体同阶、不累积。
 *  耗时起点由调用方传入（tapUsage 被调用的时刻），绝不能等第一个 chunk 才起算——
 *  当 SDK 先把自己的分支整个读走（缓冲式消费），tee 会把所有 chunk 预备进我们这个未读
 *  分支，之后再读就是瞬时回放，测出来 ≈0ms，速度被放大几个数量级（实测出现过
 *  1,044,000 tok/s）。从响应头就绪时刻起算则永远覆盖真实的生成时间窗。 */
async function scanSseUsage(stream, onUsage, startedAt) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let last
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).trim()
        pending = pending.slice(at + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        // 只对可能带 usage 的行做 JSON 解析，避免给每个 chunk 都付解析成本
        if (!payload || payload === '[DONE]' || payload.indexOf('"usage"') === -1) continue
        try {
          const parsed = JSON.parse(payload)
          if (parsed?.usage) last = parsed.usage
        } catch {
          // 半截 JSON / 非 JSON 数据行：忽略
        }
      }
    }
  } catch {
    // 流被取消或中断：已经拿到的 usage 仍然算数
  }
  if (last) onUsage(last, Math.max(0, Date.now() - startedAt))
}

/** 非流式 JSON 响应里的 usage。非流式没有「逐 chunk 生成」可测：ms=0 表示耗时未知，速度列显示「—」。 */
async function scanJsonUsage(stream, onUsage) {
  try {
    const text = await new Response(stream).text()
    const parsed = JSON.parse(text)
    if (parsed?.usage) onUsage(parsed.usage, 0)
  } catch {
    // 解析失败就当这次没有 usage
  }
}

/** 给响应挂一个用量观察分支，返回给 SDK 的仍是等价响应（状态、头、体都不变）。
 *
 *  只在成功响应上挂：只有 2xx 才可能带 usage；错误响应完全不碰，免得和 SDK /
 *  pi-ai 的取消与重试路径（`CancelReadableStream(response.body)` 之类）产生任何交互。
 *  另外确认过 SDK 只在 debug 日志里用 `response.url`，重建 Response 丢掉它是安全的。 */
export function tapUsage(response, onUsage) {
  if (!response.ok || !response.body) return response
  const type = response.headers.get('content-type') ?? ''
  const isSse = /text\/event-stream/i.test(type)
  const isJson = /application\/json/i.test(type)
  if (!isSse && !isJson) return response
  // 计时起点 = tapUsage 被调用的时刻（响应头就绪、两个分支都还没人读）
  const startedAt = Date.now()
  try {
    const [mine, theirs] = response.body.tee()
    if (isSse) void scanSseUsage(mine, onUsage, startedAt)
    else void scanJsonUsage(mine, onUsage)
    return new Response(theirs, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  } catch {
    // tee 不可用（body 已被消费等）：原样返回，绝不因为统计而影响请求
    return response
  }
}
