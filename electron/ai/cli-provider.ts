import { spawn } from 'node:child_process'
import type { AiProvider, AiProviderConfig, AiRunOptions } from './types.ts'

const DEFAULT_SYSTEM_PROMPT =
  'You are being invoked as a single-shot, non-interactive text-generation subtask inside an ' +
  'automated pipeline. Respond with ONLY the requested text as your entire output — no clarifying ' +
  'questions, no requests for approval, no tool calls, no file edits, and no commentary about the ' +
  'working directory or repository.'

/** CLIs that accept a dedicated system-prompt flag; others get the directive prepended to stdin instead. */
const SYSTEM_PROMPT_FLAG_BY_COMMAND: Record<string, string> = {
  claude: '--append-system-prompt',
}

/** Extra flags that let a CLI actually write files when allowToolUse is requested. */
const TOOL_USE_FLAGS_BY_COMMAND: Record<string, string[]> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['-s', 'workspace-write'],
}

export class CliProvider implements AiProvider {
  readonly id: string
  readonly name: string
  private config: AiProviderConfig

  constructor(config: AiProviderConfig) {
    this.id = config.id
    this.name = config.name
    this.config = config
  }

  run(prompt: string, options?: AiRunOptions): Promise<string> {
    const { command, args = [] } = this.config
    if (!command) throw new Error(`[${this.name}] CLI command is not set`)

    const commandName = command.split('/').pop() ?? command

    let finalArgs: string[]
    let stdinInput: string

    if (options?.allowToolUse) {
      finalArgs = [...args, ...(TOOL_USE_FLAGS_BY_COMMAND[commandName] ?? [])]
      stdinInput = prompt
    } else {
      const systemPromptFlag = SYSTEM_PROMPT_FLAG_BY_COMMAND[commandName]
      finalArgs = systemPromptFlag ? [systemPromptFlag, DEFAULT_SYSTEM_PROMPT, ...args] : args
      stdinInput = systemPromptFlag ? prompt : `${DEFAULT_SYSTEM_PROMPT}\n\n---\n\n${prompt}`
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, finalArgs, { shell: false, cwd: options?.cwd })
      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`[${this.name}] CLI exited with code ${code}: ${stderr}`))
          return
        }
        resolve(stdout.trim())
      })

      child.stdin.write(stdinInput)
      child.stdin.end()
    })
  }
}
