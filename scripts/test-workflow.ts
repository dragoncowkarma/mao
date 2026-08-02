import os from 'node:os'
import path from 'node:path'
import { GithubService } from '../electron/github-service.ts'
import { WorkflowEngine } from '../electron/workflow-engine.ts'
import type { AiProviderConfig } from '../electron/ai/types.ts'

const owner = process.env.TEST_GITHUB_OWNER
const repo = process.env.TEST_GITHUB_REPO
const token = process.env.TEST_GITHUB_TOKEN
const title = process.env.TEST_TASK_TITLE?.trim() || 'Add a hello-world script'

if (!owner || !repo || !token) {
  console.error('Missing TEST_GITHUB_OWNER / TEST_GITHUB_REPO / TEST_GITHUB_TOKEN')
  process.exit(1)
}

function providerFromEnv(suffix: string): AiProviderConfig | null {
  const apiKey = process.env[`TEST_AI${suffix}_API_KEY`]
  const cliCommand = process.env[`TEST_AI${suffix}_CLI_COMMAND`]

  if (apiKey) {
    return {
      id: `agent-api${suffix}`,
      name: process.env[`TEST_AI${suffix}_NAME`] || `API Agent${suffix}`,
      kind: 'api',
      apiFormat: (process.env[`TEST_AI${suffix}_API_FORMAT`] as 'anthropic' | 'openai') ?? 'anthropic',
      apiKey,
      model: process.env[`TEST_AI${suffix}_MODEL`],
    }
  }

  if (cliCommand) {
    return {
      id: `agent-cli${suffix}`,
      name: process.env[`TEST_AI${suffix}_NAME`] || `CLI Agent${suffix}`,
      kind: 'cli',
      command: cliCommand,
      args: process.env[`TEST_AI${suffix}_CLI_ARGS`]?.split(' ') ?? [],
    }
  }

  return null
}

const providers = [providerFromEnv(''), providerFromEnv('2')].filter((p) => p !== null)

if (providers.length === 0) {
  console.error('Set at least one of TEST_AI_API_KEY / TEST_AI_CLI_COMMAND (or the _AI2_ variants)')
  process.exit(1)
}

console.log(`Providers: ${providers.map((p) => p.name).join(', ')}`)

const github = new GithubService()
github.setToken(token)

const engine = new WorkflowEngine(github)
engine.setProviders(providers)
engine.setGithubToken(token)
engine.setWorkspaceRoot(process.env.TEST_WORKSPACE_ROOT || path.join(os.tmpdir(), 'mao-test-workspace'))

const task = engine.enqueue(title, { owner, repo })

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

for (;;) {
  await sleep(1000)
  const current = engine.getTasks().find((t) => t.id === task.id)
  if (!current) break
  console.log(`[${current.status}] stage=${current.stage}`)
  if (current.status === 'done' || current.status === 'error') {
    console.log(JSON.stringify(current, null, 2))
    break
  }
}
