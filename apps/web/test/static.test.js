import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWebApp } from "./helpers/web.js";

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
