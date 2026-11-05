import path from 'node:path'
import { chmod, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(repoRoot, 'dist-cli')
const bundlePath = path.join(outputDir, 'index.cjs')

await mkdir(outputDir, { recursive: true })
await build({
  entryPoints: [path.join(repoRoot, 'cli', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: bundlePath,
})
if (process.platform !== 'win32') {
  await chmod(bundlePath, 0o755)
}
