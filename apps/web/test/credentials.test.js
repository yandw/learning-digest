import { test } from "node:test";
import assert from "node:assert/strict";
import { createCredentialStore, CREDENTIALS_KEY } from "../public/js/credentials.js";

// Credential persistence (pure module over an injectable storage seam).
// The page passes window.localStorage; tests pass a Map-backed fake.
// Shape mirrors the verify response so the credential can be re-presented
// as `Authorization: Bearer <token>` on every request.

function mapStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const CREDENTIAL = {
  token: "token-abc123",
  email: "learner@example.com",
  accountId: "acc_01",
  credentialGroupId: "cg_01",
};

test("set then get returns the same credential fields", () => {
  const credentials = createCredentialStore({ storage: mapStorage() });
  credentials.set(CREDENTIAL);
  assert.deepEqual(credentials.get(), CREDENTIAL);
});

test("credentials live under one stable localStorage key", () => {
  assert.equal(CREDENTIALS_KEY, "learning-digest.web.credentials");
});

test("missing credentials read as null", () => {
  const credentials = createCredentialStore({ storage: mapStorage() });
  assert.equal(credentials.get(), null);
});

test("clear empties the stored credential", () => {
  const credentials = createCredentialStore({ storage: mapStorage() });
  credentials.set(CREDENTIAL);
  credentials.clear();
  assert.equal(credentials.get(), null);
});

test("corrupted storage contents read as null instead of throwing", () => {
  const storage = mapStorage();
  storage.setItem(CREDENTIALS_KEY, "{not json");
  const credentials = createCredentialStore({ storage });
  assert.equal(credentials.get(), null);
});

test("credential without a token reads as null", () => {
  const storage = mapStorage();
  storage.setItem(CREDENTIALS_KEY, JSON.stringify({ email: "x@y.com" }));
  const credentials = createCredentialStore({ storage });
  assert.equal(credentials.get(), null);
});
