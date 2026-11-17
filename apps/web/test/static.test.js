import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWebApp } from "./helpers/web.js";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Static serving of the built React application and the shared browser-flow
// modules. Run the production build before this suite; component behavior is
// covered separately by the Vitest suites.

async function startWithPublicDir() {
  return startWebApp();
}

test("GET / serves the built React learning workbench", async () => {
  const web = await startWithPublicDir();
  try {
    const response = await web.request("GET", "/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(response.text, /id="root"/);
    assert.match(response.text, /lang="zh-CN"/);
    assert.match(response.text, /src="\/vendor\/platform-video-id\.js"/);
    assert.match(response.text, /type="module"[^>]*src="\/assets\/.*\.js"/);
    assert.doesNotMatch(response.text, /\/js\/main\.js/);
  } finally {
    await web.close();
  }
});

test("built styles and shared scripts are served with matching content types", async () => {
  const web = await startWithPublicDir();
  try {
    const shell = await web.request("GET", "/");
    const cssPath = /href="(\/assets\/[^"]+\.css)"/.exec(shell.text)?.[1];
    assert.ok(cssPath, "the React entry references its built stylesheet");
    const css = await web.request("GET", cssPath);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const flow = await web.request("GET", "/js/login-flow.js");
    assert.equal(flow.status, 200);
    assert.match(flow.headers.get("content-type"), /javascript/);
  } finally {
    await web.close();
  }
});

test("GET /link.html serves the React extension link confirmation page", async () => {
  const web = await startWithPublicDir();
  try {
    const response = await web.request("GET", "/link.html");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(response.text, /id="root"/);
    assert.match(response.text, /type="module"[^>]*src="\/assets\/.*\.js"/);
    assert.doesNotMatch(response.text, /\/js\/link\.js/);

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
