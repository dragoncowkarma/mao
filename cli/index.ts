#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { createMaoApp, type MaoApp } from '../core/app.ts'
import { startAutoTrigger } from '../core/auto-trigger.ts'
import { FileStore } from '../core/store.ts'
import { defaultDataDir } from '../core/paths.ts'
import type { AiEffort, AiProviderConfig } from '../core/ai/types.ts'
import type { QueuedTask, RepoRef } from '../core/workflow-engine.ts'

function log(...args: unknown[]) {
  console.log('[mao]', ...args)
}

function logErr(...args: unknown[]) {
  console.error('[mao]', ...args)
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

/**
 * Every command boots a fresh app instance against the on-disk store — the CLI is stateless between
 * invocations. `resume` defaults to false so that inspecting or reconfiguring state (e.g. `mao config
 * show`) never has the side effect of resuming real GitHub/AI-provider calls left over from a
 * previous `mao run`; only `run` itself opts in.
 */
function loadApp(resume = false): MaoApp {
  const dataDir = process.env.MAO_DATA_DIR || defaultDataDir()
  const store = new FileStore(path.join(dataDir, 'config.json'))
  const workspaceRoot = path.join(dataDir, 'workspaces')
  return createMaoApp({ store, workspaceRoot, resume })
}

const program = new Command()
program
  .name('mao')
  .description('Headless CLI for the mao GitHub/AI workflow engine — same core logic as the Electron app.')
  .version('0.1.0')

// --- config ---------------------------------------------------------------

const config = program.command('config').description('Manage stored credentials and settings')

config
  .command('set-token <token>')
  .description('Set the GitHub token used for API calls and authenticated git operations')
  .action((token: string) => {
    const { store, githubService, workflowEngine } = loadApp()
    store.set('githubToken', token)
    githubService.setToken(token)
    workflowEngine.setGithubToken(token)
    log('GitHub token saved')
  })

config
  .command('import-providers <file>')
  .description('Load AI provider configs from a JSON file (array of AiProviderConfig)')
  .action((file: string) => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.resolve(file), 'utf-8'))
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected ${file} to contain a JSON array of AI provider configs`)
    }
    const providers = parsed as AiProviderConfig[]
    const { store } = loadApp()
    store.set('aiProviders', providers)
    log(`Imported ${providers.length} AI provider(s): ${providers.map((p) => p.id).join(', ')}`)
  })

config
  .command('show')
  .description('Print the current stored config (secrets redacted)')
  .action(() => {
    const { store } = loadApp()
    printJson({
      githubToken: store.get('githubToken') ? '[set]' : '[unset]',
      githubRepos: store.get('githubRepos'),
      aiProviders: store.get('aiProviders').map((p) => ({ ...p, apiKey: p.apiKey ? '[set]' : undefined })),
    })
  })

// --- repos ------------------------------------------------------------------

const repos = program.command('repos').description('Manage GitHub repositories tracked by auto-trigger')

repos
  .command('add <owner> <repo>')
  .description('Start tracking a repo (adds or replaces its entry)')
  .option('--no-auto-trigger', 'do not auto-poll this repo for new issues')
  .option('--poll-interval-ms <ms>', 'override the default poll interval', (v) => parseInt(v, 10))
  .action((owner: string, repo: string, opts: { autoTrigger: boolean; pollIntervalMs?: number }) => {
    const { store } = loadApp()
    const ref: RepoRef = { owner, repo, autoTrigger: opts.autoTrigger, pollIntervalMs: opts.pollIntervalMs }
    const existing = store.get('githubRepos').filter((r) => !(r.owner === owner && r.repo === repo))
    store.set('githubRepos', [...existing, ref])
    log(`Tracking ${owner}/${repo}`)
  })

repos
  .command('remove <owner> <repo>')
  .description('Stop tracking a repo')
  .action((owner: string, repo: string) => {
    const { store } = loadApp()
    store.set('githubRepos', store.get('githubRepos').filter((r) => !(r.owner === owner && r.repo === repo)))
    log(`Stopped tracking ${owner}/${repo}`)
  })

repos
  .command('list')
  .description('List tracked repos')
  .action(() => {
    const { store } = loadApp()
    printJson(store.get('githubRepos'))
  })

// --- github -----------------------------------------------------------------

const github = program.command('github').description('Direct GitHub read operations')

github
  .command('check <owner> <repo>')
  .description('List open issues/PRs for a repo')
  .action(async (owner: string, repo: string) => {
    const { githubService } = loadApp()
    printJson(await githubService.fetchTasks(owner, repo))
  })

// --- workflow -----------------------------------------------------------------

const workflow = program.command('workflow').description('Drive the issue -> PR -> review -> merge pipeline')

workflow
  .command('enqueue <title>')
  .description('Queue a new task starting at the issue stage')
  .requiredOption('--owner <owner>')
  .requiredOption('--repo <repo>')
  .option('--no-auto-advance', 'pause after each stage instead of running the pipeline unattended')
  .option(
    '--provider <id>',
    'preferred provider id for this task — still subject to maker-checker, so a stage never reuses ' +
      'the provider that handled the one before it',
  )
  .option('--model <model>', 'model override applied to whichever provider is selected for each stage')
  .option('--effort <effort>', 'reasoning-effort override (low|medium|high) applied to each selected provider')
  .action(
    (
      title: string,
      opts: { owner: string; repo: string; autoAdvance: boolean; provider?: string; model?: string; effort?: string },
    ) => {
      const { workflowEngine } = loadApp()
      const hasOverride = opts.provider !== undefined || opts.model !== undefined || opts.effort !== undefined
      const providerOverride = hasOverride
        ? { providerId: opts.provider, model: opts.model, effort: opts.effort as AiEffort | undefined }
        : undefined
      const task = workflowEngine.enqueue(
        title,
        { owner: opts.owner, repo: opts.repo },
        opts.autoAdvance,
        providerOverride,
      )
      log(`Enqueued task ${task.id} (stage=${task.stage})`)
    },
  )

workflow
  .command('list')
  .description('List all queued tasks')
  .action(() => {
    const { workflowEngine } = loadApp()
    printJson(workflowEngine.getTasks())
  })

workflow
  .command('retry <taskId>')
  .description('Re-attempt the current stage of a failed task')
  .action((taskId: string) => {
    const { workflowEngine } = loadApp()
    const task = workflowEngine.retry(taskId)
    log(`Retrying task ${task.id} (stage=${task.stage})`)
  })

workflow
  .command('advance <taskId>')
  .description('Run the current stage of a paused task')
  .action((taskId: string) => {
    const { workflowEngine } = loadApp()
    const task = workflowEngine.advance(taskId)
    log(`Advancing task ${task.id} (stage=${task.stage})`)
  })

workflow
  .command('clear-completed')
  .description('Remove all finished (done/error) tasks')
  .action(() => {
    const { workflowEngine } = loadApp()
    workflowEngine.clearCompleted()
    log('Cleared completed tasks')
  })

// --- run ----------------------------------------------------------------------

program
  .command('run')
  .description(
    'Run the engine in the foreground: restores the queue, polls tracked repos for new issues, and ' +
      'streams stage transitions to stdout/stderr until interrupted (Ctrl+C). Intended for unattended ' +
      'shell/cron invocation.',
  )
  .action(() => {
    // resume: false here — the queue is only resumed below, after the stdout log listener is
    // attached, so `mao run` never misses a stage transition that happens synchronously on resume.
    const { store, githubService, workflowEngine } = loadApp(false)
    const autoTrigger = startAutoTrigger(githubService, workflowEngine, () => store.get('githubRepos'))
    log('engine started — press Ctrl+C to stop')

    workflowEngine.on('change', (tasks: QueuedTask[]) => {
      const counts: Record<string, number> = {}
      for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
      const summary = Object.entries(counts)
        .map(([status, count]) => `${status}=${count}`)
        .join(' ')
      log(`queue: ${tasks.length} task(s)${summary ? ` [${summary}]` : ''}`)

      for (const task of tasks) {
        if (task.status === 'error' && task.error) {
          logErr(`task ${task.id.slice(0, 8)} "${task.title}" failed at stage=${task.stage}: ${task.error}`)
        }
      }
    })

    workflowEngine.resumeProcessing()

    process.on('SIGINT', () => {
      clearInterval(autoTrigger.handle)
      log('shutting down')
      process.exit(0)
    })
  })

program.parseAsync(process.argv).catch((err) => {
  logErr(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
