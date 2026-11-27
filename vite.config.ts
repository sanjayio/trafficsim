import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import process from "node:process";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/** The game and the website pages: each is a folder with an index.html, served at /<folder>/. */
const PAGES = ["", "play", "features", "changelog", "about", "contribute"];

/** Fills `<!-- @head -->`, `<!-- @header -->` and `<!-- @footer -->` from src/site, and marks the current page's nav links. */
function sitePartials(): Plugin {
  return {
    name: "site-partials",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const page = ctx.path.replace(/index\.html$/, "");
        return html
          .replace(/<!-- @(head|header|footer) -->/g, (_, name) => fs.readFileSync(`src/site/${name}.html`, "utf8"))
          .replaceAll(`href="${page}" class=`, `href="${page}" aria-current="page" class=`);
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), sitePartials()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rolldownOptions: { input: PAGES.map((p) => `${p ? `${p}/` : ""}index.html`) },
  },
}));
