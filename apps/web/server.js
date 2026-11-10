/**
 * Production entrypoint for @learning-digest/web 0.1.0. Zero dependencies:
 * node:http plus node builtins only.
 *
 * Environment:
 *   PORT            listen port (default 8080; 0 = ephemeral)
 *   LD_API_UPSTREAM API upstream base URL the /v1 proxy forwards to
 *                   (default http://127.0.0.1:8787 — apps/api's default port)
 *
 * The page never talks to the API directly: it fetches same-origin
 * /v1 paths and this server proxies them (see lib/proxy.js), so no CORS
 * is involved. Start apps/api first, then `npm start` here.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebApp } from "./lib/app.js";

function main(env = process.env) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const upstream = env.LD_API_UPSTREAM || "http://127.0.0.1:8787";
  const server = createWebApp({
    publicDir: path.join(dir, "public"),
    upstream,
  });

  const port = Number.parseInt(env.PORT || "8080", 10);
  server.listen(port, () => {
    process.stdout.write(`[web] listening on port ${server.address().port}\n`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { main };
