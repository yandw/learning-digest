/**
 * /v1 reverse proxy (decision recorded in ticket P3): the web page talks
 * only to its own origin, so this server forwards /v1/* to the API
 * upstream. Forwarding is transparent — method, Authorization header, JSON
 * body, query string — and the upstream response passes through verbatim
 * (status + error envelope), which is what keeps contract error text
 * exactly as the fixtures define it. Same-origin proxying means the page
 * needs no CORS cooperation from the API.
 */
import { Buffer } from "node:buffer";

const FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
  "referer",
];

const UPSTREAM_TIMEOUT_MS = 10_000;

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** True for the paths the proxy owns: exactly `/v1` or anything below it. */
export function isApiPath(url) {
  const pathname = (url || "/").split("?")[0];
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

/**
 * @param {object} options
 * @param {string} options.upstream base URL of the API upstream, e.g.
 *   http://127.0.0.1:8787 (no trailing slash required)
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createProxy({ upstream }) {
  const base = upstream.replace(/\/+$/, "");

  return async function proxy(req, res) {
    const headers = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined) {
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = hasBody ? await readRequestBody(req) : undefined;

    try {
      const response = await fetch(`${base}${req.url}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType =
        response.headers.get("content-type") || "application/json; charset=utf-8";
      res.writeHead(response.status, {
        "content-type": contentType,
        "content-length": buffer.length,
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : buffer);
    } catch (_error) {
      // Upstream unreachable or timed out: the contract envelope shape is
      // kept so the page can present it like any other error.
      const body = Buffer.from(
        JSON.stringify({
          error: { code: "upstream_unavailable", message: "学习服务暂时不可用，请稍后重试" },
        }),
      );
      res.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
        "content-length": body.length,
      });
      res.end(body);
    }
  };
}
