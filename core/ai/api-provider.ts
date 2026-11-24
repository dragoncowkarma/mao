import type { AiProvider, AiProviderConfig, AiRunOptions } from './types.ts'

/** Same rationale as CliProvider's timeout: one hung call would otherwise stall the whole queue. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000

/** Where an Anthropic-format provider with no `baseUrl` sends its requests. */
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

/**
 * The messages endpoint an Anthropic-format provider posts to: its `baseUrl` exactly as saved, or the
 * public API when none is saved. An empty or blank `baseUrl` is not "none": the request fails before it
 * leaves the process. Model discovery (`anthropicModelsUrl()` in `core/ai/model-discovery.ts`) derives its
 * URL from this same answer, so listing models can never send a key where inference would not.
 */
export function anthropicMessagesUrl(baseUrl: string | undefined): string {
  return baseUrl ?? ANTHROPIC_MESSAGES_URL
}

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

      const res = await fetch(anthropicMessagesUrl(baseUrl), {
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
