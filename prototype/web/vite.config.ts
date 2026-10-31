import { defineConfig, type Plugin } from "vite";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// The Wasmer SDK spawns its own worker pool from files resolved relative to
// import.meta.url, and bundling breaks that. So it is not bundled: the dist/ and
// pkg/ folders are copied verbatim and the worker loads them at runtime.
function copyWasmerSdk(): Plugin {
  return {
    name: "copy-wasmer-sdk",
    apply: "build",
    closeBundle() {
      const src = resolve("node_modules/@wasmer/sdk");
      const out = resolve("dist/wasmer-sdk");
      mkdirSync(out, { recursive: true });
      cpSync(resolve(src, "dist"), resolve(out, "dist"), { recursive: true });
      cpSync(resolve(src, "pkg"), resolve(out, "pkg"), { recursive: true });
    },
  };
}

// PROTOTYPE. Served under /gfs/ on GitHub Pages; "/" locally.
export default defineConfig(({ command }) => ({
  base: command === "build" ? (process.env.BASE_PATH ?? "/gfs/") : "/",
  plugins: [copyWasmerSdk()],
  worker: { format: "es" },
  build: { target: "esnext", sourcemap: true },
  optimizeDeps: { exclude: ["@wasmer/sdk"] },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
}));
