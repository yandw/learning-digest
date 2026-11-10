/**
 * Static file handler for the public/ bundle. Skeleton: every non-/v1
 * request answers 404 until slice 3 fleshes out file serving (tests first).
 */
export function createStaticHandler(_options = {}) {
  return async function serveStatic(_req, res) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  };
}
