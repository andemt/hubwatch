import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development, Vite serves the UI on :5173 and proxies API calls to the .NET server on :5080.
// `pnpm build` writes the finished UI into the server's wwwroot so it ships inside the app.
// `pnpm build:demo` (mode "demo") builds a stand-alone demo without backend into dist-demo. Set HUBWATCH_DEMO_BASE
// when it is served from a subfolder, e.g. "/hubwatch/" on GitHub Pages.
export default defineConfig(({ mode }) => ({
  base: mode === 'demo' ? (process.env.HUBWATCH_DEMO_BASE ?? '/') : '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5080',
        changeOrigin: true,
        // When the backend stops mid-response (e.g. dotnet watch restarts), close the browser's side too. Otherwise
        // the live event stream stays open but silent, and the page never notices it should reconnect.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            proxyRes.on('close', () => {
              if (!res.writableEnded) res.destroy()
            })
          })
        },
      },
    },
  },
  build: {
    outDir: mode === 'demo' ? 'dist-demo' : '../HubWatch.Server/wwwroot',
    emptyOutDir: true,
  },
}))
