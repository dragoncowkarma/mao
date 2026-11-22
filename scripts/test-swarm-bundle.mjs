import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Exercise a copied single bundle with no Python on PATH, no source tree and no network.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-swarm-bundle-'))
const node = process.execPath
const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const bin = path.join(root, 'bin')
const repo = path.join(root, 'repo')
// The model-catalog cache lives in the CLI data directory; keep it inside the fixture, never the operator's.
const dataDir = path.join(root, 'data')
const catalogFile = path.join(dataDir, 'model-catalog.json')
const env = { ...process.env, PATH: bin, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GH_REPO: 'wrong/wrong', GH_HOST: 'wrong.example', MAO_DATA_DIR: dataDir, MAO_MODEL_CATALOG_TTL_HOURS: '',
  // Claude's local model sources are the operator's: point them at nothing so the run is hermetic.
  CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), ANTHROPIC_MODEL: '', ANTHROPIC_DEFAULT_OPUS_MODEL: '',
  ANTHROPIC_DEFAULT_SONNET_MODEL: '', ANTHROPIC_DEFAULT_FABLE_MODEL: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
  ANTHROPIC_SMALL_FAST_MODEL: '', CLAUDE_CODE_SUBAGENT_MODEL: '' }
const bundle = path.join(root, 'mao.cjs')
const run = (command, args, options = {}) => execFileSync(command, args,
  { cwd: repo, env, encoding: 'utf8', timeout: 15_000, ...options })
function executable(name, source) {
  fs.writeFileSync(path.join(bin, name), `#!${node}\n${source}`, { mode: 0o755 })
}
try {
  fs.mkdirSync(bin)
  fs.mkdirSync(repo)
  fs.copyFileSync(fileURLToPath(new URL('../dist-cli/index.cjs', import.meta.url)), bundle)
  executable('git', `const {spawnSync}=require('node:child_process');
    if(process.argv[2]==='fetch') process.exit(0);
    const r=spawnSync(${JSON.stringify(git)},process.argv.slice(2),{stdio:'inherit',env:process.env});
    process.exit(r.status??1);`)
  executable('gh', `const a=process.argv.slice(2); const fs=require('node:fs');
    if(process.env.GH_HOST!=='github.com'||process.env.GH_REPO!=='github.com/acme/fixture') process.exit(9);
    if(a[0]==='api' && a.includes('--include')) {
      console.log('HTTP/2.0 200 OK\\nx-oauth-scopes: repo\\n\\n'+JSON.stringify({full_name:'acme/fixture',permissions:{push:true},has_issues:true}));
    } else if(a[0]==='api' && a[1]==='user') console.log(JSON.stringify({login:'operator'}));
    else if(a[0]==='issue' && a[1]==='list') console.log(process.env.SWARM_SMOKE_TASK ? JSON.stringify([{number:1,title:'[Task] Fixture - large prompt',body:'[Worker: codex | Model: gpt-7-nova | Reasoning: ultra]'+ '한글'.repeat(60000)}]) : '[]');
    else if(a[0]==='pr' && a[1]==='list') console.log('[]');
    else process.exit(8);`)
  // `codex debug models` lists a model no built-in table knows, capped below ultra: dispatch must use both.
  executable('codex', `if(process.argv[2]==='debug'&&process.argv[3]==='models'){
      console.log(JSON.stringify({models:[{slug:'gpt-7-nova',visibility:'list',priority:1,
        supported_reasoning_levels:['low','medium','high','xhigh'].map((effort)=>({effort}))}]}));
      process.exit(0);
    }
    let input=''; process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>input+=chunk);
    process.stdin.on('end',()=>setTimeout(()=>{
      require('node:fs').writeFileSync(process.env.SWARM_SMOKE_RESULT,JSON.stringify({input,args:process.argv.slice(2)}));
      console.log('Test quotation: rate limit exceeded');
    },300));`)
  run(git, ['init', '-b', 'main'])
  run(git, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'])
  run(git, ['remote', 'add', 'origin', 'https://github.com/acme/fixture.git'])
  run(git, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  run(node, [bundle, '--help'])
  run(node, [bundle, 'swarm', '--repo-root', repo, '--status'])
  assert.equal(fs.existsSync(path.join(repo, '.agents')), false)
  const exclude = path.join(repo, '.git', 'info', 'exclude')
  const before = fs.readFileSync(exclude, 'utf8')
  run(node, [bundle, 'swarm', '--repo-root', repo, '--dry-run', '--once'])
  assert.equal(fs.existsSync(path.join(repo, '.agents')), false)
  assert.equal(fs.readFileSync(exclude, 'utf8'), before)
  // A dry run reads the model catalog but never refreshes it: refreshing writes the cache file.
  assert.equal(fs.existsSync(catalogFile), false)
  if (process.platform !== 'win32') {
    run(node, [bundle, 'swarm', '--repo-root', repo, '--once'])
    assert.ok(fs.existsSync(path.join(repo, '.agents', '.process_registry.json')))
    // The real cycle refreshed what it could: codex answered, agy is not installed here.
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'))
    assert.deepEqual(catalog.providers.codex.models, [{ id: 'gpt-7-nova', efforts: ['low', 'medium', 'high', 'xhigh'] }])
    assert.equal(catalog.attempts.antigravity.reason, 'command-not-found')
    run(node, [bundle, 'swarm', '--repo-root', repo, '--reset', '--once'])
    const resultFile = path.join(root, 'worker-result.json')
    run(node, [bundle, 'swarm', '--repo-root', repo, '--once'], {
      env: { ...env, SWARM_SMOKE_TASK: '1', SWARM_SMOKE_RESULT: resultFile },
    })
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    assert.ok(Buffer.byteLength(result.input) > 128 * 1024)
    assert.ok(result.args.includes('--dangerously-bypass-approvals-and-sandbox'))
    // The Worker ran the refreshed model, its ultra request clamped to the highest level codex reported.
    assert.equal(result.args[result.args.indexOf('--model') + 1], 'gpt-7-nova')
    assert.ok(result.args.includes('model_reasoning_effort=xhigh'))
    assert.ok(result.args.every((arg) => !arg.includes('한글')))
    const registry = JSON.parse(fs.readFileSync(path.join(repo, '.agents', '.process_registry.json'), 'utf8'))
    const worker = registry.lifecycle_states.find((state) => state.record.role === 'worker')
    assert.equal(worker.record.status, 'completed')
    assert.equal(worker.record.exit_code, 0)
    assert.equal(worker.failure_count, 0)
    assert.deepEqual(registry.provider_cooldowns, {})
    // The CLI half of the catalog's GUI/CLI parity, against the cache the runs above wrote.
    const cli = (args) => spawnSync(node, [bundle, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 15_000 })
    const listed = cli(['providers', 'models'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /^ {2}gpt-7-nova \(low, medium, high, xhigh\)$/m)
    assert.match(listed.stdout, /^ {2}gemini-4-neon \(low, medium, high, xhigh\)$/m)
    const listedJson = JSON.parse(cli(['providers', 'models', '--json']).stdout)
    assert.ok(listedJson.models.codex.models.some((model) => model.value === 'gpt-7-nova'))
    const refreshed = cli(['providers', 'refresh-models', '--provider', 'codex'])
    assert.equal(refreshed.status, 0, refreshed.stderr)
    assert.match(refreshed.stdout, /Codex: refreshed, 1 model\(s\) from `codex debug models`/)
    // `agy` is the CLI's own name and is accepted; it is not installed here, so the command says so and fails.
    const missing = cli(['providers', 'refresh-models', '--provider', 'agy'])
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, /Antigravity \(agy\): refresh failed — the CLI is not installed or not on PATH/)
    // No Claude source here (no key, no settings): the built-in list is the answer, not a failure.
    const noSource = cli(['providers', 'refresh-models', '--provider', 'claude'])
    assert.equal(noSource.status, 0, noSource.stderr)
    assert.match(noSource.stdout, /Claude: no Anthropic API key or Claude model setting was found/)
    if (process.getuid?.() !== 0) {
      // An unwritable data directory: the fetched list is reported, the failed save makes the command fail.
      const readOnly = path.join(root, 'read-only-data')
      fs.mkdirSync(readOnly, { mode: 0o555 })
      const unsaved = spawnSync(node, [bundle, 'providers', 'refresh-models', '--provider', 'codex'],
        { cwd: repo, env: { ...env, MAO_DATA_DIR: readOnly }, encoding: 'utf8', timeout: 15_000 })
      assert.equal(unsaved.status, 1, unsaved.stderr)
      assert.match(unsaved.stdout, /could not be saved to model-catalog\.json/)
      fs.chmodSync(readOnly, 0o755)
    }
    const before = fs.readFileSync(catalogFile, 'utf8')
    const unknown = cli(['providers', 'refresh-models', '--provider', 'gemini'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /Unknown provider "gemini"/)
    assert.equal(fs.readFileSync(catalogFile, 'utf8'), before)
    const child = spawn(node, [bundle, 'swarm', '--repo-root', repo, '--interval', '1'], { cwd: repo, env })
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    // Signal after enough time to enter the idle poll sleep; shared handler must terminate promptly.
    const signal = setTimeout(() => child.kill('SIGTERM'), 1500)
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000)
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    clearTimeout(signal)
    clearTimeout(watchdog)
    assert.equal(code, 143, output)
  }
  run(node, [bundle, 'providers', 'models'])
  console.log('Single-bundle Swarm smoke passed: help, offline status, dry-run, once, reset, polling shutdown, '
    + 'model catalog refresh and dispatch; no Python/source assets')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
