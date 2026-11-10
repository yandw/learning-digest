/**
 * node:http plumbing shared by all routes: body reading with a size cap,
 * JSON responses, and the contract error envelope on every failure path.
 */
const { ApiError, validationFailed, internalError } = require("./errors");

function respondJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function respondError(res, error) {
  if (error instanceof ApiError) {
    respondJson(res, error.status, error.toBody());
    return;
  }
  // Unknown failure: log for the operator, never leak internals to callers.
  process.stderr.write(`[api] unhandled error: ${error && error.stack}\n`);
  respondJson(res, internalError().status, internalError().toBody());
}

/**
 * Read the full request body as a string, capped at maxBytes.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(validationFailed("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Parse a request body as JSON. An empty body parses to `undefined`
 * (routes then report their own missing-field errors).
 */
async function readJsonBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  if (raw.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw validationFailed("请求体不是合法 JSON");
  }
}

module.exports = { respondJson, respondError, readBody, readJsonBody };
