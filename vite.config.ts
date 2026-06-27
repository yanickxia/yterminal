import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and host during dev
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    watch: {
      // tauri's rust source should not trigger a frontend reload
      ignored: ["**/src-tauri/**"],
    },
  },
  // produce a build that targets the system webview
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
