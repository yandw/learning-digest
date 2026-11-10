/**
 * Static file handler for the public/ bundle: the login + library shell
 * (index.html), styles, and the browser binding scripts under /js/. Zero
 * build step — files are read from disk on each request (dev-oriented,
 * cache disabled) and path traversal is rejected.
 */
import fs from "node:fs";
import path from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

function methodNotAllowed(res) {
  res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
}

/** Resolve a URL path to a file inside publicDir, or null when unsafe/missing. */
function resolveFile(publicDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch (_error) {
    return null;
  }
  const target = path.normalize(path.join(publicDir, decoded === "/" ? "index.html" : decoded));
  const root = path.normalize(publicDir + path.sep);
  if (!target.startsWith(root)) {
    return null; // traversal attempt
  }
  return target;
}

/**
 * @param {object} options
 * @param {string} options.publicDir static file root
 * @param {Map<string, string>} [options.sharedFiles] URL path -> absolute
 *   file path aliases for SHARED repo sources served verbatim (the
 *   contracts UMD module under /vendor/). One file, no vendor copy that
 *   could drift; the map keys are exact pathnames, so URL-derived
 *   traversal never reaches these.
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createStaticHandler({ publicDir, sharedFiles } = {}) {
  const root = path.normalize(publicDir + path.sep);

  async function serveFile(res, file, method) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_error) {
      notFound(res);
      return;
    }
    if (!stat.isFile()) {
      // A directory request (e.g. /js/) is not a document: 404.
      notFound(res);
      return;
    }

    const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": stat.size,
      "cache-control": "no-store",
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  }

  return async function serveStatic(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      methodNotAllowed(res);
      return;
    }

    const pathname = (req.url || "/").split("?")[0];
    const shared = sharedFiles && sharedFiles.get(pathname);
    if (shared) {
      await serveFile(res, shared, req.method);
      return;
    }

    const file = resolveFile(root, req.url || "/");
    if (!file) {
      notFound(res);
      return;
    }
    await serveFile(res, file, req.method);
  };
}
