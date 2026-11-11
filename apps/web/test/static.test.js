import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWebApp } from "./helpers/web.js";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Seam: static serving of the public/ bundle. The shell is a single
// index.html that hosts both the login view and the library view; the
// binding lives in /js/main.js. This seam catches a broken bundle mount
// or path traversal; it does not test rendering (no browser automation).

async function startWithPublicDir() {
  const web = await startWebApp();
  return web;
}

test("GET / serves the shell with login and library views wired to main.js", async () => {
  const web = await startWithPublicDir();
  try {
    const response = await web.request("GET", "/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(response.text, /id="loginView"/);
    assert.match(response.text, /id="libraryView"/);
    assert.match(response.text, /\/js\/main\.js/);
    assert.match(response.text, /lang="zh-CN"/);
    // P5: the collect form, the list and the detail view are part of the
    // shell, and the shared UMD module loads before the page module.
    assert.match(response.text, /id="collectForm"/);
    assert.match(response.text, /id="resourceList"/);
    assert.match(response.text, /id="detailSection"/);
    assert.match(response.text, /src="\/vendor\/platform-video-id\.js"/);
    // Round 3 (#75): the summaries block (generate button, history, content)
    // mounts after the transcript block, and the usage entry lives in the
    // account area with its panel below the topbar.
    assert.match(response.text, /id="generateSummaryBtn"/);
    assert.match(response.text, /id="summariesHistory"/);
    assert.match(response.text, /id="summaryContent"/);
    assert.match(response.text, /id="detailTranscripts"[\s\S]*id="detailSummaries"/);
    assert.match(response.text, /id="usageBtn"/);
    assert.match(response.text, /id="usagePanel"/);
  } finally {
    await web.close();
  }
});

test("styles and scripts are served with matching content types", async () => {
  const web = await startWithPublicDir();
  try {
    const css = await web.request("GET", "/styles.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const main = await web.request("GET", "/js/main.js");
    assert.equal(main.status, 200);
    assert.match(main.headers.get("content-type"), /javascript/);

    const flow = await web.request("GET", "/js/login-flow.js");
    assert.equal(flow.status, 200);
    assert.match(flow.headers.get("content-type"), /javascript/);
  } finally {
    await web.close();
  }
});

test("GET /link.html serves the extension link confirmation page (P6)", async () => {
  const web = await startWithPublicDir();
  try {
    const response = await web.request("GET", "/link.html");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(response.text, /id="linkConfirmView"/);
    assert.match(response.text, /id="confirmLinkBtn"/);
    assert.match(response.text, /id="linkDoneView"/);
    assert.match(response.text, /\/js\/link\.js/);

    const binding = await web.request("GET", "/js/link.js");
    assert.equal(binding.status, 200);
    assert.match(binding.headers.get("content-type"), /javascript/);

    const flowModule = await web.request("GET", "/js/link-flow.js");
    assert.equal(flowModule.status, 200);
    assert.match(flowModule.headers.get("content-type"), /javascript/);
  } finally {
    await web.close();
  }
});

test("unknown static paths answer 404", async () => {
  const web = await startWithPublicDir();
  try {
    const response = await web.request("GET", "/no-such-page.html");
    assert.equal(response.status, 404);
  } finally {
    await web.close();
  }
});

test("path traversal cannot read files outside public/", async () => {
  const web = await startWithPublicDir();
  try {
    // Encoded ../ escape: must never serve a file outside public/.
    const response = await web.request("GET", "/%2e%2e/lib/app.js");
    assert.equal(response.status, 404);

    const deeper = await web.request("GET", "/js/%2e%2e/%2e%2e/server.js");
    assert.equal(deeper.status, 404);
  } finally {
    await web.close();
  }
});

test("the shared platform-video-id UMD module is served under /vendor/ verbatim", async () => {
  const web = await startWithPublicDir();
  try {
    const response = await web.request("GET", "/vendor/platform-video-id.js");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    // The alias serves the SHARED contracts source byte-identically: one
    // file, no vendor copy that could drift (the API requires the same
    // file directly).
    const sharedSource = fs.readFileSync(
      path.join(webRoot, "..", "..", "contracts", "platform-video-id.js"),
      "utf8",
    );
    assert.equal(response.text, sharedSource);
    assert.match(response.text, /YTD_PLATFORM_VIDEO_ID/);
  } finally {
    await web.close();
  }
});

test("empty public dir still answers 404 without crashing", async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-web-empty-"));
  const web = await startWebApp({ publicDir: emptyDir });
  try {
    const response = await web.request("GET", "/");
    assert.equal(response.status, 404);
  } finally {
    await web.close();
  }
});
