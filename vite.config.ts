import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load env files — supports VITE_API_HOST override in .env.local
  const env = loadEnv(mode, process.cwd(), '');
  // Override locally with VITE_API_HOST in .env.local if your FlowDJ
  // backend runs on another host (e.g. a headless mini-PC on your LAN).
  const apiTarget = env.VITE_API_HOST || 'http://localhost:3001';

  return {
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
          // Silence ECONNREFUSED spam when backend is briefly unreachable
          configure: (proxy) => {
            proxy.on('error', (err) => {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'ECONNREFUSED' && code !== 'ECONNRESET') {
                // eslint-disable-next-line no-console
                console.warn('[proxy]', err.message);
              }
            });
          },
        },
      },
    },
    esbuild: {
      tsconfigRaw: {
        compilerOptions: {
          experimentalDecorators: true,
          useDefineForClassFields: false,
        },
      },
    },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 2048,
    },
    optimizeDeps: {
      include: ['lit', 'three', '@pixiv/three-vrm'],
    },
  };
});
