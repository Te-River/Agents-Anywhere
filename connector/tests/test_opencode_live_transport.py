from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, create_autospec

import pytest

from connector.runtime_protocol import (
    RuntimeHostClient,
    RuntimeInstanceHost,
    RuntimeInstanceSpec,
    timeline_content_hash,
)
from connector.runtimes.opencode.bridge.sync import (
    SyncRelay,
    _checkpoint,
    checkpoint_key,
)
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.sync_state import JsonSyncStateStore

SESSION = "sess-1"
RUNTIME_ID = "rti_opencode"


def timeline_item(item_id: str = "item-1", text: str = "hello") -> dict[str, object]:
    content = {"text": text, "format": "markdown"}
    return {
        "id": item_id,
        "sessionId": SESSION,
        "type": "message",
        "role": "assistant",
        "status": "done",
        "orderSeq": 1,
        "revision": 1,
        "content": content,
        "source": {"runtime": "opencode"},
        "contentHash": timeline_content_hash("message", "done", "assistant", content),
    }


def fake_host():
    # create_autospec enforces the real RuntimeHostClient signatures, so a wrong
    # keyword on timeline_sync/session_meta_upsert raises TypeError instead of
    # being absorbed by a loose AsyncMock (fixes the假绿 the reviewer flagged).
    host = create_autospec(RuntimeHostClient, instance=True)
    host.connector_id = "test"
    host.session_namespace = "test:opencode"
    host.sync_state_read.return_value = None
    return host


def test_begin_items_commit_reassembles_then_publishes_once() -> None:
    async def run() -> None:
        host = fake_host()
        relay = SyncRelay(SimpleNamespace(), host, runtime_id=RUNTIME_ID)
        try:
            await relay.operation(
                {
                    "sessionId": SESSION,
                    "phase": "begin",
                    "streamId": "stream-1",
                    "throughSeq": 7,
                    "historyHash": "a" * 64,
                    "meta": {"externalSessionId": "native-1", "cwd": "/repo"},
                }
            )
            await relay.operation(
                {
                    "sessionId": SESSION,
                    "phase": "items",
                    "streamId": "stream-1",
                    "items": [timeline_item()],
                }
            )
            assert host.timeline_sync.await_count == 0
            await relay.operation(
                {
                    "sessionId": SESSION,
                    "phase": "commit",
                    "streamId": "stream-1",
                    "throughSeq": 7,
                    "complete": True,
                }
            )
            host.timeline_sync.assert_awaited_once()
            args = host.timeline_sync.await_args
            assert args.args[0] == SESSION
            assert args.args[1] == "opencode"
            assert [item.id for item in args.args[2]] == ["item-1"]
            assert args.kwargs["complete"] is True
            assert args.kwargs["external_session_id"] == "native-1"
            diagnostics = args.kwargs["metadata"]["syncDiagnostics"]
            assert diagnostics["skippedItemCount"] == 0
            assert diagnostics["skippedEventCount"] is None
            host.session_meta_upsert.assert_awaited_once()
            host.sync_state_write.assert_awaited_once()
            key, value = host.sync_state_write.await_args.args
            assert key == checkpoint_key(RUNTIME_ID, SESSION)
            assert key == f"opencode/{RUNTIME_ID}/{SESSION}"
            assert value["throughSeq"] == 7
            assert value["historyHash"] == "a" * 64
        finally:
            await relay.close()

    asyncio.run(run())


def test_consume_ingests_before_it_acks() -> None:
    async def run() -> None:
        host = fake_host()
        entered, release, acked = asyncio.Event(), asyncio.Event(), asyncio.Event()
        order: list[str] = []
        acks: list[dict[str, object]] = []

        async def timeline_sync(*_args: object, **_kwargs: object) -> None:
            order.append("ingest")
            entered.set()
            await release.wait()

        host.timeline_sync = timeline_sync

        async def request(method: str, params: dict[str, object] | None = None) -> dict[str, object]:
            if method == "runtime.sync.subscribe":
                return {"streamId": "stream-1", "checkpointVersion": 1}
            assert method == "runtime.sync.ack"
            order.append("ack")
            acks.append(params or {})
            acked.set()
            return {}

        client = SimpleNamespace(request=request, connected=True)
        relay = SyncRelay(client, host, runtime_id=RUNTIME_ID)
        task = asyncio.create_task(relay.consume())
        try:
            relay.accept({"sessionId": SESSION, "phase": "begin", "throughSeq": 3})
            relay.accept({"sessionId": SESSION, "phase": "commit", "throughSeq": 3})
            await asyncio.wait_for(entered.wait(), 1)
            assert acks == []
            release.set()
            await asyncio.wait_for(acked.wait(), 1)
            assert order == ["ingest", "ack"]
            assert acks == [{"sessionId": SESSION, "throughSeq": 3}]
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())


def test_notification_page_forwards_platform_notifications() -> None:
    async def run() -> None:
        host = fake_host()
        relay = SyncRelay(SimpleNamespace(), host, runtime_id=RUNTIME_ID)
        try:
            await relay.operation(
                {
                    "sessionId": SESSION,
                    "phase": "notifications",
                    "notifications": [
                        {
                            "method": "timeline.itemUpsert",
                            "params": {
                                "sessionId": SESSION,
                                "runtime": "opencode",
                                "item": timeline_item(),
                            },
                        },
                        {
                            "method": "notice.upsert",
                            "params": {
                                "noticeId": "n1",
                                "sessionId": SESSION,
                                "runtime": "opencode",
                                "type": "notification",
                                "title": "hi",
                            },
                        },
                    ],
                }
            )
            host.timeline_item_upsert.assert_awaited_once()
            assert host.timeline_item_upsert.await_args.args[0].id == "item-1"
            host.notice_upsert.assert_awaited_once()
            # An unknown platform notification is skipped and counted, never fatal (M1).
            await relay.operation(
                {
                    "sessionId": SESSION,
                    "phase": "notifications",
                    "notifications": [
                        {"method": "opencode.native.event", "params": {}}
                    ],
                }
            )
            assert relay.skipped_item_count == 1
            host.timeline_item_upsert.assert_awaited_once()
        finally:
            await relay.close()

    asyncio.run(run())


def test_malformed_items_are_skipped_counted_and_do_not_lose_the_page() -> None:
    """One bad item must be skipped and counted without discarding the batch (M1)."""

    async def run() -> None:
        host = fake_host()
        relay = SyncRelay(SimpleNamespace(), host, runtime_id=RUNTIME_ID)
        try:
            await relay.operation(
                {
                    "sessionId": SESSION,
                    "phase": "begin",
                    "throughSeq": 4,
                    # Hub-owned counter is passed through verbatim (rev3 ruling 4).
                    "diagnostics": {"skippedEventCount": 5},
                }
            )
            unknown_type = timeline_item("bad-type")
            unknown_type["type"] = "some.future.type"
            drifted_hash = timeline_item("bad-hash")
            drifted_hash["contentHash"] = "0" * 64
            good = timeline_item("good")
            await relay.operation(
                {
                    "sessionId": SESSION,
                    "phase": "items",
                    "items": [unknown_type, good, drifted_hash],
                }
            )
            await relay.operation(
                {"sessionId": SESSION, "phase": "commit", "throughSeq": 4, "complete": True}
            )
            host.timeline_sync.assert_awaited_once()
            items = host.timeline_sync.await_args.args[2]
            assert [item.id for item in items] == ["good"]
            assert relay.skipped_item_count == 2
            diagnostics = host.timeline_sync.await_args.kwargs["metadata"]["syncDiagnostics"]
            assert diagnostics["skippedItemCount"] == 2
            assert diagnostics["skippedEventCount"] == 5
        finally:
            await relay.close()

    asyncio.run(run())


def test_subscribe_reports_history_hash_and_records_session() -> None:
    """subscribe carries the checkpoint historyHash for Hub prefix calibration (M5)."""

    async def run() -> None:
        captured: dict[str, object] = {}

        async def request(method: str, params: dict[str, object] | None = None) -> dict[str, object]:
            captured["method"] = method
            captured["params"] = params
            return {"streamId": "s1"}

        client = SimpleNamespace(request=request, connected=True)
        relay = SyncRelay(client, fake_host(), runtime_id=RUNTIME_ID)
        await relay.subscribe(SESSION, from_seq=9, history_hash="c" * 64)
        assert captured["method"] == "runtime.sync.subscribe"
        assert captured["params"] == {
            "sessionId": SESSION,
            "fromSeq": 9,
            "historyHash": "c" * 64,
        }
        assert SESSION in relay._session_ids

    asyncio.run(run())


def test_recovery_resubscribes_with_persisted_hash() -> None:
    """Any internal recovery re-subscribes and re-calibrates (n4)."""

    async def run() -> None:
        calls: list[tuple[str, dict[str, object] | None]] = []

        async def request(method: str, params: dict[str, object] | None = None) -> dict[str, object]:
            calls.append((method, params))
            return {"streamId": "s1"}

        host = fake_host()
        host.sync_state_read = AsyncMock(
            return_value={
                "version": 1,
                "throughSeq": 12,
                "historyHash": "d" * 64,
                "updatedAt": "2026-01-01T00:00:00Z",
            }
        )
        relay = SyncRelay(SimpleNamespace(request=request, connected=True), host, runtime_id=RUNTIME_ID)
        relay._session_ids.add(SESSION)
        await relay._resubscribe()
        assert calls == [
            (
                "runtime.sync.subscribe",
                {"sessionId": SESSION, "fromSeq": 12, "historyHash": "d" * 64},
            )
        ]

    asyncio.run(run())


def test_queue_full_is_counted_and_forces_resync() -> None:
    """QueueFull must warn, count, and force a resubscription, never silently drop (n3)."""

    async def run() -> None:
        relay = SyncRelay(SimpleNamespace(), fake_host(), runtime_id=RUNTIME_ID)
        for _ in range(relay.queue.maxsize):
            relay.accept({"sessionId": SESSION, "phase": "begin"})
        assert relay.dropped_batch_count == 0
        relay.accept({"sessionId": SESSION, "phase": "begin"})
        assert relay.dropped_batch_count == 1
        with pytest.raises(RuntimeError):
            await relay.consume()

    asyncio.run(run())


def test_checkpoint_tolerates_a_missing_history_hash_key() -> None:
    """A valid persisted value without ``historyHash`` must not raise KeyError (m1)."""

    value = _checkpoint(
        {"version": 1, "throughSeq": 5, "updatedAt": "2026-01-01T00:00:00Z"}
    )
    assert value is not None
    assert value["historyHash"] is None
    assert _checkpoint({"version": 1, "throughSeq": 5}) is None


def test_checkpoint_is_namespaced_per_runtime_instance(tmp_path) -> None:
    async def run() -> None:
        store = JsonSyncStateStore(tmp_path / "connector-state.json")
        base = ConnectorRuntimeHost("connector", AsyncMock(), AsyncMock(), store, AsyncMock())
        host = RuntimeInstanceHost(
            base,
            RuntimeInstanceSpec(runtime_id=RUNTIME_ID, runtime_type="opencode", name="OpenCode"),
        )
        relay = SyncRelay(SimpleNamespace(), host, runtime_id=RUNTIME_ID)
        await relay._write_checkpoint(SESSION, 12, "b" * 64)
        stored = await relay.read_checkpoint(SESSION)
        assert stored is not None
        assert stored["throughSeq"] == 12
        assert stored["historyHash"] == "b" * 64
        assert await host.sync_state_read(checkpoint_key(RUNTIME_ID, SESSION)) is not None

        other_host = RuntimeInstanceHost(
            base,
            RuntimeInstanceSpec(runtime_id="rti_other", runtime_type="opencode", name="Other"),
        )
        other = SyncRelay(SimpleNamespace(), other_host, runtime_id="rti_other")
        assert await other.read_checkpoint(SESSION) is None

    asyncio.run(run())


def test_publish_notification_accepts_canonical_and_legacy_capability_names() -> None:
    """F2: both the canonical and the legacy capability-update names resolve on the
    push path, and an unknown method is raised (logged upstream), never swallowed."""

    async def run() -> None:
        host = fake_host()
        relay = SyncRelay(SimpleNamespace(), host, runtime_id=RUNTIME_ID)
        payload: dict[str, object] = {
            "runtime": "opencode",
            "revision": 2,
            "capabilities": [
                {
                    "capabilityId": "session.discovery",
                    "supported": True,
                    "available": True,
                    "allowed": True,
                }
            ],
        }

        for method in ("runtime.capability.updated", "runtime.capabilities.update"):
            await relay.publish_notification({"method": method, "params": payload})
        assert host.runtime_capabilities_update.await_count == 2

        for method in ("session.capability.updated", "session.capabilities.update"):
            await relay.publish_notification({"method": method, "params": payload})
        assert host.session_capabilities_update.await_count == 2

        with pytest.raises(ValueError):
            await relay.publish_notification(
                {"method": "runtime.capability.teleported", "params": payload}
            )

    asyncio.run(run())


def test_permission_notice_reaches_the_host_with_the_approval_shape() -> None:
    """§6 链路: a `notice.upsert` decodes to a SessionNotice with
    interactionType `permission`, only allow_once/deny, and the local-confirmation
    flag — the exact shape the Hub projects from `permission.asked`."""

    async def run() -> None:
        host = fake_host()
        relay = SyncRelay(SimpleNamespace(), host, runtime_id=RUNTIME_ID)
        try:
            await relay.operation(
                {
                    "sessionId": SESSION,
                    "phase": "notifications",
                    "notifications": [
                        {
                            "method": "notice.upsert",
                            "params": {
                                "noticeId": "notice_req_1",
                                "sessionId": SESSION,
                                "runtime": "opencode",
                                "type": "interaction",
                                "title": "webfetch",
                                "interactionType": "approval",
                                "status": "open",
                                "blocking": {"scope": "session", "targetId": SESSION},
                                "context": {
                                    "permission": "webfetch",
                                    "requestId": "req_1",
                                    "requiresLocalConfirmation": False,
                                },
                                "responseRequired": True,
                                "actions": [
                                    {"actionId": "allow_once", "label": "Allow once"},
                                    {"actionId": "deny", "label": "Deny"},
                                ],
                            },
                        }
                    ],
                }
            )
            host.notice_upsert.assert_awaited_once()
            notice = host.notice_upsert.await_args.args[0]
            assert notice.type == "interaction"
            assert notice.interaction_type == "approval"
            assert notice.response_required is True
            assert [action["actionId"] for action in notice.actions] == ["allow_once", "deny"]
            assert notice.blocking == {"scope": "session", "targetId": SESSION}
            assert notice.context["permission"] == "webfetch"
            assert notice.context["requiresLocalConfirmation"] is False
        finally:
            await relay.close()

    asyncio.run(run())
