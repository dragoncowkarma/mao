import type { AiProvider, AiProviderConfig } from './types.ts'

export class ApiProvider implements AiProvider {
  readonly id: string
  readonly name: string
  private config: AiProviderConfig

  constructor(config: AiProviderConfig) {
    this.id = config.id
    this.name = config.name
    this.config = config
  }

  // API providers only ever return text, so cwd/allowToolUse (real file edits) don't apply here.
  async run(prompt: string): Promise<string> {
    const { apiFormat = 'openai', apiKey, baseUrl, model } = this.config
    if (!apiKey) throw new Error(`[${this.name}] API key is not set`)

    if (apiFormat === 'anthropic') {
      const res = await fetch(baseUrl ?? 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model ?? 'claude-sonnet-5',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!res.ok) throw new Error(`[${this.name}] API error ${res.status}: ${await res.text()}`)
      const data = await res.json()
      return data.content?.[0]?.text ?? ''
    }

    const res = await fetch(baseUrl ?? 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model ?? 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) throw new Error(`[${this.name}] API error ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? ''
  }
}
