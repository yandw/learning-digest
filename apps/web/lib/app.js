/**
 * Web app factory: a real node:http.Server that serves the static page
 * bundle for everything except `/v1/*`, which is proxied to the API
 * upstream (see proxy.js). Tests listen on an ephemeral port;
 * `server.js` wires production defaults.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProxy, isApiPath } from "./proxy.js";
import { createStaticHandler } from "./static-files.js";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Shared repo sources served verbatim under /vendor/: the contracts UMD
// module for the page's client-side identity extraction (the same single
// file apps/api requires — no vendor copy that could drift).
const SHARED_FILES = new Map([
  ["/vendor/platform-video-id.js", path.join(webRoot, "..", "..", "contracts", "platform-video-id.js")],
]);

/**
 * @param {object} [options]
 * @param {string} [options.publicDir] static file root (defaults to ./public)
 * @param {string} [options.upstream] API upstream base URL (defaults to
 *   http://127.0.0.1:8787, apps/api's default port)
 * @returns {import("node:http").Server}
 */
export function createWebApp(options = {}) {
  const publicDir = options.publicDir;
  const upstream = options.upstream || "http://127.0.0.1:8787";

  const proxy = createProxy({ upstream });
  const serveStatic = createStaticHandler({ publicDir, sharedFiles: SHARED_FILES });

  const server = http.createServer(async (req, res) => {
    try {
      if (isApiPath(req.url)) {
        await proxy(req, res);
      } else {
        await serveStatic(req, res);
      }
    } catch (_error) {
      if (!res.writableEnded) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: { code: "internal_error", message: "服务内部错误" },
          }),
        );
      }
    }
  });
  server.timeout = 15_000;
  server.requestTimeout = 15_000;
  return server;
}
