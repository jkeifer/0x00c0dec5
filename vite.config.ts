/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Generate src/build-info.js here (not npm pre-hooks) so every consumer of this
// config — dev server, build, vitest, preview — gets it, including direct
// `vitest`/`vite` invocations that skip npm's predev/prebuild hooks.
try {
  execSync('node scripts/get-git-info.js', { stdio: 'pipe' })
} catch (error) {
  if (!fs.existsSync('src/build-info.js')) {
    throw error
  }
  console.warn('Warning: build-info generation failed, reusing existing src/build-info.js:', error)
}

// Dataset presets: serve /0x00c0dec5/data-dev/* in dev from the local
// extraction output (data-branch-work/), falling back to the committed
// synthetic fixtures (tests/fixtures/) so dev + scenarios work with no
// network and no extraction run. Prod uses the data branch's raw URLs
// (src/datasets/registry.ts).
const dataDevPlugin = () => ({
  name: 'serve-dataset-dev',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      const prefix = '/0x00c0dec5/data-dev/'
      const url = (req.url ?? '').split('?')[0]
      if (!url.startsWith(prefix)) return next()
      const rel = path.normalize(url.slice(prefix.length))
      if (rel.startsWith('..') || path.isAbsolute(rel)) { res.statusCode = 400; return res.end() }
      for (const root of ['data-branch-work', path.join('tests', 'fixtures')]) {
        const file = path.join(root, rel)
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream')
          return fs.createReadStream(file).pipe(res)
        }
      }
      res.statusCode = 404
      res.end(`dataset dev asset not found: ${rel} (run scripts/datasets/*.ts or gen-fixtures.ts)`)
    })
  },
})

export default defineConfig({
  base: '/0x00c0dec5/',
  plugins: [react(), dataDevPlugin()],
  test: {
    globals: true,
    environment: 'node',
  },
})
