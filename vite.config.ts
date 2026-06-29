import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"),
);

// Tauri expects a fixed port and host during dev
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
