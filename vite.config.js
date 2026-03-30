import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor':  ['react', 'react-dom', 'react-router-dom'],
          'firebase':      ['firebase/app', 'firebase/firestore', 'firebase/auth'],
          'charts':        ['chart.js', 'react-chartjs-2'],
        },
      },
    },
  },
})
