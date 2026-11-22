import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development, Vite serves the UI on :5173 and proxies API calls to the .NET server on :5080.
// `pnpm build` writes the finished UI into the server's wwwroot so it ships inside the app.
export default defineConfig({
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
    outDir: '../HubWatch.Server/wwwroot',
    emptyOutDir: true,
  },
})
