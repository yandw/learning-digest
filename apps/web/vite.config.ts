import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

const platformVideoIdPath = fileURLToPath(
  new URL("../../contracts/platform-video-id.js", import.meta.url),
);

function sharedPlatformVideoId(): Plugin {
  return {
    name: "shared-platform-video-id",
    configureServer(server) {
      server.middlewares.use("/vendor/platform-video-id.js", (_request, response) => {
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(readFileSync(platformVideoIdPath, "utf8"));
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "vendor/platform-video-id.js",
        source: readFileSync(platformVideoIdPath, "utf8"),
      });
    },
  };
}

export default defineConfig({
  plugins: [sharedPlatformVideoId(), react()],
  publicDir: "public",
  server: {
    host: "0.0.0.0",
    proxy: {
      "/v1": {
        target: process.env.LD_API_UPSTREAM || "http://127.0.0.1:8787",
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        link: fileURLToPath(new URL("./link.html", import.meta.url)),
      },
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    restoreMocks: true,
  },
});
