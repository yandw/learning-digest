/**
 * CORS for /v1 (P6): the browser extension's service worker calls the API
 * from a chrome-extension:// origin, so fetch needs the API's CORS
 * cooperation — host_permissions stay untouched (ticket #26 stays open).
 *
 * Round-1 rules:
 * - any origin is echoed back in Access-Control-Allow-Origin (a dev setup
 *   serves the Web app and the unpacked extension from arbitrary local
 *   origins; there is no cookie auth to protect — credentials are Bearer
 *   headers the caller already holds)
 * - preflights (OPTIONS) are answered directly with 204 and the allowed
 *   headers the clients actually send (Authorization, Content-Type)
 * - the middleware only owns /v1 paths; every other path is left untouched
 */
const ALLOWED_HEADERS = "Authorization, Content-Type";
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const MAX_AGE_SECONDS = 600;

/** True for the paths CORS owns: exactly `/v1` or anything below it. */
function isApiPath(url) {
  const pathname = (url || "/").split("?")[0];
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

/**
 * Apply the CORS response headers. Returns true when the request was a
 * preflight that has been answered (204) and must not reach the router.
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", typeof origin === "string" ? origin : "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Max-Age": String(MAX_AGE_SECONDS) });
    res.end();
    return true;
  }
  return false;
}

module.exports = { isApiPath, applyCors, ALLOWED_HEADERS, ALLOWED_METHODS };
