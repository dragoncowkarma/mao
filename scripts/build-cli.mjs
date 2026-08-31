import path from 'node:path'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(repoRoot, 'dist-cli')
const bundlePath = path.join(outputDir, 'index.cjs')
const swarmAsset = path.join(outputDir, 'swarm_orchestrator.py')

await mkdir(outputDir, { recursive: true })
await build({
  entryPoints: [path.join(repoRoot, 'cli', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: bundlePath,
})
await copyFile(
  path.join(repoRoot, '.agents', 'workflows', 'swarm_orchestrator.py'),
  swarmAsset,
)

if (process.platform !== 'win32') {
  await Promise.all([chmod(bundlePath, 0o755), chmod(swarmAsset, 0o755)])
}
