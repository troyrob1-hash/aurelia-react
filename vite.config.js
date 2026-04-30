import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

function claudeProxy() {
  let apiKey = ''
  return {
    name: 'claude-proxy',
    configResolved(config) {
      apiKey = config.env?.VITE_ANTHROPIC_KEY || process.env.VITE_ANTHROPIC_KEY || ''
    },
    configureServer(server) {
      server.middlewares.use('/api/claude', async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(200)
          res.end()
          return
        }
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
          try {
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              },
              body,
            })
            const data = await resp.text()
            res.writeHead(resp.status, { 'Content-Type': 'application/json' })
            res.end(data)
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          }
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  process.env.VITE_ANTHROPIC_KEY = env.VITE_ANTHROPIC_KEY || ''
  return {
    plugins: [react(), claudeProxy()],
    server: { hmr: { overlay: false } },
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
  }
})
