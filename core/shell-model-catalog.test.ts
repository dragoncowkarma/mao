import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Where the model-catalog refresher may and may not start (#140), asserted as source text for the reason
 * `core/shell-queue-gate.test.ts` gives: `cli/index.ts` builds a commander program and `electron/ipc.ts`
 * needs a live Electron app, so neither can be imported here. The refresher's interval would keep every
 * one-shot command alive (architecture rule 5), and a host that never stops it leaks a timer and a child
 * CLI into shutdown.
 */
const REPO_ROOT = path.join(
  (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'),
  '..',
)

/** Executable text only: comments here mention the refresher too, and must not satisfy an assertion. */
function sourceOf(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('architecture rule 5 for the model catalog', () => {
  it('keeps every catalog timer out of the composition root', () => {
    const app = sourceOf(path.join('core', 'app.ts'))
    expect(app).not.toMatch(/model-catalog/)
    expect(app).not.toMatch(/startModelCatalogRefresher|createModelCatalogMaintainer/)
  })
})

describe('mao run keeps the catalog fresh and stops it on exit', () => {
  const source = sourceOf(path.join('cli', 'index.ts'))
  const runAction = source.slice(source.indexOf("  .command('run')"), source.indexOf("  .command('swarm')"))

  it('starts the refresher only after both queue gates, beside auto-trigger', () => {
    const start = runAction.indexOf('startModelCatalogRefresher(')
    expect(start, 'mao run must start the catalog refresher').toBeGreaterThan(-1)
    expect(runAction.indexOf('isPersistenceBroken()')).toBeLessThan(start)
    expect(runAction.indexOf('getQueueRecoveryReason()')).toBeLessThan(start)
    expect(runAction.indexOf('startAutoTrigger(')).toBeLessThan(start)
  })

  it('stops it in the same SIGINT handler that clears auto-trigger', () => {
    const handler = runAction.slice(runAction.indexOf("process.on('SIGINT'"))
    expect(handler).toMatch(/clearInterval\(autoTrigger\.handle\)[\s\S]*modelCatalog\.stop\(\)[\s\S]*process\.exit/)
  })

  it('reads providers fresh, so a key saved after start is used', () => {
    expect(runAction).toMatch(/listProviders: \(\) => store\.inspect\('aiProviders'\)/)
  })
})

describe('the other shells', () => {
  it('starts the refresher in the Electron host and stops it on quit', () => {
    const ipc = sourceOf(path.join('electron', 'ipc.ts'))
    const start = ipc.indexOf('startModelCatalogRefresher(')
    expect(start).toBeGreaterThan(ipc.indexOf('createMaoApp('))
    expect(ipc).toMatch(/app\.once\('will-quit', \(\) => modelCatalog\.stop\(\)\)/)
    expect(ipc).toMatch(/ipcMain\.handle\('ai:getModelCatalog', \(\) => modelCatalog\.read\(\)\)/)
  })

  it('hands Swarm the CLI data directory, and nothing in the one-shot commands starts a timer', () => {
    const cli = sourceOf(path.join('cli', 'index.ts'))
    expect(cli).toMatch(/runSwarm\(\{ \.\.\.opts, modelCatalogDir: resolveDataDir\(\) \}\)/)
    expect(cli.match(/startModelCatalogRefresher\(/g)).toHaveLength(1)
  })
})
