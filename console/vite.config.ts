import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The API lives in `server/`, not here.
 *
 * It was a Vite middleware while the only endpoint was the Cerebras proxy.
 * Once decisions had to persist, a dev-server plugin was the wrong home: it
 * does not exist in a production build, so anything written through it would
 * have worked only on the machine that authored it. Vite now proxies to the
 * same process that serves the built console.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? 5179}`,
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
