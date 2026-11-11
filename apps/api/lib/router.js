/**
 * Minimal /v1 route table: exact segments plus `:name` params.
 * P4/P9/P12 will register `/v1/resources/{id}`-style routes on the same table.
 *
 * Matching precedence for one pathname:
 * 1. a route whose pattern (method + segments) matches fully -> dispatch
 * 2. a route whose segments match but method differs        -> 405
 * 3. nothing matches                                        -> 404
 */
const { notFoundUnknownPath, methodNotAllowed } = require("./errors");

function createRouter() {
  const routes = [];

  /**
   * `options.maxBodyBytes` lets an individual route widen the request-body
   * cap (the round-2 audio route carries up to ~10MB of base64 audio);
   * routes without the option use the app-wide cap.
   */
  function add(method, pattern, handler, options = {}) {
    routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter((segment) => segment.length > 0),
      pattern,
      handler,
      maxBodyBytes: options.maxBodyBytes,
    });
  }

  function match(method, pathname) {
    const pathSegments = pathname.split("/").filter((s) => s.length > 0);
    let methodMismatch = false;
    for (const route of routes) {
      if (route.segments.length !== pathSegments.length) {
        continue;
      }
      const params = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const patternSegment = route.segments[i];
        if (patternSegment.startsWith(":")) {
          params[patternSegment.slice(1)] = pathSegments[i];
        } else if (patternSegment !== pathSegments[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) {
        continue;
      }
      if (route.method !== method.toUpperCase()) {
        methodMismatch = true;
        continue;
      }
      return { handler: route.handler, params, maxBodyBytes: route.maxBodyBytes };
    }
    if (methodMismatch) {
      throw methodNotAllowed();
    }
    throw notFoundUnknownPath();
  }

  return { add, match };
}

module.exports = { createRouter };
