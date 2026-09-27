"""Independent adversarial verification (P3) over the REAL built Hub.

Nothing here re-runs the implementer's happy path for its own sake: each test
tries to FALSIFY one §6 claim, at the wire level, by speaking JSON-RPC directly
to the shipped Hub (``opencode-plugin/lib/index.js`` via
``tests/harness/live-hub-harness.mjs``).  The Hub, its endpoint file and the
NDJSON transport are all real; only the OpenCode host is the harness stub.

Claims exercised: §6① 绝不 always, §6② 首答锁定, §6⑤ 设备绑定, §6⑥ 高危本地确认.
Requires `yarn build` in `opencode-plugin` (the harness loads `lib/index.js`).
"""

from __future__ import annotations

import asyncio
import hashlib
import json

import pytest

from connector.runtimes.opencode.bridge.client import BridgeClient, BridgeRpcError

# Reuse the shipped live harness/fixture unchanged (same Hub, same endpoints).
from test_opencode_bridge_live_integration import (  # type: ignore[import-not-found]
    CONNECTOR_ID,
    LIB_ENTRY,
    NATIVE_A,
    NAMESPACE,
    LiveHub,
    _noop_exit,
    live_hub,  # noqa: F401 - pytest fixture, re-exported for this module
)

pytestmark = pytest.mark.skipif(
    not LIB_ENTRY.exists(),
    reason=f"live bridge integration needs a built {LIB_ENTRY} (run `yarn build` in opencode-plugin)",
)


def platform_id(namespace: str, native: str) -> str:
    digest = hashlib.sha256(f"{namespace}:opencode:{native}".encode()).hexdigest()
    return f"sess_opencode_{digest[:24]}"


SESSION_A = platform_id(NAMESPACE, NATIVE_A)


async def _noop(*_args: object, **_kwargs: object) -> None:
    return None


def raw_client(
    hub: LiveHub,
    *,
    connector_id: str = CONNECTOR_ID,
    namespace: str = NAMESPACE,
    location=None,
) -> BridgeClient:
    """A hand-built connection so we can claim arbitrary device identities."""
    where = hub.loc_a if location is None else location
    endpoint = hub.resolve_endpoint(where)
    assert endpoint is not None, "the hub must publish an endpoint for this location"
    return BridgeClient(
        endpoint=endpoint,
        connector_id=connector_id,
        client_version="1.0",
        session_namespace=namespace,
        location=str(where),
        startup_timeout=10.0,
        request_timeout=10.0,
        notification_handler=_noop,
        exit_handler=_noop_exit,
    )


async def respond(client: BridgeClient, session_id: str, notice_id: str, action_id: str, **extra: object):
    params: dict[str, object] = {"sessionId": session_id, "noticeId": notice_id, "actionId": action_id}
    params.update(extra)
    return await client.request("session.respondInteraction", params)


# --------------------------------------------------------------- §6① never always
def test_wire_never_accepts_a_persistent_or_malformed_action(live_hub: LiveHub) -> None:
    live_hub.seed_demo_session()
    variants = [
        "always", "Always", "ALWAYS", "AlWaYs", " always", "always ",
        "always\t", "allow_always", "permanent", "once", "/always",
        "ALLOW_ONCE", "allow_once ", "deny ",
    ]

    async def scenario() -> None:
        client = raw_client(live_hub)
        await client.start()
        try:
            # §6⑤: claim the session first — an unclaimed notice fails closed.
            await client.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            for i, variant in enumerate(variants):
                rid = f"req_adv_{i}"
                live_hub.permission({"id": rid, "action": "webfetch", "sessionID": NATIVE_A})
                result = await respond(
                    client, SESSION_A, f"notice_{rid}", variant, inputData={"reply": "always"}
                )
                assert result["ok"] is False, (variant, result)
                assert result["code"] == "unsupported_action", (variant, result)

            # A fresh legal answer still lands, and reply only ever sees once/reject.
            live_hub.permission({"id": "req_ok", "action": "webfetch", "sessionID": NATIVE_A})
            ok = await respond(client, SESSION_A, "notice_req_ok", "allow_once")
            assert ok["ok"] is True, ok
            live_hub.permission({"id": "req_no", "action": "webfetch", "sessionID": NATIVE_A})
            assert (await respond(client, SESSION_A, "notice_req_no", "deny"))["ok"] is True

            replies = live_hub.replies()
            assert [r["body"]["reply"] for r in replies] == ["once", "reject"], replies
            assert all("always" not in json.dumps(r) for r in replies), replies
        finally:
            await client.close()

    asyncio.run(scenario())


def test_wire_extra_fields_cannot_smuggle_a_persistent_reply(live_hub: LiveHub) -> None:
    live_hub.seed_demo_session()

    async def scenario() -> None:
        client = raw_client(live_hub)
        await client.start()
        try:
            await client.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            live_hub.permission({"id": "req_smug", "action": "webfetch", "sessionID": NATIVE_A})
            result = await respond(
                client,
                SESSION_A,
                "notice_req_smug",
                "allow_once",
                reply="always",
                body={"reply": "always"},
                permission={"action": "always"},
                actions=[{"actionId": "always"}],
                save=True,
            )
            assert result["ok"] is True, result
            assert live_hub.replies() == [
                {"path": {"requestID": "req_smug"}, "body": {"reply": "once"}}
            ], live_hub.replies()
        finally:
            await client.close()

    asyncio.run(scenario())


# --------------------------------------------------------------- §6② first-answer lock
def test_wire_concurrent_answers_one_wins_and_other_notice_is_untouched(live_hub: LiveHub) -> None:
    live_hub.seed_demo_session()

    async def scenario() -> None:
        client = raw_client(live_hub)
        await client.start()
        try:
            await client.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            live_hub.permission({"id": "req_race", "action": "webfetch", "sessionID": NATIVE_A})
            live_hub.permission({"id": "req_other", "action": "webfetch", "sessionID": NATIVE_A})
            first, second = await asyncio.gather(
                respond(client, SESSION_A, "notice_req_race", "allow_once"),
                respond(client, SESSION_A, "notice_req_race", "deny"),
            )
            outcomes = [first, second]
            assert [o["ok"] for o in outcomes].count(True) == 1, outcomes
            loser = next(o for o in outcomes if o["ok"] is False)
            assert loser["code"] == "already_answered", loser
            race_replies = [r for r in live_hub.replies() if r["path"]["requestID"] == "req_race"]
            assert len(race_replies) == 1, race_replies

            # The sibling notice must be fully independent of the race.
            other = await respond(client, SESSION_A, "notice_req_other", "allow_once")
            assert other["ok"] is True, other
            assert live_hub.replies()[-1]["path"]["requestID"] == "req_other"
        finally:
            await client.close()

    asyncio.run(scenario())


# --------------------------------------------------------------- §6⑤ device binding
def test_wire_cross_location_answer_is_rejected(live_hub: LiveHub) -> None:
    live_hub.seed_demo_session()
    live_hub.permission({"id": "req_loc", "action": "webfetch", "sessionID": NATIVE_A})

    async def scenario() -> None:
        outsider = raw_client(live_hub, location=live_hub.loc_b)
        await outsider.start()
        try:
            with pytest.raises(BridgeRpcError):
                await respond(outsider, SESSION_A, "notice_req_loc", "allow_once")
        finally:
            await outsider.close()
        assert [r for r in live_hub.replies() if r["path"]["requestID"] == "req_loc"] == []

    asyncio.run(scenario())


def test_wire_second_device_cannot_answer_another_connections_notice(live_hub: LiveHub) -> None:
    """§6⑤ per-device binding: same location, different connectorId → refused.

    The victim (the connection that owns the session stream) claims the session
    first, so the notice is bound to ``live-connector``.  A second authenticated
    connection with a DIFFERENT connectorId / namespace, pointed at the SAME
    location, must be refused with a code distinct from ``unknown_notice`` — and
    must never reach ``permission.reply``.
    """
    live_hub.seed_demo_session()

    async def scenario() -> None:
        victim = raw_client(live_hub)
        rogue = raw_client(live_hub, connector_id="rogue-device", namespace="rogue:ns")
        await victim.start()
        await rogue.start()
        try:
            # The victim claims the session by opening its stream (§6⑤ owner).
            await victim.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            live_hub.permission({"id": "req_bind", "action": "webfetch", "sessionID": NATIVE_A})

            rogue_session = platform_id("rogue:ns", NATIVE_A)
            outcome = await respond(rogue, rogue_session, "notice_req_bind", "allow_once")
            assert outcome["ok"] is False, outcome
            assert outcome["code"] == "device_mismatch", outcome
            assert live_hub.replies() == [], live_hub.replies()

            # The owning device still answers normally.
            accepted = await respond(victim, SESSION_A, "notice_req_bind", "allow_once")
            assert accepted["ok"] is True, accepted
            assert live_hub.replies()[-1] == {
                "path": {"requestID": "req_bind"},
                "body": {"reply": "once"},
            }, live_hub.replies()
        finally:
            await rogue.close()
            await victim.close()

    asyncio.run(scenario())


# --------------------------------------------------------------- §6⑥ high-risk local-only
def test_wire_enumerated_high_risk_actions_stay_local_only(live_hub: LiveHub) -> None:
    live_hub.seed_demo_session()
    high = ["write", "EDIT", "Patch", "Bash", "SHELL", "rm", "move", "mv", "delete", "execute", "run"]

    async def scenario() -> None:
        client = raw_client(live_hub)
        await client.start()
        try:
            await client.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            for i, action in enumerate(high):
                rid = f"req_high_{i}"
                live_hub.permission({"id": rid, "action": action, "sessionID": NATIVE_A})
                result = await respond(client, SESSION_A, f"notice_{rid}", "allow_once")
                assert result["ok"] is False, (action, result)
                assert result["code"] == "local_confirmation_required", (action, result)
            # high-risk notices expose no remote buttons at all
            notices = await client.request("session.getNotices", {"sessionId": SESSION_A})
            for notice in notices["notices"]:
                assert notice.get("actions", []) == [], notice
            assert live_hub.replies() == [], live_hub.replies()
        finally:
            await client.close()

    asyncio.run(scenario())


def test_wire_high_risk_gap_is_closed_by_the_allowlist(live_hub: LiveHub) -> None:
    """§6⑥ is now an ALLOWLIST (fail-closed): a weird-but-high-risk action name,
    an unlisted future tool, or a missing/empty action must all be refused
    locally — the former xfail counterexample, now asserted directly.
    """
    live_hub.seed_demo_session()
    gap_specs = [
        ("write_file", {"id": "req_gap_1", "action": "write_file", "sessionID": NATIVE_A}),
        ("multiedit", {"id": "req_gap_2", "action": "multiedit", "sessionID": NATIVE_A}),
        ("apply_patch", {"id": "req_gap_3", "action": "apply_patch", "sessionID": NATIVE_A}),
        ("bash_write", {"id": "req_gap_4", "action": "bash_write", "sessionID": NATIVE_A}),
        ("missing_action", {"id": "req_gap_5", "sessionID": NATIVE_A}),
        ("empty_action", {"id": "req_gap_6", "action": "", "sessionID": NATIVE_A}),
    ]

    async def scenario() -> None:
        client = raw_client(live_hub)
        await client.start()
        try:
            await client.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            for label, spec in gap_specs:
                live_hub.permission(spec)
                result = await respond(client, SESSION_A, f"notice_{spec['id']}", "allow_once")
                assert result["ok"] is False and result["code"] == "local_confirmation_required", (
                    label,
                    result,
                )
        finally:
            await client.close()

    asyncio.run(scenario())


# ---------------------------------------- §6⑥ allowlist closure + discrimination
def test_wire_allowlist_is_closed_and_discriminating(live_hub: LiveHub) -> None:
    """Round-2 falsification of the allowlist: every unlisted/edge/whitespace
    spelling stays local-only, AND a genuinely read-only action is still
    answerable — so the assertion set cannot pass by simply refusing everything.
    """
    live_hub.seed_demo_session()
    closed: list[tuple[str, object]] = [
        ("write_file", "write_file"),
        ("multiedit", "multiedit"),
        ("apply_patch", "apply_patch"),
        ("bash_write", "bash_write"),
        ("future_tool_9000", "future_tool_9000"),
        ("upper_write", "WRITE"),
        ("mixed_edit", "MuLtIeDiT"),
        ("whitespace_only", "   "),
        ("padding_write", "  write_file  "),
        ("null_action", None),
    ]
    open_read = [("read", "read"), ("upper_read", "READ"), ("webfetch", "webfetch"), ("padded_read", "  read  "), ("grep", "grep")]

    async def scenario() -> None:
        client = raw_client(live_hub)
        await client.start()
        try:
            await client.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            for index, (label, action) in enumerate(closed):
                rid = f"req_closed_{index}"
                live_hub.permission({"id": rid, "action": action, "sessionID": NATIVE_A})
                result = await respond(client, SESSION_A, f"notice_{rid}", "allow_once")
                assert result["ok"] is False and result["code"] == "local_confirmation_required", (label, result)

            # The allowlist must not be vacuous: a proven read-only action lands.
            for index, (label, action) in enumerate(open_read):
                rid = f"req_open_{index}"
                live_hub.permission({"id": rid, "action": action, "sessionID": NATIVE_A})
                result = await respond(client, SESSION_A, f"notice_{rid}", "allow_once")
                assert result["ok"] is True, (label, action, result)
        finally:
            await client.close()

    asyncio.run(scenario())


# ---------------------------------------- §6⑤ owner=null fails closed
def test_wire_unclaimed_notice_is_refused_fail_closed(live_hub: LiveHub) -> None:
    """§6⑤ fail-closed: if NO connection ever claimed the session when
    ``permission.asked`` was observed, ``ownerConnectorId`` is null and there is
    no device to compare against — so remote answering is refused with
    ``unbound_notice`` instead of being skipped. Distinct from ``unknown_notice``
    (the notice IS visible via getNotices) and from ``device_mismatch`` (no owner
    exists yet, not a different one).
    """
    live_hub.seed_demo_session()

    async def scenario() -> None:
        rogue = raw_client(live_hub, connector_id="rogue-device", namespace="rogue:ns")
        await rogue.start()
        try:
            # No subscribe/claim anywhere before the ask → observed with owner=null.
            live_hub.permission({"id": "req_unclaimed", "action": "webfetch", "sessionID": NATIVE_A})
            rogue_session = platform_id("rogue:ns", NATIVE_A)
            outcome = await respond(rogue, rogue_session, "notice_req_unclaimed", "allow_once")
            assert outcome["ok"] is False, outcome
            assert outcome["code"] == "unbound_notice", outcome
            # The notice exists and is visible — it is the *binding* that is absent.
            notices = (await rogue.request("session.getNotices", {"sessionId": rogue_session}))["notices"]
            assert [n["noticeId"] for n in notices] == ["notice_req_unclaimed"], notices
            assert notices[0]["status"] == "open", notices[0]
            assert live_hub.replies() == [], live_hub.replies()
        finally:
            await rogue.close()

    asyncio.run(scenario())


def test_wire_empty_connector_id_cannot_answer_a_bound_notice(live_hub: LiveHub) -> None:
    """An empty handshake connectorId is an empty device identity; it must never
    match a real owner and must not be able to answer that device's notice."""
    live_hub.seed_demo_session()

    async def scenario() -> None:
        victim = raw_client(live_hub)
        await victim.start()
        attacker = raw_client(live_hub, connector_id="")
        await attacker.start()
        try:
            await victim.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            live_hub.permission({"id": "req_empty_id", "action": "webfetch", "sessionID": NATIVE_A})
            outcome = await respond(attacker, SESSION_A, "notice_req_empty_id", "allow_once")
            assert outcome["ok"] is False, outcome
            assert outcome["code"] == "device_mismatch", outcome
            assert live_hub.replies() == [], live_hub.replies()
        finally:
            await attacker.close()
            await victim.close()

    asyncio.run(scenario())


# ---------------------------------------- §6② re-delivery: no lock-out, no reopen
def test_wire_redelivered_asked_stays_answerable_and_does_not_reopen(live_hub: LiveHub) -> None:
    """A re-delivered ``permission.asked`` (reconnect/replay) must (a) not
    permanently lock the interaction out — it is still answerable — and (b) never
    re-open an already-answered notice into a second, unanswerable open record.
    """
    live_hub.seed_demo_session()

    async def scenario() -> None:
        victim = raw_client(live_hub)
        await victim.start()
        try:
            await victim.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            live_hub.permission({"id": "req_dup", "action": "webfetch", "sessionID": NATIVE_A})
            # identical re-delivery BEFORE the first answer: still answerable
            live_hub.permission({"id": "req_dup", "action": "webfetch", "sessionID": NATIVE_A})
            first = await respond(victim, SESSION_A, "notice_req_dup", "allow_once")
            assert first["ok"] is True, first
            # identical re-delivery AFTER the answer: must not reopen nor re-land
            live_hub.permission({"id": "req_dup", "action": "webfetch", "sessionID": NATIVE_A})
            second = await respond(victim, SESSION_A, "notice_req_dup", "deny")
            assert second["ok"] is False and second["code"] == "already_answered", second
            dup_replies = [r for r in live_hub.replies() if r["path"]["requestID"] == "req_dup"]
            assert len(dup_replies) == 1, dup_replies

            notices = (await victim.request("session.getNotices", {"sessionId": SESSION_A}))["notices"]
            statuses = [n["status"] for n in notices if n["noticeId"] == "notice_req_dup"]
            assert statuses == ["resolved"], statuses
        finally:
            await victim.close()

    asyncio.run(scenario())


# ------------------------ R4: a claim binds an ask that predates the claim (once)
def test_wire_claim_after_observe_binds_the_open_notice_once(live_hub: LiveHub) -> None:
    """R4 semantics: the Hub ingests events unconditionally, so an ask observed
    while no connection had claimed the session (``ownerConnectorId`` null) would
    otherwise be a permanent dead end. When the first device claims that session
    the Hub binds those still-*open* notices to it, exactly once — the cold-start
    notice becomes remotely answerable while the trust model is unchanged (first
    claim wins; an already-answered notice is never reopened).
    """
    live_hub.seed_demo_session()

    async def scenario() -> None:
        # The ask is observed while NO connection has claimed the session.
        live_hub.permission({"id": "req_late", "action": "webfetch", "sessionID": NATIVE_A})
        victim = raw_client(live_hub)
        await victim.start()
        try:
            # Subscribing now claims the session, binding the still-open notice.
            await victim.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
            notices = (await victim.request("session.getNotices", {"sessionId": SESSION_A}))["notices"]
            visible = [n for n in notices if n["noticeId"] == "notice_req_late"]
            assert [n["status"] for n in visible] == ["open"], visible

            # The very device that claimed may now answer the orphaned notice.
            outcome = await respond(victim, SESSION_A, "notice_req_late", "allow_once")
            assert outcome["ok"] is True, outcome
            landed = [r for r in live_hub.replies() if r["path"]["requestID"] == "req_late"]
            assert len(landed) == 1, live_hub.replies()

            # Binding is one-time: an already-answered notice is never reopened or
            # re-landed, not even by a re-delivered ask.
            live_hub.permission({"id": "req_late", "action": "webfetch", "sessionID": NATIVE_A})
            again = await respond(victim, SESSION_A, "notice_req_late", "deny")
            assert again["ok"] is False and again["code"] == "already_answered", again
            landed = [r for r in live_hub.replies() if r["path"]["requestID"] == "req_late"]
            assert len(landed) == 1, live_hub.replies()

            # First claim wins: a later device cannot steal the bound notice.
            other = raw_client(live_hub, connector_id="device-b")
            await other.start()
            try:
                await other.request("runtime.sync.subscribe", {"sessionId": SESSION_A})
                foreign = await respond(other, SESSION_A, "notice_req_late", "allow_once")
                assert foreign["ok"] is False and foreign["code"] == "device_mismatch", foreign
            finally:
                await other.close()
        finally:
            await victim.close()

    asyncio.run(scenario())
