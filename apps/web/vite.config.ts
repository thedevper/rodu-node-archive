import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm --filter @shoal/web dev` proxies the API to a running `shoal web --port 4870`.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4870", changeOrigin: true } },
  },
});
