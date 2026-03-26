/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/0x00c0dec5/',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
  },
})
