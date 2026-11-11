/**
 * App factory: wires the /v1 router onto a real node:http.Server with all
 * seams injectable (store, mailer, clock, config). Tests listen on an
 * ephemeral port; `server.js` wires production defaults and listens.
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createRouter } = require("./router");
const { respondJson, respondError, readJsonBody } = require("./http");
const { isApiPath, applyCors } = require("./cors");
const { registerRoutes } = require("./routes");
const { createMemoryMailer } = require("./mailer");
const { createMemoryStore } = require("./persistence");
const { loadSeedInvites } = require("./invites");

const DEFAULT_CONFIG = Object.freeze({
  // Verification code lifetime. Decision: 10 minutes, a normal email-code
  // window; configurable so trials can tighten it.
  codeTtlMs: 10 * 60 * 1000,
  // Link code lifetime (P6): the one-time code travels through the browser
  // location bar, so it lives only as long as a focused link confirmation.
  linkCodeTtlMs: 10 * 60 * 1000,
  // Failed verification attempts allowed per code before it is invalidated
  // (brute-force guard). 5 tries on a 6-digit code.
  codeMaxAttempts: 5,
  // Minimum interval between two codes for the same email. Extra requests
  // inside the window answer 200 but do not resend (anti-enumeration).
  codeResendCooldownMs: 60 * 1000,
  // Bearer credential token entropy.
  tokenBytes: 32,
  // Request body cap. The round-2 audio-segment route widens this for
  // itself (router route option) to carry ~10MB of base64 audio.
  maxBodyBytes: 64 * 1024,
  // Worker service credential for the round-2 /v1/worker/tasks endpoints
  // (contract-r2 §3.7): a statically configured bearer token. Empty string
  // means no worker credential is valid (endpoints answer 401) — server.js
  // fills it from LD_API_WORKER_TOKEN.
  workerToken: "",
  // Temporary audio directory for uploaded segments (D14: bytes are temp
  // files outside the repo; the store keeps only paths).
  audioDir: path.join(os.tmpdir(), "ld-api-audio"),
});

/**
 * @param {object} [options]
 * @param {object} [options.store] generic collection store (defaults to none;
 *   routes that need persistence receive whatever is provided)
 * @param {object} [options.mailer] Mailer seam implementation
 * @param {() => number} [options.now] injectable clock (ms epoch)
 * @param {object} [options.config] config overrides over DEFAULT_CONFIG
 * @param {string} [options.seedFile] invited-email seed file to load
 * @returns {import("node:http").Server}
 */
function createApp(options = {}) {
  const store = options.store || createMemoryStore();
  const mailer = options.mailer || createMemoryMailer();
  const now = options.now || (() => Date.now());
  const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };

  // Invited emails are data: the seed file is loaded into the store on
  // every startup, idempotently (scripts/invite.js adds more at runtime).
  loadSeedInvites(store, options.seedFile, now);

  const router = createRouter();
  registerRoutes({ router, store, mailer, now, config, seedFile: options.seedFile });

  const server = http.createServer((req, res) => {
    dispatch(req, res, router, config);
  });
  server.timeout = 10_000;
  server.requestTimeout = 10_000;
  return server;
}

async function dispatch(req, res, router, config) {
  try {
    // CORS owns /v1 (the extension's service worker fetches these paths
    // cross-origin); an OPTIONS preflight is answered here and never
    // reaches the router (which has no OPTIONS routes).
    if (isApiPath(req.url) && applyCors(req, res)) {
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const { handler, params, maxBodyBytes } = router.match(req.method, url.pathname);
    const body = await readJsonBody(req, maxBodyBytes || config.maxBodyBytes);
    const result = await handler({ req, res, params, body, url });
    if (!res.writableEnded) {
      respondJson(res, (result && result.status) || 200, (result && result.body) || {});
    }
  } catch (error) {
    if (!res.writableEnded) {
      respondError(res, error);
    }
  }
}

module.exports = { createApp, DEFAULT_CONFIG };
