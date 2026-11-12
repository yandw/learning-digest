"""Slice 6 (module seam): the credential-group model. Credentials of one
account issue into the ACTIVE group; revoking one credential leaves its
siblings alive; revoking the group kills every credential in it (the
server-side primitive P7's linked logout drives). A login after a group
revocation starts a fresh group. Ported intent:
apps/api/test/credentials-group.test.js. Seam: the credentials module
functions against a MemoryStore — the same seam routes use."""

from app.config import DEFAULT_CONFIG
from app.credentials import (
    authenticate,
    issue_credential,
    revoke_credential,
    revoke_credential_group,
)
from app.persistence import create_memory_store


def make_fixtures():
    base = 1_700_000_000_000
    clock = {"ms": base}
    return {
        "store": create_memory_store(),
        "now": lambda: clock["ms"],
        "advance": lambda ms: clock.update(ms=clock["ms"] + ms),
        "config": DEFAULT_CONFIG,
        "account_id": "acc_fixture",
    }


def test_logins_issue_into_the_same_active_group_siblings_survive_single_revoke():
    fx = make_fixtures()
    first = issue_credential(store=fx["store"], account_id=fx["account_id"], kind="web", now=fx["now"], config=fx["config"])
    second = issue_credential(store=fx["store"], account_id=fx["account_id"], kind="extension", now=fx["now"], config=fx["config"])
    assert second["credential"]["credentialGroupId"] == first["credential"]["credentialGroupId"]
    assert authenticate(store=fx["store"], token=second["token"])["id"] == second["credential"]["id"]

    revoke_credential(store=fx["store"], token=first["token"], now=fx["now"])
    assert authenticate(store=fx["store"], token=first["token"]) is None
    assert (
        authenticate(store=fx["store"], token=second["token"]) is not None
    ), "sibling credential stays valid after a single revoke"


def test_revoking_the_group_invalidates_every_credential_in_it():
    fx = make_fixtures()
    first = issue_credential(store=fx["store"], account_id=fx["account_id"], kind="web", now=fx["now"], config=fx["config"])
    second = issue_credential(store=fx["store"], account_id=fx["account_id"], kind="extension", now=fx["now"], config=fx["config"])
    group_id = first["credential"]["credentialGroupId"]

    revoke_credential_group(store=fx["store"], group_id=group_id, now=fx["now"])
    assert authenticate(store=fx["store"], token=first["token"]) is None
    assert authenticate(store=fx["store"], token=second["token"]) is None


def test_a_login_after_group_revocation_starts_a_fresh_group():
    fx = make_fixtures()
    first = issue_credential(store=fx["store"], account_id=fx["account_id"], kind="web", now=fx["now"], config=fx["config"])
    old_group_id = first["credential"]["credentialGroupId"]
    revoke_credential_group(store=fx["store"], group_id=old_group_id, now=fx["now"])

    fx["advance"](1000)
    nxt = issue_credential(store=fx["store"], account_id=fx["account_id"], kind="web", now=fx["now"], config=fx["config"])
    assert nxt["credential"]["credentialGroupId"] != old_group_id
    assert authenticate(store=fx["store"], token=nxt["token"]) is not None


def test_revoking_an_unknown_token_is_a_no_op_not_an_error():
    fx = make_fixtures()
    first = issue_credential(store=fx["store"], account_id=fx["account_id"], kind="web", now=fx["now"], config=fx["config"])
    revoke_credential(store=fx["store"], token="no-such-token", now=fx["now"])
    assert authenticate(store=fx["store"], token=first["token"]) is not None
