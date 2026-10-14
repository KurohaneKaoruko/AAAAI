import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// WebUI 开发服务器；生产构建输出到 web/dist，由 Express 托管
export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
