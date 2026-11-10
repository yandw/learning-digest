import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebApp } from "../../lib/app.js";

/**
 * Test harness for apps/web: starts the real web server (static files +
 * /v1 proxy) on an ephemeral loopback port against a caller-provided
 * upstream URL. Mirrors apps/api's harness shape: `request(method, path,
 * { body, headers })` returns `{ status, headers, text, json }`.
 */
export function defaultPublicDir() {
  return path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    "..",
    "public",
  );
}

export async function startWebApp({ upstream, publicDir = defaultPublicDir() } = {}) {
  const app = createWebApp({ publicDir, upstream });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const { port } = app.address();

  async function request(method, requestPath, { body, headers } = {}) {
    const init = {
      method,
      headers: { ...headers },
      signal: AbortSignal.timeout(5000),
    };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!init.headers["Content-Type"] && typeof body !== "string") {
        init.headers["Content-Type"] = "application/json";
      }
    }
    const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, init);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_error) {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  function close() {
    return new Promise((resolve) => app.close(() => resolve()));
  }

  return { port, app, request, close };
}

/** A throwaway empty directory, for tests that need no real static files. */
export function makeEmptyPublicDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-web-public-"));
  return dir;
}
