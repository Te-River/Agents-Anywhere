from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
)
from connector.runtime_protocol.filesystem import canonical_path
from connector.runtimes.opencode import discovery, provider_config
from connector.runtimes.opencode.discovery import (
    BridgeEndpoint,
    OpenCodeDiscovery,
    discover,
    probe,
    select_endpoint,
)
from connector.runtimes.opencode.provider import OpenCodeProvider
from connector.runtimes.opencode.runtime import OpenCodeRuntime, _sync_mode_from
from connector.runtimes.providers import default_runtime_providers


def test_opencode_is_registered_as_the_fourth_provider() -> None:
    providers = default_runtime_providers()
    assert [provider.runtime for provider in providers] == [
        "codex",
        "claude",
        "dsh",
        "opencode",
    ]
    assert isinstance(providers[3], OpenCodeProvider)
    assert providers[3].runtime_type == "opencode"
    assert providers[3].implementation_type == "local-service"
    assert providers[3].instance_policy == "multiple"
    assert providers[3].max_instances is None


def endpoint_payload(port: int, pid: int, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "version": 1,
        "runtime": "opencode",
        "protocolVersion": "1.0",
        "bridgeId": "bridge-1",
        "host": "127.0.0.1",
        "port": port,
        "token": "secret-token",
        "pid": pid,
        "serviceVersion": "2.0.16",
        "locations": ["/repo"],
        "startedAt": "2026-09-27T00:00:00Z",
    }
    payload.update(overrides)
    return payload


async def start_bridge(**identity_overrides: Any):
    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        while line := await reader.readline():
            request = json.loads(line)
            method = request.get("method")
            if method == "initialize":
                params = request.get("params") or {}
                if not params.get("location"):
                    # Mirror the Hub spec (rev3 ruling 1, fail-closed): an
                    # initialize frame without a location is refused with
                    # -32602 INVALID_PARAMS and the connection is closed.
                    response = {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "error": {
                            "code": -32602,
                            "message": "location is required",
                            "data": {"code": "INVALID_PARAMS", "retryable": False},
                        },
                    }
                    writer.write(json.dumps(response).encode() + b"\n")
                    await writer.drain()
                    writer.close()
                    await writer.wait_closed()
                    return
                identity = {
                    "runtime": "opencode",
                    "runtimeVersion": "2.0.16",
                    "protocolVersion": "1.0",
                    **identity_overrides,
                }
                response = {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": {"identity": identity, "features": {"syncMode": "events"}},
                }
            elif method == "ping":
                response = {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": {"ok": True},
                }
            else:
                response = {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "error": {"code": -32601, "message": "unsupported"},
                }
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


def test_opencode_provider_identity_schema_and_validation(tmp_path: Path) -> None:
    async def discoverer(values: dict[str, Any]) -> OpenCodeDiscovery:
        return OpenCodeDiscovery(True, True, (), metadata={"storageMode": "opencode-native"})

    async def run() -> None:
        provider = OpenCodeProvider(discoverer=discoverer)
        assert provider.runtime == "opencode"
        assert provider.display_name == "OpenCode"
        assert provider.instance_policy == "multiple"
        descriptor = await provider.discover()
        assert descriptor.runtime_type == "opencode"
        assert descriptor.instance_policy == "multiple"
        assert descriptor.max_instances is None
        assert descriptor.available is True
        schema = await provider.get_config_schema()
        assert schema.defaults["maxRestartAttempts"] == 3
        assert schema.schema["properties"]["registryDir"]["type"] == "string"

        config = await provider.validate_config(
            {**schema.defaults, "registryDir": str(tmp_path / "registry")}
        )
        assert config.runtime == "opencode"
        assert config.metadata["protocolVersion"] == "1.0"
        assert config.metadata["configured"] is True

        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config({**schema.defaults, "registryDir": "relative"})
        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config({**schema.defaults, "unexpected": True})
        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config({**schema.defaults, "servicePid": 0})

    asyncio.run(run())


def test_opencode_claims_and_source_key_are_registry_scoped(tmp_path: Path) -> None:
    async def run() -> None:
        real = tmp_path / "real-registry"
        real.mkdir()

        async def discoverer(values: dict[str, Any]) -> OpenCodeDiscovery:
            return OpenCodeDiscovery(True, True, ())

        provider = OpenCodeProvider(discoverer=discoverer)
        direct = await provider.validate_config({"registryDir": str(real)})
        indirect = await provider.validate_config(
            {"registryDir": str(real / ".." / "real-registry")}
        )

        assert direct.values["registryDir"] == canonical_path(real)
        assert provider.resource_claims(direct) == provider.resource_claims(indirect)
        assert provider.resource_claims(direct)[0].kind == "opencode_bridge_registry"
        source = provider.session_source_key(direct)
        assert source.kind == "opencode_service"
        assert source == provider.session_source_key(indirect)
        for fragment in ("secret-token", "12345", str(os.getpid())):
            assert fragment not in source.key

    asyncio.run(run())


def test_discover_reports_type_without_touching_the_registry(tmp_path: Path) -> None:
    async def run() -> None:
        registry = tmp_path / "endpoints"
        registry.mkdir()
        stale = registry / "123-456.json"
        stale.write_text("{ not json", encoding="utf-8")

        result = await discover({"registryDir": str(registry)})
        assert result.available is True
        assert result.configured is True
        assert result.reason is None
        assert result.endpoints == ()
        # Discovery must not read, clean, or probe the registry.
        assert stale.exists()
        assert result.metadata is not None
        assert result.metadata["endpointDirectory"] == canonical_path(registry)

    asyncio.run(run())


def _dead_pid() -> int:
    """A pid guaranteed not to be running (spawn + reap)."""

    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


def test_probe_handshakes_live_endpoints_and_cleans_invalid_files(tmp_path: Path) -> None:
    async def run() -> None:
        registry = tmp_path / "endpoints"
        registry.mkdir()
        server, port = await start_bridge()
        live = registry / f"{os.getpid()}-{port}.json"
        live.write_text(json.dumps(endpoint_payload(port, os.getpid())), encoding="utf-8")
        # Structurally invalid (unsupported version) can never authenticate (D1).
        invalid = registry / f"{os.getpid()}-65000.json"
        invalid.write_text(
            json.dumps(endpoint_payload(65000, os.getpid(), version=2)), encoding="utf-8"
        )
        try:
            result = await probe({"registryDir": str(registry)})
            assert result.available is True
            assert result.configured is True
            assert [endpoint.port for endpoint in result.endpoints] == [port]
            assert [endpoint.locations for endpoint in result.endpoints] == [("/repo",)]
            assert not invalid.exists()
            assert live.exists()
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_probe_handshake_carries_the_endpoint_declared_location(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The probe handshake authenticates as the endpoint's own first declared
    location; the Hub fail-closes an initialize frame without one (rev3 ruling 1)."""

    async def run() -> None:
        registry = tmp_path / "endpoints"
        registry.mkdir()
        seen: list[str | None] = []

        class FakeBridgeClient:
            def __init__(self, **kwargs: Any) -> None:
                seen.append(kwargs.get("location"))

            async def start(self) -> dict[str, Any]:
                return {"identity": {"runtime": "opencode", "protocolVersion": "1.0"}}

            async def request(self, method: str, params: Any = None, **_: Any) -> Any:
                return {"ok": True}

            async def close(self) -> None:
                pass

        monkeypatch.setattr(
            "connector.runtimes.opencode.bridge.client.BridgeClient", FakeBridgeClient
        )
        # Multiple declared locations: the handshake must use the first one.
        live = registry / f"{os.getpid()}-4242.json"
        live.write_text(
            json.dumps(
                endpoint_payload(4242, os.getpid(), locations=["D:/srv/primary", "D:/srv/second"])
            ),
            encoding="utf-8",
        )

        result = await probe({"registryDir": str(registry)})

        assert seen == ["D:/srv/primary"]
        assert result.available is True
        assert result.endpoints[0].locations == ("D:/srv/primary", "D:/srv/second")

    asyncio.run(run())


def test_probe_handshake_without_declared_locations_keeps_current_behaviour(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An endpoint declaring no location keeps today's behaviour: no location is
    invented, the Hub rejects the handshake (-32602), and the file is kept."""

    async def run() -> None:
        registry = tmp_path / "endpoints"
        registry.mkdir()
        seen: list[str | None] = []

        class FakeBridgeClient:
            def __init__(self, **kwargs: Any) -> None:
                seen.append(kwargs.get("location"))

            async def start(self) -> dict[str, Any]:
                from connector.runtimes.opencode.bridge.client import BridgeRpcError

                if not seen[-1]:
                    # Mirror the Hub spec (rev3 ruling 1, fail-closed): the
                    # handshake is refused and the connection is closed.
                    raise BridgeRpcError(
                        -32602, "location is required", {"code": "INVALID_PARAMS"}
                    )
                return {"identity": {"runtime": "opencode", "protocolVersion": "1.0"}}

            async def close(self) -> None:
                pass

        monkeypatch.setattr(
            "connector.runtimes.opencode.bridge.client.BridgeClient", FakeBridgeClient
        )
        empty = registry / f"{os.getpid()}-4242.json"
        empty.write_text(
            json.dumps(endpoint_payload(4242, os.getpid(), locations=[])),
            encoding="utf-8",
        )

        result = await probe({"registryDir": str(registry)})

        assert seen == [None]
        # The inconclusive handshake never costs the endpoint file (K2).
        assert empty.exists()
        assert result.available is False
        assert result.reason

    asyncio.run(run())


def test_endpoint_is_stale_only_for_definitive_failures(tmp_path: Path) -> None:
    """Deletion is limited to D2 (refused + dead pid) and D3 (protocol/identity) (M4)."""

    from connector.runtimes.opencode.bridge.client import (
        BridgeIdentityError,
        BridgeProtocolError,
    )

    def bridge(pid: int) -> BridgeEndpoint:
        return BridgeEndpoint(
            host="127.0.0.1",
            port=1,
            token="t",
            pid=pid,
            path=tmp_path / "e.json",
            bridge_id="b",
            locations=(),
        )

    alive = bridge(os.getpid())
    # K1/K2: timeouts, refusals with a live pid, and unknown errors are preserved.
    assert discovery.endpoint_is_stale(alive, TimeoutError()) is False
    assert discovery.endpoint_is_stale(alive, ConnectionError()) is False
    assert discovery.endpoint_is_stale(alive, RuntimeError("transient")) is False
    # D2: refused and the pid is gone.
    assert discovery.endpoint_is_stale(bridge(_dead_pid()), ConnectionError()) is True
    # D3: the endpoint answered but is incompatible / not opencode.
    assert discovery.endpoint_is_stale(alive, BridgeProtocolError()) is True
    assert discovery.endpoint_is_stale(alive, BridgeIdentityError()) is True


def test_probe_keeps_endpoint_file_on_handshake_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A busy Hub (handshake timeout) must never cost another process its file (M4/K1)."""

    async def run() -> None:
        registry = tmp_path / "endpoints"
        registry.mkdir()
        writers: list[asyncio.StreamWriter] = []

        async def silent(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            # Accept the connection but never answer initialize.
            writers.append(writer)
            await asyncio.Event().wait()

        server = await asyncio.start_server(silent, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        slow = registry / f"{os.getpid()}-{port}.json"
        slow.write_text(json.dumps(endpoint_payload(port, os.getpid())), encoding="utf-8")
        monkeypatch.setattr(discovery, "HANDSHAKE_STARTUP_TIMEOUT_SECONDS", 0.2)
        monkeypatch.setattr(discovery, "HANDSHAKE_REQUEST_TIMEOUT_SECONDS", 0.2)
        try:
            result = await probe({"registryDir": str(registry)})
            assert result.available is False
            assert slow.exists()
        finally:
            for writer in writers:
                writer.close()
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_select_endpoint_rejects_unlisted_or_empty_location(tmp_path: Path) -> None:
    def endpoint(locations: tuple[str, ...]) -> BridgeEndpoint:
        return BridgeEndpoint(
            host="127.0.0.1",
            port=1,
            token="t",
            pid=1,
            path=tmp_path / "e.json",
            bridge_id="b",
            locations=locations,
        )

    wanted = str(tmp_path / "repo")
    # Configured location must be present; an empty list no longer bypasses it (M2).
    assert select_endpoint({"location": wanted}, (endpoint(()),)) is None
    assert select_endpoint({"location": wanted}, (endpoint((str(tmp_path / "other"),)),)) is None
    match = endpoint((wanted,))
    assert select_endpoint({"location": wanted}, (match,)) is match


def test_select_endpoint_prefers_the_most_recently_started(tmp_path: Path) -> None:
    """Multi-live selection must not fall back on lexicographic filename order (m6)."""

    def endpoint(name: str, started_at: str, port: int) -> BridgeEndpoint:
        return BridgeEndpoint(
            host="127.0.0.1",
            port=port,
            token="t",
            pid=1,
            path=tmp_path / name,
            bridge_id="b",
            locations=("/repo",),
            started_at=started_at,
        )

    older = endpoint("9-1.json", "2026-01-01T00:00:00Z", 1)
    newer = endpoint("10-2.json", "2026-02-01T00:00:00Z", 2)
    # Name order would rank "10-" first by luck; recency must be the rule.
    assert select_endpoint({"location": "/repo"}, (newer, older)) is newer
    assert select_endpoint({"location": "/repo"}, (older, newer)) is newer


def test_probe_without_a_live_bridge_reports_a_reason(tmp_path: Path) -> None:
    async def run() -> None:
        registry = tmp_path / "endpoints"
        registry.mkdir()
        result = await probe({"registryDir": str(registry)})
        assert result.available is False
        assert result.configured is False
        assert result.reason

    asyncio.run(run())


class _Host:
    connector_id = "test"
    session_namespace = "test:opencode"


class _Pages(OpenCodeRuntime):
    def __init__(self, pages: list[Any]) -> None:
        super().__init__(RuntimeConfig("opencode", 1), _Host())
        self.pages = iter(pages)
        self.calls: list[tuple[str, Any]] = []

    async def _request(self, method: str, params: Any = None) -> Any:
        self.calls.append((method, params))
        return next(self.pages)


def test_runtime_identity_is_opencode_and_attach_only() -> None:
    async def run() -> None:
        runtime = OpenCodeRuntime(
            RuntimeConfig("opencode", 1, runtime_id="rti_opencode", values={}), _Host()
        )
        assert runtime.identity.runtime == "opencode"
        assert runtime.identity.runtime_id == "rti_opencode"
        assert runtime.identity.display_name == "OpenCode"
        # Write path is P3: steer has no V2 native equivalent and always fails
        # loudly; the other write methods attempt the bridge and report it as
        # unavailable when no Hub is attached (never a silent success).
        with pytest.raises(RuntimeUnsupportedError):
            await runtime.steer_turn("s", "native", "steer me")
        with pytest.raises(RuntimeUnavailableError):
            await runtime.start_turn("s", "native", "hi")
        await runtime.stop()

    asyncio.run(run())


def test_runtime_start_schedules_recovery_without_spawning(tmp_path: Path) -> None:
    async def run() -> None:
        host = SimpleNamespace(
            connector_id="test", runtime_health_update=AsyncMock()
        )
        runtime = OpenCodeRuntime(
            RuntimeConfig(
                "opencode",
                1,
                values={"registryDir": str(tmp_path), "location": str(tmp_path / "repo")},
            ),
            host,
        )
        await runtime.start()
        codes = [
            call.args[1].get("code")
            for call in host.runtime_health_update.await_args_list
            if len(call.args) > 1 and isinstance(call.args[1], dict)
        ]
        assert "runtime_unavailable" in codes
        assert runtime._restart_task is not None
        await runtime.stop()
        assert runtime._stopping is True

    asyncio.run(run())


def test_runtime_requires_a_location_and_fails_closed(tmp_path: Path) -> None:
    """A missing location must reject start with runtime_unavailable (M2)."""

    async def run() -> None:
        host = SimpleNamespace(
            connector_id="test", runtime_health_update=AsyncMock()
        )
        runtime = OpenCodeRuntime(
            RuntimeConfig("opencode", 1, values={"registryDir": str(tmp_path)}), host
        )
        await runtime.start()
        codes = [
            call.args[1].get("code")
            for call in host.runtime_health_update.await_args_list
            if len(call.args) > 1 and isinstance(call.args[1], dict)
        ]
        assert "runtime_unavailable" in codes
        # No bridge was ever established without an identity to bind to.
        assert runtime._client is None
        await runtime.stop()

    asyncio.run(run())


async def _attach_with_injected_bridge(
    tmp_path: Path, sync_mode: str
) -> tuple[OpenCodeRuntime, list[str]]:
    """Attach `OpenCodeRuntime` against injected fakes — no real bridge/socket.

    `BridgeClient` / `SyncRelay` / endpoint resolution are replaced in-process;
    the returned `events` list records, in order, every health status report
    and the sync-relay start, so a test can assert the exact attach sequence.
    """

    events: list[str] = []

    class FakeBridgeClient:
        def __init__(self, **_kwargs: Any) -> None:
            self.connected = True

        async def start(self) -> dict[str, Any]:
            return {
                "identity": {
                    "runtime": "opencode",
                    "runtimeVersion": "2.0.18",
                    "protocolVersion": "1.0",
                },
                "features": {"syncMode": sync_mode},
            }

        async def request(self, method: str, params: Any = None) -> Any:
            # Only the bootstrap capability probe is served; no catalog rows
            # are available, so `_start_client`'s catalog loop is a no-op.
            _ = params
            assert method == "runtime.getCapabilities"
            return {
                "runtime": "opencode",
                "revision": 1,
                "capabilities": [
                    {
                        "capabilityId": "session.list",
                        "supported": True,
                        "available": True,
                        "allowed": True,
                    }
                ],
            }

        async def close(self) -> None:
            self.connected = False

    class FakeSyncRelay:
        def __init__(
            self, client: Any, host: Any, runtime_id: str | None = None
        ) -> None:
            _ = client, host, runtime_id

        def start(self) -> None:
            events.append("relay.start")

        async def close(self) -> None:
            pass

    async def health(status: str, *_args: Any, **_kwargs: Any) -> None:
        events.append(f"health:{status}")

    host = SimpleNamespace(
        connector_id="test",
        session_namespace="test:opencode",
        runtime_health_update=health,
        runtime_capabilities_update=AsyncMock(),
    )
    endpoint = BridgeEndpoint(
        host="127.0.0.1",
        port=45678,
        token="secret-token",
        pid=os.getpid(),
        path=tmp_path / f"{os.getpid()}-45678.json",
        bridge_id="bridge-1",
        locations=(str(tmp_path / "repo"),),
    )
    runtime = OpenCodeRuntime(
        RuntimeConfig(
            "opencode",
            1,
            values={"registryDir": str(tmp_path), "location": str(tmp_path / "repo")},
        ),
        host,
    )
    with (
        # `resolve_endpoint` is sync (no handshake); a plain stub returns the
        # endpoint directly instead of an un-awaited coroutine.
        patch.object(discovery, "resolve_endpoint", lambda values: endpoint),
        patch("connector.runtimes.opencode.runtime.BridgeClient", FakeBridgeClient),
        patch("connector.runtimes.opencode.runtime.SyncRelay", FakeSyncRelay),
    ):
        await runtime.start()
    return runtime, events


def test_events_attach_reports_starting_then_running(tmp_path: Path) -> None:
    """events 模式 attach 必须先报 starting 再报 running。

    OpenCode 的会话发现是 partial（持续事件流，无全量 inventory），永远等不到
    DSH 那样的 `session.inventory.complete`——所以事件中继启动后即运行中；
    此前只在非 events 分支报 running，导致服务端 available 永远停在 starting。
    """

    async def run() -> None:
        runtime, events = await _attach_with_injected_bridge(tmp_path, "events")
        try:
            assert events == [
                "health:starting",  # start(): 正在连接 OpenCode 并同步会话…
                "health:starting",  # _start_client(): 正在同步 OpenCode 会话…
                "relay.start",      # 事件中继已启动
                "health:running",   # 桥已连接 + 目录已推送 + 中继已启动 = 运行中
            ]
            assert runtime.sync_mode == "events"
            assert runtime._client is not None and runtime._client.connected
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_polling_attach_keeps_reporting_running_without_a_relay(
    tmp_path: Path,
) -> None:
    """非 events（polling）分支行为不变：starting 后直接 running，不建中继。"""

    async def run() -> None:
        runtime, events = await _attach_with_injected_bridge(tmp_path, "polling")
        try:
            assert events == ["health:starting", "health:running"]
            assert runtime._sync is None
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_sync_mode_defaults_when_features_are_absent_or_null() -> None:
    """``features: null`` must not raise AttributeError out of start() (m4)."""

    assert _sync_mode_from({}) == "polling"
    assert _sync_mode_from({"features": None}) == "polling"
    assert _sync_mode_from({"features": "events"}) == "polling"
    assert _sync_mode_from({"features": {"syncMode": "events"}}) == "events"


def test_direct_capability_notifications_accept_canonical_and_legacy_names() -> None:
    """F2: the direct path resolves the canonical ``runtime.capability.updated``
    (and its legacy alias), the session-scoped pair too, and never silently drops
    an unrecognised notification."""

    async def run() -> None:
        host = SimpleNamespace(
            connector_id="test",
            session_namespace="test:opencode",
            runtime_capabilities_update=AsyncMock(),
            session_capabilities_update=AsyncMock(),
        )
        runtime = OpenCodeRuntime(RuntimeConfig("opencode", 1), host)
        payload: dict[str, Any] = {
            "runtime": "opencode",
            "revision": 2,
            "capabilities": [
                {
                    "capabilityId": provider_config.CAPABILITY_SESSION_DISCOVERY,
                    "supported": True,
                    "available": True,
                    "allowed": True,
                    "metadata": {"discoveryState": "partial"},
                }
            ],
        }

        await runtime._handle_notification("runtime.capability.updated", payload)
        await runtime._handle_notification("runtime.capabilities.update", payload)
        assert host.runtime_capabilities_update.await_count == 2
        decoded = host.runtime_capabilities_update.await_args.args[0]
        assert decoded.capabilities[0].capability_id == "session.discovery"

        await runtime._handle_notification("session.capability.updated", payload)
        await runtime._handle_notification("session.capabilities.update", payload)
        assert host.session_capabilities_update.await_count == 2

        # An unrecognised notification must surface in the logs, not vanish.
        with patch("connector.runtimes.opencode.runtime.logger") as mock_logger:
            await runtime._handle_notification("runtime.capability.teleported", payload)
        mock_logger.debug.assert_called_once()
        assert mock_logger.debug.call_args.args[1] == "runtime.capability.teleported"

    asyncio.run(run())


def test_session_discovery_capability_is_derived_not_hardcoded() -> None:
    """sessionDiscovery follows the Hub capability, never a constant (m3)."""

    assert provider_config.opencode_capabilities(None)["sessionDiscovery"] is False
    row = {
        "capabilityId": provider_config.CAPABILITY_SESSION_DISCOVERY,
        "supported": True,
        "available": True,
        "allowed": True,
    }
    assert provider_config.opencode_capabilities({"capabilities": [row]})[
        "sessionDiscovery"
    ] is True


def test_read_path_wraps_decode_failures_as_upstream_errors() -> None:
    """A canonical decode failure surfaces as RuntimeUpstreamError, not ValueError (m5)."""

    async def run() -> None:
        runtime = _Pages([{"runtime": "opencode", "status": "not-a-real-status"}])
        with pytest.raises(RuntimeUpstreamError):
            await runtime.get_session_state("a")

    asyncio.run(run())


def test_inventory_pages_preserve_host_ids_and_sync_metadata() -> None:
    async def run() -> None:
        runtime = _Pages(
            [
                {
                    "sessions": [
                        {
                            "sessionId": "a",
                            "externalSessionId": "native-a",
                            "runtime": "opencode",
                            "metadata": {"sync": {"requires_timeline_sync": True}},
                        }
                    ],
                    "nextCursor": "page-2",
                },
                {
                    "sessions": [
                        {
                            "sessionId": "b",
                            "externalSessionId": "native-b",
                            "runtime": "opencode",
                        }
                    ]
                },
            ]
        )
        inventory = await runtime.list_complete_session_inventory(page_size=1)
        assert [item.session_id for item in inventory] == ["a", "b"]
        assert inventory[0].metadata["sync"]["requires_timeline_sync"] is True
        assert runtime.calls[1][1]["cursor"] == "page-2"

    asyncio.run(run())


@pytest.mark.parametrize(
    "pages",
    [
        [
            {"sessions": [], "nextCursor": "loop"},
            {"sessions": [], "nextCursor": "loop"},
        ],
        [
            {
                "sessions": [{"sessionId": "a", "externalSessionId": "a"}],
                "nextCursor": "next",
            },
            {"sessions": [{"sessionId": "a", "externalSessionId": "a"}]},
        ],
    ],
)
def test_inventory_rejects_incomplete_or_repeated_pages(pages: list[Any]) -> None:
    async def run() -> None:
        with pytest.raises(RuntimeUpstreamError):
            await _Pages(pages).list_complete_session_inventory()

    asyncio.run(run())


def test_snapshot_requires_all_pages_from_same_capture() -> None:
    async def run() -> None:
        base = {
            "sessionId": "a",
            "externalSessionId": "native-a",
            "items": [],
            "watermark": {"seq": 1},
            "snapshotComplete": True,
        }
        runtime = _Pages(
            [{**base, "nextCursor": "next"}, {**base, "watermark": {"seq": 2}}]
        )
        with pytest.raises(RuntimeUpstreamError, match="changed"):
            await runtime.get_session_snapshot("a", "native-a")
        runtime = _Pages([{**base, "metadata": {"totalItems": 1}}])
        with pytest.raises(RuntimeUpstreamError, match="missing"):
            await runtime.get_session_snapshot("a", "native-a")

    asyncio.run(run())


def test_read_path_forwards_catalogs_states_and_notices() -> None:
    async def run() -> None:
        runtime = _Pages(
            [
                {"runtime": "opencode", "revision": 3, "models": []},
                {"runtime": "opencode", "revision": 3, "permissions": []},
                {"sessionId": "a", "runtime": "opencode", "status": "running"},
                {"notices": []},
            ]
        )
        assert (await runtime.list_model_catalog()).models == ()
        assert (await runtime.list_permission_catalog()).permissions == ()
        state = await runtime.get_session_state("a")
        assert state is not None and state.status == "running"
        assert await runtime.get_session_notices("a") == ()
        assert [method for method, _ in runtime.calls] == [
            "catalog.listModels",
            "catalog.listPermissions",
            "session.getState",
            "session.getNotices",
        ]

    asyncio.run(run())


def test_update_session_selections_reports_applied_and_ignored_keys() -> None:
    """An unknown selection key must surface in the回执, never vanish."""

    async def run() -> None:
        runtime = _Pages(
            [{"ok": True, "sessionId": "a", "applied": ["model"], "ignored": ["bogus"]}]
        )
        result = await runtime.update_session_selections(
            "a", "native-a", {"model": "m", "bogus": "x"}
        )
        assert result.ok is True
        assert result.result["applied"] == ["model"]
        assert result.result["ignored"] == ["bogus"]
        assert runtime.calls == [
            (
                "session.updateSelections",
                {
                    "sessionId": "a",
                    "externalSessionId": "native-a",
                    "selections": {"model": "m", "bogus": "x"},
                },
            )
        ]

    asyncio.run(run())


def test_write_result_without_an_explicit_ok_is_a_failure() -> None:
    """Fail-closed (P3 finding 9): a result missing `ok` is NOT success."""

    async def run() -> None:
        runtime = _Pages([{"sessionId": "a"}])
        result = await runtime.interrupt_session("a")
        assert result.ok is False

    asyncio.run(run())


def test_attachments_are_refused_loudly_not_dropped() -> None:
    """P3 finding 10: the Hub and the Connector agree that attachments are unsupported."""

    async def run() -> None:
        runtime = _Pages([])
        with pytest.raises(RuntimeUnsupportedError):
            await runtime.create_and_start_session("a", "hi", attachments=(object(),))  # type: ignore[arg-type]
        with pytest.raises(RuntimeUnsupportedError):
            await runtime.start_turn("a", "native", "hi", attachments=(object(),))  # type: ignore[arg-type]
        assert runtime.calls == [], "no bridge call may happen for a refused attachment"

    asyncio.run(run())


def test_opencode_claims_and_source_key_distinguish_instances(tmp_path: Path) -> None:
    """Audit M1: two OpenCode processes sharing a registry must not collapse to
    one key, and no token/pid leaks into the key."""

    async def run() -> None:
        registry = tmp_path / "registry"
        registry.mkdir()
        loc_a = tmp_path / "project-a"
        loc_b = tmp_path / "project-b"

        async def discoverer(values: dict[str, Any]) -> OpenCodeDiscovery:
            return OpenCodeDiscovery(True, True, ())

        provider = OpenCodeProvider(discoverer=discoverer)
        base = await provider.validate_config({"registryDir": str(registry)})
        one = await provider.validate_config(
            {"registryDir": str(registry), "servicePid": 4242, "location": str(loc_a)}
        )
        one_again = await provider.validate_config(
            {"registryDir": str(registry), "servicePid": 4242, "location": str(loc_a)}
        )
        other_location = await provider.validate_config(
            {"registryDir": str(registry), "servicePid": 4242, "location": str(loc_b)}
        )
        other_pid = await provider.validate_config(
            {"registryDir": str(registry), "servicePid": 4343, "location": str(loc_a)}
        )

        # Same (servicePid, location) → identical, stable identities.
        assert provider.resource_claims(one) == provider.resource_claims(one_again)
        assert provider.session_source_key(one) == provider.session_source_key(one_again)
        # A different pid or location on the same registry → distinct identities.
        assert provider.resource_claims(one) != provider.resource_claims(other_location)
        assert provider.resource_claims(one) != provider.resource_claims(other_pid)
        assert provider.session_source_key(one) != provider.session_source_key(other_pid)
        # With no instance selector the key is the plain registry key again.
        assert provider.resource_claims(base) != provider.resource_claims(one)
        for config in (one, other_location, other_pid):
            key = provider.session_source_key(config).key
            assert "token" not in key
            assert str(os.getpid()) not in key

    asyncio.run(run())

