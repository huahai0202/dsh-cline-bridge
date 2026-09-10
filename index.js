export const name = 'opencode-free-bridge'

export function apply(ctx) {
  const originalFetch = globalThis.fetch

  globalThis.fetch = async function (input, init) {
    let url = ''
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else if (input && typeof input.url === 'string') {
      url = input.url
    }

    // 1. 目标为 OpenCode Zen 的所有请求（包括 /v1/models 和 /v1/chat/completions 等）
    if (url && url.includes('opencode.ai/zen')) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}))

      const existingSession =
        headers.get('x-session-id') ||
        headers.get('x-opencode-session') ||
        headers.get('x-session-affinity')
      const sessionId = existingSession || `ses_${Math.random().toString(16).slice(2, 14)}`
      const requestId = `req_${Math.random().toString(16).slice(2, 14)}`

      headers.set('user-agent', 'opencode/1.18.21 (win32 x64; node20.0.0)')
      headers.set('x-opencode-client', 'cli')
      headers.set('x-opencode-session', sessionId)
      headers.set('x-session-affinity', sessionId)
      headers.set('X-Session-Id', sessionId)
      headers.set('x-opencode-request', requestId)
      headers.set('x-opencode-project', 'prj_dsh_native')

      // 若未设置 API 密钥、密钥为空，或误填成了 URL 地址，则自动切换为官方匿名通道
      const auth = headers.get('authorization')
      if (
        !auth ||
        auth.trim() === 'Bearer' ||
        auth.trim() === 'Bearer undefined' ||
        auth.trim() === 'Bearer null' ||
        auth.includes('http://') ||
        auth.includes('https://')
      ) {
        headers.set('authorization', 'Bearer public')
      }

      if (input instanceof Request) {
        const newRequest = new Request(input, { ...init, headers })
        return originalFetch.call(this, newRequest)
      }

      return originalFetch.call(this, input, { ...init, headers })
    }

    // 2. 目标为 Cline 官方中转 API (api.cline.bot) 的所有请求
    if (url && url.includes('api.cline.bot')) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}))

      // 仅注入 Cline 官方客户端协议特征头，鉴权密钥完全遵循用户在 DSH 的设置直通，不设内置兜底
      headers.set('http-referer', 'https://cline.bot')
      headers.set('x-title', 'Cline')
      headers.set('user-agent', 'Cline/4.1.16')
      headers.set('x-conversion-version', '4.1.16')
      headers.set('x-platform-version', '1.106.0')
      headers.set('x-client-version', '4.1.16')
      headers.set('x-platform', 'vscode')
      headers.set('x-client-type', 'cline-vscode')

      if (input instanceof Request) {
        const newRequest = new Request(input, { ...init, headers })
        return originalFetch.call(this, newRequest)
      }

      return originalFetch.call(this, input, { ...init, headers })
    }

    // 所有其他渠道（DeepSeek、OpenAI、Anthropic 等）100% 原样直通，完全无感
    return originalFetch.apply(this, arguments)
  }

  ctx.on('dispose', () => {
    globalThis.fetch = originalFetch
  })
}
