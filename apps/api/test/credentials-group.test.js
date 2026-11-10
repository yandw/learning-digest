const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryStore } = require("../lib/persistence");
const { DEFAULT_CONFIG } = require("../lib/app");
const {
  issueCredential,
  authenticate,
  revokeCredential,
  revokeCredentialGroup,
} = require("../lib/credentials");

// Slice 6 (module seam): the credential-group model. Credentials of one
// account issue into the ACTIVE group; revoking one credential leaves its
// siblings alive; revoking the group kills every credential in it (the
// server-side primitive P7's linked logout will drive). A login after a
// group revocation starts a fresh group.

function makeFixtures() {
  const base = 1_700_000_000_000;
  let clock = base;
  return {
    store: createMemoryStore(),
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    config: DEFAULT_CONFIG,
    accountId: "acc_fixture",
  };
}

test("logins issue into the same active group; siblings survive single revoke", () => {
  const fx = makeFixtures();
  const first = issueCredential({ ...fx, kind: "web" });
  const second = issueCredential({ ...fx, kind: "extension" });
  assert.equal(
    second.credential.credentialGroupId,
    first.credential.credentialGroupId,
  );
  assert.equal(
    authenticate({ store: fx.store, token: second.token }).id,
    second.credential.id,
  );

  revokeCredential({ store: fx.store, token: first.token, now: fx.now });
  assert.equal(authenticate({ store: fx.store, token: first.token }), null);
  assert.ok(
    authenticate({ store: fx.store, token: second.token }),
    "sibling credential stays valid after a single revoke",
  );
});

test("revoking the group invalidates every credential in it", () => {
  const fx = makeFixtures();
  const first = issueCredential({ ...fx, kind: "web" });
  const second = issueCredential({ ...fx, kind: "extension" });
  const groupId = first.credential.credentialGroupId;

  revokeCredentialGroup({ store: fx.store, groupId, now: fx.now });
  assert.equal(authenticate({ store: fx.store, token: first.token }), null);
  assert.equal(authenticate({ store: fx.store, token: second.token }), null);
});

test("a login after group revocation starts a fresh group", () => {
  const fx = makeFixtures();
  const first = issueCredential({ ...fx, kind: "web" });
  const oldGroupId = first.credential.credentialGroupId;
  revokeCredentialGroup({ store: fx.store, groupId: oldGroupId, now: fx.now });

  fx.advance(1000);
  const next = issueCredential({ ...fx, kind: "web" });
  assert.notEqual(next.credential.credentialGroupId, oldGroupId);
  assert.ok(authenticate({ store: fx.store, token: next.token }));
});

test("revoking an unknown token is a no-op, not an error", () => {
  const fx = makeFixtures();
  const first = issueCredential({ ...fx, kind: "web" });
  revokeCredential({ store: fx.store, token: "no-such-token", now: fx.now });
  assert.ok(authenticate({ store: fx.store, token: first.token }));
});
