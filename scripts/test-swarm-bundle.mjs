import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Exercise a copied single bundle with no Python on PATH, no source tree and no network.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-swarm-bundle-'))
const node = process.execPath
const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const bin = path.join(root, 'bin')
const repo = path.join(root, 'repo')
const env = { ...process.env, PATH: bin, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GH_REPO: 'wrong/wrong', GH_HOST: 'wrong.example' }
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
    else if(a[0]==='issue' && a[1]==='list') console.log(process.env.SWARM_SMOKE_TASK ? JSON.stringify([{number:1,title:'[Task] Fixture - large prompt',body:'[Worker: codex | Model: gpt-5.6-terra | Reasoning: high]'+ '한글'.repeat(60000)}]) : '[]');
    else if(a[0]==='pr' && a[1]==='list') console.log('[]');
    else process.exit(8);`)
  executable('codex', `let input=''; process.stdin.setEncoding('utf8');
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
  if (process.platform !== 'win32') {
    run(node, [bundle, 'swarm', '--repo-root', repo, '--once'])
    assert.ok(fs.existsSync(path.join(repo, '.agents', '.process_registry.json')))
    run(node, [bundle, 'swarm', '--repo-root', repo, '--reset', '--once'])
    const resultFile = path.join(root, 'worker-result.json')
    run(node, [bundle, 'swarm', '--repo-root', repo, '--once'], {
      env: { ...env, SWARM_SMOKE_TASK: '1', SWARM_SMOKE_RESULT: resultFile },
    })
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    assert.ok(Buffer.byteLength(result.input) > 128 * 1024)
    assert.ok(result.args.includes('--dangerously-bypass-approvals-and-sandbox'))
    assert.ok(result.args.every((arg) => !arg.includes('한글')))
    const registry = JSON.parse(fs.readFileSync(path.join(repo, '.agents', '.process_registry.json'), 'utf8'))
    const worker = registry.lifecycle_states.find((state) => state.record.role === 'worker')
    assert.equal(worker.record.status, 'completed')
    assert.equal(worker.record.exit_code, 0)
    assert.equal(worker.failure_count, 0)
    assert.deepEqual(registry.provider_cooldowns, {})
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
  console.log('Single-bundle Swarm smoke passed: help, offline status, dry-run, once, reset, polling shutdown; no Python/source assets')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
