import type { AiProvider, AiProviderConfig, AiRunOptions } from './types.ts'

/** Same rationale as CliProvider's timeout: one hung call would otherwise stall the whole queue. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000

export class ApiProvider implements AiProvider {
  readonly id: string
  readonly name: string
  private config: AiProviderConfig

  constructor(config: AiProviderConfig) {
    this.id = config.id
    this.name = config.name
    this.config = config
  }

  async run(prompt: string, options?: AiRunOptions): Promise<string> {
    const { apiFormat = 'openai', apiKey, baseUrl } = this.config
    if (!apiKey) throw new Error(`[${this.name}] API key is not set`)

    const model = options?.model ?? this.config.model
    const effort = options?.effort ?? this.config.effort

    if (apiFormat === 'anthropic') {
      const body: Record<string, unknown> = {
        model: model ?? 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }

      const res = await fetch(baseUrl ?? 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`[${this.name}] API error ${res.status}: ${await res.text()}`)
      const data = await res.json()
      return data.content?.[0]?.text ?? ''
    }

    const body: Record<string, unknown> = {
      model: model ?? 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
    }
    if (effort) {
      body.reasoning_effort = effort
    }

    const res = await fetch(baseUrl ?? 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`[${this.name}] API error ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? ''
  }
}
