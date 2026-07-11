/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import fs from 'node:fs'
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

export default defineConfig({
  base: '/0x00c0dec5/',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
  },
})
