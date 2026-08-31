#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { createMaoApp, type MaoApp } from '../core/app.ts'
import { startAutoTrigger } from '../core/auto-trigger.ts'
import { FileStore } from '../core/store.ts'
import { defaultDataDir } from '../core/paths.ts'
import { clearPersistenceBrokenMarker, hasPersistenceBrokenMarker } from '../core/persistence-guard.ts'
import { runSwarm } from '../core/swarm-runner.ts'
import type { AiEffort, AiProviderConfig } from '../core/ai/types.ts'
import type { QueuedTask, RepoRef } from '../core/workflow-engine.ts'
import type { ThemePreference } from '../core/store.ts'

function log(...args: unknown[]) {
  console.log('[mao]', ...args)
}

function logErr(...args: unknown[]) {
  console.error('[mao]', ...args)
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

/** Resolves the same per-user data directory `loadApp()` boots against, for commands that need it directly (e.g. the persistence-broken marker). */
function resolveDataDir(): string {
  return process.env.MAO_DATA_DIR || defaultDataDir()
}

/**
 * Every command boots a fresh app instance against the on-disk store — the CLI is stateless between
 * invocations. `resume` defaults to false so that inspecting or reconfiguring state (e.g. `mao config
 * show`) never has the side effect of resuming real GitHub/AI-provider calls left over from a
 * previous `mao run`; only `run` itself opts in.
 */
function loadApp(resume = false): MaoApp {
  const dataDir = resolveDataDir()
  const store = new FileStore(path.join(dataDir, 'config.json'))
  const workspaceRoot = path.join(dataDir, 'workspaces')
  return createMaoApp({ store, workspaceRoot, dataDir, resume })
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
  .command('set-theme <theme>')
  .description('Set the UI color scheme preference (light, dark, or system) — read by the Electron GUI')
  .action((theme: string) => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
      throw new Error(`Invalid theme "${theme}" — expected one of: light, dark, system`)
    }
    const { store } = loadApp()
    store.set('theme', theme as ThemePreference)
    log(`Theme preference set to ${theme}`)
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
      theme: store.get('theme'),
      workflowPersistenceBroken: hasPersistenceBrokenMarker(resolveDataDir()),
    })
  })

config
  .command('clear-persistence-broken')
  .description(
    'Clear the marker that blocks auto-resume after a confirmed queue persistence failure (see ' +
      'AGENTS.md). Only run this after verifying by hand — via `mao workflow list` and the target ' +
      "repo's actual GitHub state — that no queued task will duplicate work if resumed.",
  )
  .action(() => {
    const dataDir = resolveDataDir()
    if (!hasPersistenceBrokenMarker(dataDir)) {
      log('workflowPersistenceBroken is already false — nothing to clear.')
      return
    }
    // clearPersistenceBrokenMarker() reports the actual postcondition (is the marker confirmed
    // gone?), not just whether the removal call happened to avoid throwing — a permission or I/O
    // failure leaving the marker in place must surface as a real failure here, never a false
    // "cleared" that would let the operator believe auto-resume is safe again when it isn't.
    if (!clearPersistenceBrokenMarker(dataDir)) {
      throw new Error(
        `Failed to clear workflowPersistenceBroken — the marker file is still present at ${dataDir}. ` +
          'Auto-resume remains blocked. Check filesystem permissions and try again.',
      )
    }
    log('Cleared workflowPersistenceBroken. Auto-resume (`mao run`) will run normally again.')
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

github
  .command('view <owner> <repo> <number>')
  .description('Show the full body + comment thread for one issue or PR')
  .action(async (owner: string, repo: string, number: string) => {
    const { githubService } = loadApp()
    printJson(await githubService.fetchTaskDetail(owner, repo, parseInt(number, 10)))
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
  .option('--worker <id>', 'provider id for the issue+pr stages — takes priority over --provider for those stages')
  .option('--reviewer <id>', 'provider id for the review stage — takes priority over --provider for that stage')
  .option('--maintainer <id>', 'provider id for the merge stage — takes priority over --provider for that stage')
  .action(
    (
      title: string,
      opts: {
        owner: string
        repo: string
        autoAdvance: boolean
        provider?: string
        model?: string
        effort?: string
        worker?: string
        reviewer?: string
        maintainer?: string
      },
    ) => {
      const { workflowEngine } = loadApp()
      const hasRoles = opts.worker !== undefined || opts.reviewer !== undefined || opts.maintainer !== undefined
      const hasOverride = hasRoles || opts.provider !== undefined || opts.model !== undefined || opts.effort !== undefined
      const providerOverride = hasOverride
        ? {
            providerId: opts.provider,
            model: opts.model,
            effort: opts.effort as AiEffort | undefined,
            roles: hasRoles ? { worker: opts.worker, reviewer: opts.reviewer, maintainer: opts.maintainer } : undefined,
          }
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
  .command('enqueue-existing <issueNumber>')
  .description('Start the pr -> review -> merge pipeline for an issue that already exists on GitHub')
  .requiredOption('--owner <owner>')
  .requiredOption('--repo <repo>')
  .option('--no-auto-advance', 'pause after each stage instead of running the pipeline unattended')
  .action(async (issueNumber: string, opts: { owner: string; repo: string; autoAdvance: boolean }) => {
    const { githubService, workflowEngine } = loadApp()
    const issue = await githubService.getIssue(opts.owner, opts.repo, parseInt(issueNumber, 10))
    const task = workflowEngine.enqueueFromIssue(
      issue.number,
      issue.url,
      issue.title,
      { owner: opts.owner, repo: opts.repo },
      opts.autoAdvance,
    )
    log(`Enqueued task ${task.id} from issue #${issue.number} (stage=${task.stage})`)
  })

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

// --- swarm --------------------------------------------------------------------

program
  .command('swarm')
  .description(
    'Run the autonomous Worker/Reviewer/Maintainer orchestrator for a Git repository. This may ' +
      'create worktrees, dispatch AI CLIs, and write to GitHub unless --dry-run or --status is used.',
  )
  .option('--repo-root <path>', 'target Git checkout (default: current directory)')
  .option('--interval <seconds>', 'GitHub polling interval in seconds', (value) => Number(value))
  .option('--dry-run', 'log planned work without dispatching agents or changing Git/GitHub state')
  .option('--once', 'run one polling cycle and exit')
  .option('--status', 'print the persisted process registry and exit')
  .option('--reset', 'clear persisted dispatch history before starting')
  .action(
    async (opts: {
      repoRoot?: string
      interval?: number
      dryRun?: boolean
      once?: boolean
      status?: boolean
      reset?: boolean
    }) => {
      const exitCode = await runSwarm(opts)
      if (exitCode !== 0) throw new Error(`Swarm orchestrator exited with code ${exitCode}`)
    },
  )

program.parseAsync(process.argv).catch((err) => {
  logErr(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
