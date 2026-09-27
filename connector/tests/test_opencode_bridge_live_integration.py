"""Live cross-language integration: the REAL built OpenCode Bridge Hub (Node)
against the REAL Connector runtime, over loopback TCP + NDJSON JSON-RPC 2.0.

Nothing on the wire is simulated: the Hub is the shipped artifact
(`opencode-plugin/lib/index.js`, loaded by `tests/harness/live-hub-harness.mjs`
through the plugin's own `setup()` entry point), the endpoint file the Connector
reads is written by the Hub, and the Connector side is
`bridge/client.py` + `bridge/sync.py` + `runtime.py` unchanged.

Covered: initialize(location) -> ping -> runtime.getCapabilities
(`session.discovery` + `metadata.discoveryState`) -> session.list ->
session.getSnapshot -> runtime.sync.subscribe (full, then incremental via
historyHash) -> sync.batch begin/items/commit -> runtime.sync.ack ->
session.getNotices; plus the negated paths (wrong token, missing location,
cross-location isolation, bridge-initiated request, unknown session).

Requires `yarn build` in `opencode-plugin` (the harness loads `lib/index.js`)
and a `node` on PATH; otherwise the module skips with a stated reason.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import dataclasses
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from queue import Empty, Queue
from typing import Any
from unittest.mock import create_autospec

import pytest

from connector.runtime_protocol import RuntimeConfig, RuntimeHostClient, RuntimeUnsupportedError
from connector.runtimes.opencode import discovery, provider_config
from connector.runtimes.opencode.bridge import models
from connector.runtimes.opencode.bridge.client import BridgeClient, BridgeRpcError
from connector.runtimes.opencode.runtime import OpenCodeRuntime

REPO = Path(__file__).resolve().parents[2]
PLUGIN = REPO / "opencode-plugin"
LIB_ENTRY = PLUGIN / "lib" / "index.js"
HARNESS = PLUGIN / "tests" / "harness" / "live-hub-harness.mjs"

NATIVE_A = "ses_live_a"
NATIVE_B = "ses_live_b"
NAMESPACE = "live:ns"
CONNECTOR_ID = "live-connector"
TOKEN_LEN = 32


def platform_session_id(native_id: str) -> str:
    digest = hashlib.sha256(f"{NAMESPACE}:opencode:{native_id}".encode()).hexdigest()
    return f"sess_opencode_{digest[:24]}"


pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not LIB_ENTRY.exists(),
    reason=(
        "live bridge integration needs a `node` on PATH and a built "
        f"{LIB_ENTRY.relative_to(REPO)} (run `yarn build` in opencode-plugin)"
    ),
)


async def _noop_exit(_code: int | None) -> None:
    return None


async def _wait_until(predicate: Any, timeout: float = 6.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.02)
    return predicate()


class LiveHub:
    """The Node child process running the real Hub, plus its endpoint file."""

    def __init__(self, proc: subprocess.Popen[str], info: dict[str, Any], root: Path) -> None:
        self.proc = proc
        self.info = info
        self.root = root
        self.loc_a = root / "proj-a"
        self.loc_b = root / "proj-b"
        self.loc_c = root / "proj-c"
        self.data_dir = root / "data"
        self.stderr_path = root / "harness.stderr.log"
        self._queue: Queue[str | None] = Queue()
        self._skipped: list[str] = []
        self._sequence = 0
        threading.Thread(target=self._pump, daemon=True).start()

    # ---------------------------------------------------------------- plumbing
    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._queue.put(line.rstrip("\n"))
        self._queue.put(None)

    def _send(self, command: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(command + "\n")
        self.proc.stdin.flush()

    def _skip(self, line: str) -> None:
        # The built plugin logs to stdout; the protocol lines are the prefixed
        # ones only. Anything else is retained for the failure message.
        self._skipped.append(line)

    def _stderr(self) -> str:
        try:
            return self.stderr_path.read_text(encoding="utf-8", errors="replace")[-2000:]
        except OSError:
            return "<unreadable>"

    def expect(self, prefix: str, timeout: float = 15.0) -> str:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f"timed out waiting for {prefix!r}; stdout tail={self._skipped[-10:]} "
                    f"stderr={self._stderr()}"
                )
            try:
                line = self._queue.get(timeout=remaining)
            except Empty:
                continue
            if line is None:
                raise AssertionError(
                    f"harness exited while waiting for {prefix!r} "
                    f"(returncode={self.proc.poll()}) stderr={self._stderr()}"
                )
            if line.startswith("HARNESS_ERROR"):
                raise AssertionError(f"harness failed to start: {line} stderr={self._stderr()}")
            if line.startswith(prefix):
                return line
            self._skip(line)

    # ------------------------------------------------------------------ events
    def seed(
        self,
        event_type: str,
        data: dict[str, Any] | None = None,
        *,
        durable_seq: int | None = None,
        native_id: str = NATIVE_A,
        directory: Path | None = None,
    ) -> None:
        self._sequence += 1
        envelope: dict[str, Any] = {
            "id": f"{event_type}:{self._sequence}",
            "created": "2026-09-27T00:00:00.000Z",
            "type": event_type,
            "location": {"directory": str(directory or self.loc_a)},
            "data": {"sessionID": native_id, **(data or {})},
        }
        if durable_seq is not None:
            envelope["durable"] = {"aggregateID": native_id, "seq": durable_seq, "version": 1}
        payload = base64.b64encode(json.dumps(envelope).encode("utf-8")).decode("ascii")
        self._send(f"EVENT {payload}")
        line = self.expect("EVENT_OK ", timeout=10.0)
        assert line.endswith(" 1"), f"the hub rejected {event_type} (durable={durable_seq}): {line}"

    def seed_demo_session(self, *, native_id: str = NATIVE_A, directory: Path | None = None) -> None:
        """Seven durable events, mirrored from the plugin's own integration seed."""
        where = directory or self.loc_a
        self.seed("session.created", {"title": "Live session"}, durable_seq=1, native_id=native_id, directory=where)
        self.seed("session.next.prompted", {"text": "run the tests"}, durable_seq=2, native_id=native_id, directory=where)
        self.seed("session.text.started", {"assistantMessageID": "msg_1", "ordinal": 0}, durable_seq=3, native_id=native_id, directory=where)
        self.seed("session.text.delta", {"assistantMessageID": "msg_1", "delta": "ok", "ordinal": 0}, durable_seq=4, native_id=native_id, directory=where)
        self.seed("session.tool.called", {"id": "call_1", "assistantMessageID": "msg_1", "input": {"cmd": "ls"}, "executed": True}, durable_seq=5, native_id=native_id, directory=where)
        self.seed("session.tool.success", {"id": "call_1", "content": "done", "executed": True}, durable_seq=6, native_id=native_id, directory=where)
        self.seed("session.step.ended", {"assistantMessageID": "msg_1", "cost": 0.02, "tokens": {"input": 5}}, durable_seq=7, native_id=native_id, directory=where)

    # ---------------------------------------------------------------- endpoint
    @property
    def registry_dir(self) -> Path:
        return self.data_dir / "opencode-bridge" / "endpoints"

    def endpoint_files(self) -> list[Path]:
        return sorted(self.data_dir.rglob("*.json"))

    def resolve_endpoint(self, location: Path | None = None) -> discovery.BridgeEndpoint | None:
        values = {"registryDir": str(self.registry_dir), "location": str(location or self.loc_a)}
        return discovery.resolve_endpoint(values)

    def make_client(
        self,
        *,
        location: Path | None = None,
        overrides: dict[str, Any] | None = None,
        notification_handler: Any = None,
    ) -> BridgeClient:
        endpoint = self.resolve_endpoint(self.loc_a if location is None else location)
        assert endpoint is not None, "the hub must publish an endpoint file for its own location"
        if overrides:
            endpoint = dataclasses.replace(endpoint, **overrides)
        return BridgeClient(
            endpoint=endpoint,
            connector_id=CONNECTOR_ID,
            client_version="1.0",
            session_namespace=NAMESPACE,
            location=str(self.loc_a if location is None else location),
            startup_timeout=10.0,
            request_timeout=10.0,
            notification_handler=notification_handler or (lambda method, params: _na()),
            exit_handler=_noop_exit,
        )

    # --------------------------------------------------------- write surface
    def permission(self, spec: dict[str, Any]) -> None:
        """Ingest a `permission.asked` event through the real Hub."""
        payload = base64.b64encode(json.dumps(spec).encode("utf-8")).decode("ascii")
        self._send(f"PERMISSION {payload}")
        line = self.expect("PERMISSION_OK ", timeout=10.0)
        assert line.endswith(" 1"), f"the hub rejected the permission spec: {line}"

    def evaluate(self, payload: dict[str, Any]) -> str:
        """Invoke the installed evaluate hook; returns its rendered return value."""
        encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
        self._send(f"EVALUATE {encoded}")
        return self.expect("EVALUATE_RESULT ", timeout=10.0).split(" ", 1)[1].strip()

    def calls(self) -> list[dict[str, Any]]:
        self._send("CALLS")
        return json.loads(self.expect("CALLS ", timeout=10.0).split(" ", 1)[1])

    def replies(self) -> list[dict[str, Any]]:
        self._send("REPLIES")
        return json.loads(self.expect("REPLIES ", timeout=10.0).split(" ", 1)[1])

    def stop(self) -> None:
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.write("STOP\n")
                self.proc.stdin.flush()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)


async def _na() -> None:
    return None


async def _rpc_error(coro: Any) -> BridgeRpcError:
    """Await `coro` expecting a JSON-RPC error frame from the bridge."""
    try:
        result = await coro
    except BridgeRpcError as exc:
        return exc
    raise AssertionError(f"expected a BridgeRpcError, got {result!r}")


@pytest.fixture()
def live_hub(tmp_path: Path) -> Any:
    root = tmp_path / "live"
    for name in ("proj-a", "proj-b", "proj-c"):
        (root / name).mkdir(parents=True)
    env = {
        **os.environ,
        "AGENT_CONNECTOR_DATA_DIR": str(root / "data"),
        "AA_HARNESS_LOCATION_A": str(root / "proj-a"),
        "AA_HARNESS_LOCATION_B": str(root / "proj-b"),
    }
    stderr_file = (root / "harness.stderr.log").open("w", encoding="utf-8")
    proc = subprocess.Popen(
        [shutil.which("node") or "node", str(HARNESS)],
        cwd=str(PLUGIN),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=stderr_file,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    hub = LiveHub(proc, {}, root)
    try:
        ready = hub.expect("HARNESS_READY ")
        info = json.loads(ready.split(" ", 1)[1])
        hub.info = info
        yield hub
    finally:
        hub.stop()
        stderr_file.close()


# --------------------------------------------------------------------------- 1
def test_live_hub_contract_and_connector_decoders(live_hub: LiveHub) -> None:
    live_hub.seed_demo_session()
    frames: list[tuple[str, dict[str, Any]]] = []

    async def record(method: str, params: Any) -> None:
        frames.append((method, dict(params)))

    def batches() -> list[dict[str, Any]]:
        return [params for method, params in frames if method == "sync.batch"]

    def batch(phase: str, stream_id: str | None = None) -> dict[str, Any]:
        for params in batches():
            if params.get("phase") == phase and (
                stream_id is None or params.get("streamId") == stream_id
            ):
                return params
        raise AssertionError(f"no {phase!r} sync.batch arrived: {[p.get('phase') for p in batches()]}")

    async def scenario() -> None:
        client = live_hub.make_client(notification_handler=record)
        try:
            # --- published endpoint file is the real shape the Connector parses
            files = live_hub.endpoint_files()
            assert len(files) == 1, files
            assert files[0].parent == live_hub.registry_dir, files[0]
            endpoint = live_hub.resolve_endpoint()
            assert endpoint is not None
            assert endpoint.host == "127.0.0.1"
            assert endpoint.protocol_version == "1.0"
            assert len(endpoint.token) == 43, "base64url of the 32-byte endpoint token"
            assert set(endpoint.locations) == {str(live_hub.loc_a), str(live_hub.loc_b)}
            # a project this service process does not serve is refused
            assert live_hub.resolve_endpoint(live_hub.loc_c) is None

            # --- initialize(with location)
            result = await client.start()
            identity = result["identity"]
            assert identity["runtime"] == "opencode"
            assert identity["protocolVersion"] == "1.0"
            assert result["features"]["syncMode"] == "events"

            # --- ping
            assert (await client.request("ping"))["ok"] is True

            # --- runtime.getCapabilities: session.discovery + discoveryState
            caps = await client.request("runtime.getCapabilities")
            rows = {row["capabilityId"]: row for row in caps["capabilities"]}
            discovery_row = rows["session.discovery"]
            assert discovery_row["supported"] and discovery_row["available"]
            assert discovery_row["metadata"]["discoveryState"] == "partial"
            assert caps["metadata"]["discoveryState"] == "partial"
            assert "sessionDiscovery" not in caps, "rev3 ruling 2: no root sessionDiscovery field"
            # ... and the real Connector decoder + AA capability gate agree
            decoded = models.capability_set(caps, connector_id=CONNECTOR_ID)
            decoded_rows = {row.capability_id: row for row in decoded.capabilities}
            assert decoded_rows["session.discovery"].metadata["discoveryState"] == "partial"
            gate = provider_config.opencode_capabilities(caps)
            assert gate["sessionDiscovery"] is True
            assert gate["modelCatalog"] is False
            # P3 write surface: createAndStart/startTurn/interrupt/approval are on.
            assert gate["createAndStartSession"] is True
            assert gate["startTurn"] is True
            assert gate["interruptTurn"] is True
            assert gate["interactions"] is True
            # V2 has no native steer — capability stays false (design rev2 §2.3).
            assert gate["steerTurn"] is False

            # --- session.list
            session_id = platform_session_id(NATIVE_A)
            listed = await client.request("session.list", {"limit": 10})
            assert listed["partial"] is True
            assert [item["sessionId"] for item in listed["sessions"]] == [session_id]
            assert listed["sessions"][0]["externalSessionId"] == NATIVE_A
            assert listed["sessions"][0]["cwd"] == str(live_hub.loc_a)

            # --- session.getSnapshot, decoded by the shipped Connector decoder
            snapshot = await client.request("session.getSnapshot", {"sessionId": session_id})
            assert snapshot["sessionId"] == session_id
            assert snapshot["snapshotComplete"] is True
            assert snapshot["watermark"] == 7
            assert snapshot["metadata"]["totalItems"] == len(snapshot["items"])
            for raw in snapshot["items"]:
                item = models.timeline_item(raw)
                assert item.session_id == session_id
                assert item.content_hash == raw["contentHash"]
            assert any(item.content.get("text") == "run the tests" for item in map(models.timeline_item, snapshot["items"]))

            # --- session.getState / getNotices
            state = await client.request("session.getState", {"sessionId": session_id})
            assert models.session_state(state).session_id == session_id
            notices = await client.request("session.getNotices", {"sessionId": session_id})
            assert notices["notices"] == []

            # --- runtime.sync.subscribe WITHOUT historyHash -> full snapshot
            full = await client.request("runtime.sync.subscribe", {"sessionId": session_id})
            assert full["sessionId"] == session_id and isinstance(full["streamId"], str)
            assert full["resume"] == "snapshot"
            assert full["throughSeq"] == 7
            assert len(full["historyHash"]) == 64
            assert set(full) == {"sessionId", "streamId", "resume", "throughSeq", "historyHash"}

            assert await _wait_until(lambda: len(batches()) >= 3), batches()
            begin = batch("begin", full["streamId"])
            assert begin["sessionId"] == session_id and begin["streamId"] == full["streamId"]
            assert begin["resume"] == "snapshot"
            assert begin["throughSeq"] == 7 and begin["historyHash"] == full["historyHash"]
            assert begin["diagnostics"]["skippedEventCount"] == 0
            assert begin["meta"]["externalSessionId"] == NATIVE_A
            assert begin["meta"]["cwd"] == str(live_hub.loc_a)
            items_page = batch("items", full["streamId"])
            assert all(raw["sessionId"] == session_id for raw in items_page["items"])
            assert len(items_page["items"]) == len(snapshot["items"])
            commit = batch("commit", full["streamId"])
            assert commit["complete"] is True, "a full snapshot must replace"
            assert commit["throughSeq"] == 7
            assert commit["historyHash"] == full["historyHash"]
            assert commit["externalSessionId"] == NATIVE_A
            assert commit["diagnostics"]["skippedEventCount"] == 0

            # --- runtime.sync.ack is a REQUEST and must be answered
            ack = await client.request(
                "runtime.sync.ack", {"sessionId": session_id, "throughSeq": commit["throughSeq"]}
            )
            assert ack["ok"] is True and ack["throughSeq"] == 7

            # --- subscribe WITH the matching historyHash -> incremental
            before = len(batches())
            delta = await client.request(
                "runtime.sync.subscribe",
                {"sessionId": session_id, "fromSeq": full["throughSeq"], "historyHash": full["historyHash"]},
            )
            assert delta["resume"] == "incremental", delta
            assert delta["throughSeq"] == 7
            assert delta["streamId"] != full["streamId"]
            assert await _wait_until(lambda: len(batches()) > before + 1), batches()
            delta_begin = batch("begin", delta["streamId"])
            assert delta_begin["resume"] == "incremental"
            delta_commit = batch("commit", delta["streamId"])
            assert delta_commit["complete"] is False, "an incremental resume is a delta, not a replacement"

            # --- a stale historyHash must never resume silently
            stale = await client.request(
                "runtime.sync.subscribe",
                {"sessionId": session_id, "fromSeq": 7, "historyHash": "0" * 64},
            )
            assert stale["resume"] == "snapshot", stale

            # --- live phase:notifications after a new durable event
            seen_before = len([p for p in batches() if p.get("phase") == "notifications"])
            await asyncio.to_thread(
                live_hub.seed, "session.text.delta", {"assistantMessageID": "msg_1", "delta": "!", "ordinal": 0}, durable_seq=8
            )
            assert await _wait_until(
                lambda: len([p for p in batches() if p.get("phase") == "notifications"]) > seen_before
            ), batches()
            live = next(
                p for p in batches()
                if p.get("phase") == "notifications" and p.get("throughSeq") == 8
            )
            assert live["streamId"] in {full["streamId"], delta["streamId"], stale["streamId"]}
            methods = {entry["method"] for entry in live["notifications"]}
            assert "timeline.itemUpsert" in methods, methods
            upserts = [e["params"]["item"] for e in live["notifications"] if e["method"] == "timeline.itemUpsert"]
            for raw in upserts:
                models.timeline_item(raw)
            assert any("!" in json.dumps(raw.get("content", {})) for raw in upserts)
            assert live["diagnostics"]["skippedEventCount"] == 0
        finally:
            await client.close()

    asyncio.run(scenario())


# --------------------------------------------------------------------------- 2
def test_live_handshake_fails_closed(live_hub: LiveHub) -> None:
    """Wrong token / missing location / wrong runtime must be refused + closed."""

    async def scenario() -> None:
        # wrong token -> -32001 UNAUTHORIZED and the socket is closed
        bad = live_hub.make_client(overrides={"token": "x" * TOKEN_LEN})
        with pytest.raises(BridgeRpcError) as wrong_token:
            await bad.start()
        assert wrong_token.value.rpc_code == -32001
        assert wrong_token.value.bridge_code == "UNAUTHORIZED"
        assert bad.connected is False, "a rejected handshake must not leave the link open"
        await bad.close()

        # missing location -> -32602 INVALID_PARAMS (rev3 ruling 1, fail-closed)
        from connector.runtimes.opencode.bridge import client as client_module

        endpoint = live_hub.resolve_endpoint()
        assert endpoint is not None
        client = client_module.BridgeClient(
            endpoint=endpoint,
            connector_id=CONNECTOR_ID,
            client_version="1.0",
            session_namespace=NAMESPACE,
            location=None,
            startup_timeout=10.0,
            request_timeout=10.0,
            notification_handler=lambda method, params: _na(),
            exit_handler=_noop_exit,
        )
        with pytest.raises(BridgeRpcError) as missing_location:
            await client.start()
        assert missing_location.value.rpc_code == -32602
        assert missing_location.value.bridge_code == "INVALID_PARAMS"
        assert client.connected is False
        await client.close()

        # a relative location is refused too
        client2 = client_module.BridgeClient(
            endpoint=endpoint,
            connector_id=CONNECTOR_ID,
            client_version="1.0",
            session_namespace=NAMESPACE,
            location="relative/project",
            startup_timeout=10.0,
            request_timeout=10.0,
            notification_handler=lambda method, params: _na(),
            exit_handler=_noop_exit,
        )
        with pytest.raises(BridgeRpcError) as relative:
            await client2.start()
        assert relative.value.rpc_code == -32602
        await client2.close()

    asyncio.run(scenario())


# --------------------------------------------------------------------------- 3
def test_live_locations_do_not_cross(live_hub: LiveHub) -> None:
    live_hub.seed_demo_session(native_id=NATIVE_A, directory=live_hub.loc_a)
    live_hub.seed_demo_session(native_id=NATIVE_B, directory=live_hub.loc_b)

    async def scenario() -> None:
        frames_a: list[tuple[str, dict[str, Any]]] = []
        frames_b: list[tuple[str, dict[str, Any]]] = []

        async def rec_a(method: str, params: Any) -> None:
            frames_a.append((method, dict(params)))

        async def rec_b(method: str, params: Any) -> None:
            frames_b.append((method, dict(params)))

        # Each location attaches to the same hub (one listener, both advertised)
        # and must only ever see its own sessions.
        client_a = live_hub.make_client(notification_handler=rec_a)
        client_b = live_hub.make_client(location=live_hub.loc_b, notification_handler=rec_b)
        try:
            await client_a.start()
            await client_b.start()
            listed_a = await client_a.request("session.list", {"limit": 10})
            listed_b = await client_b.request("session.list", {"limit": 10})
            assert [s["externalSessionId"] for s in listed_a["sessions"]] == [NATIVE_A]
            assert [s["externalSessionId"] for s in listed_b["sessions"]] == [NATIVE_B]

            # B's session is invisible to A and vice versa
            for method in ("session.getSnapshot", "session.getState", "session.getNotices"):
                error = await _rpc_error(
                    client_a.request(method, {"sessionId": platform_session_id(NATIVE_B)})
                )
                assert error.bridge_code == "SESSION_NOT_FOUND", (method, error)
                error_b = await _rpc_error(
                    client_b.request(method, {"sessionId": platform_session_id(NATIVE_A)})
                )
                assert error_b.bridge_code == "SESSION_NOT_FOUND", (method, error_b)

            # a push-sync calibrated by A never carries B's items
            subscription = await client_a.request(
                "runtime.sync.subscribe", {"sessionId": platform_session_id(NATIVE_A)}
            )
            assert await _wait_until(
                lambda: any(m == "sync.batch" and p.get("phase") == "commit" for m, p in frames_a)
            ), frames_a
            for method, params in frames_a:
                if method != "sync.batch":
                    continue
                for raw in params.get("items", []):
                    assert raw["sessionId"] == platform_session_id(NATIVE_A)
            assert [m for m, _ in frames_b] == [], "B must receive no traffic from A's subscription"
            assert subscription["sessionId"] == platform_session_id(NATIVE_A)
        finally:
            await client_a.close()
            await client_b.close()

    asyncio.run(scenario())


# --------------------------------------------------------------------------- 4
def test_live_connector_rejects_a_bridge_initiated_request(live_hub: LiveHub) -> None:
    """The Hub has no request-emitting path at all (its own suite asserts the
    bridge only ever sends notifications), so a stub peer on real loopback TCP
    injects one to prove the Connector's -32601 refusal."""

    async def scenario() -> None:
        received: list[dict[str, Any]] = []

        async def peer(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            initialize = json.loads((await reader.readline()).decode("utf-8"))
            assert initialize["method"] == "initialize"
            writer.write(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": initialize["id"],
                        "result": {
                            "identity": {
                                "runtime": "opencode",
                                "protocolVersion": "1.0",
                                "runtimeVersion": "2.0.18",
                                "displayName": "OpenCode",
                            },
                            "features": {"syncMode": "events", "readOnly": True},
                        },
                    }
                ).encode("utf-8")
                + b"\n"
            )
            writer.write(
                json.dumps(
                    {"jsonrpc": "2.0", "id": "bridge-probe", "method": "runtime.ping", "params": {}}
                ).encode("utf-8")
                + b"\n"
            )
            await writer.drain()
            while True:
                line = await reader.readline()
                if not line:
                    break
                if not line.strip():
                    continue
                frame = json.loads(line.decode("utf-8"))
                received.append(frame)
                if frame.get("id") == "bridge-probe":
                    # The Connector answered the injected request; we are done.
                    break
            writer.close()

        server = await asyncio.start_server(peer, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        endpoint = discovery.BridgeEndpoint(
            host="127.0.0.1",
            port=port,
            token="t" * TOKEN_LEN,
            pid=os.getpid(),
            path=Path("stub-endpoint.json"),
            bridge_id="stub-bridge",
            locations=(),
            protocol_version="1.0",
            service_version=None,
            started_at=None,
        )
        client = BridgeClient(
            endpoint=endpoint,
            connector_id=CONNECTOR_ID,
            client_version="1.0",
            session_namespace=NAMESPACE,
            location=str(live_hub.loc_a),
            startup_timeout=5.0,
            request_timeout=5.0,
            notification_handler=lambda method, params: _na(),
            exit_handler=_noop_exit,
        )
        try:
            await client.start()
            assert await _wait_until(
                lambda: any(frame.get("id") == "bridge-probe" and "error" in frame for frame in received)
            ), received
            refusal = next(
                frame for frame in received if frame.get("id") == "bridge-probe" and "error" in frame
            )
            assert refusal["error"]["code"] == -32601
            assert refusal["error"]["data"]["code"] == "METHOD_NOT_FOUND"
        finally:
            await client.close()
            server.close()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(server.wait_closed(), 5.0)

    asyncio.run(scenario())


# --------------------------------------------------------------------------- 5
def test_live_unknown_session_error_codes(live_hub: LiveHub) -> None:
    live_hub.seed_demo_session()

    async def scenario() -> None:
        frames: list[tuple[str, dict[str, Any]]] = []

        async def record(method: str, params: Any) -> None:
            frames.append((method, dict(params)))

        client = live_hub.make_client(notification_handler=record)
        try:
            await client.start()
            for method in (
                "session.getSnapshot",
                "session.getState",
                "session.getNotices",
                "runtime.sync.subscribe",
            ):
                with pytest.raises(BridgeRpcError) as error:
                    await client.request(method, {"sessionId": "sess_opencode_missing"})
                assert error.value.bridge_code == "SESSION_NOT_FOUND", method
                assert error.value.rpc_code == -32602, method
            # a missing sessionId is invalid params, not method-not-found
            with pytest.raises(BridgeRpcError) as no_id:
                await client.request("session.getSnapshot", {})
            assert no_id.value.rpc_code == -32602
            assert no_id.value.bridge_code == "INVALID_PARAMS"
        finally:
            await client.close()

    asyncio.run(scenario())


# --------------------------------------------------------------------------- 6
def test_live_runtime_end_to_end_ingest(live_hub: LiveHub) -> None:
    """The full Connector runtime: handshake, capabilities, read surface,
    push-sync ingest, checkpoint round-trip and a live notification."""
    live_hub.seed_demo_session()
    host = create_autospec(RuntimeHostClient, instance=True)
    host.connector_id = CONNECTOR_ID
    host.session_namespace = NAMESPACE
    checkpoints: dict[str, Any] = {}
    sync_calls: list[dict[str, Any]] = []
    upserts: list[Any] = []
    ingested = asyncio.Event()
    notified = asyncio.Event()

    async def sync_state_read(key: str) -> Any:
        return checkpoints.get(key)

    async def sync_state_write(key: str, value: Any) -> None:
        checkpoints[key] = value

    async def timeline_sync(session_id: str, runtime: str, items: Any, **kwargs: Any) -> None:
        sync_calls.append({"session_id": session_id, "items": list(items), **kwargs})
        ingested.set()

    async def timeline_item_upsert(item: Any) -> None:
        upserts.append(item)
        notified.set()

    host.sync_state_read = sync_state_read
    host.sync_state_write = sync_state_write
    host.timeline_sync = timeline_sync
    host.timeline_item_upsert = timeline_item_upsert

    config = RuntimeConfig(
        runtime="opencode",
        revision=1,
        values={
            "location": str(live_hub.loc_a),
            "registryDir": str(live_hub.registry_dir),
            "servicePid": live_hub.info["pid"],
        },
        runtime_id="rti_live",
    )
    runtime = OpenCodeRuntime(config, host, client_version="1.0")
    session_id = platform_session_id(NATIVE_A)

    async def scenario() -> None:
        try:
            await runtime.start()

            capabilities = await runtime.get_runtime_capabilities()
            rows = {row.capability_id: row for row in capabilities.capabilities}
            assert rows["session.discovery"].metadata["discoveryState"] == "partial"

            sessions = await runtime.list_complete_session_inventory()
            assert [meta.session_id for meta in sessions] == [session_id]
            assert sessions[0].cwd == str(live_hub.loc_a)

            snapshot = await runtime.get_session_snapshot(session_id)
            assert snapshot.complete is True
            assert snapshot.items and all(item.session_id == session_id for item in snapshot.items)
            state = await runtime.get_session_state(session_id)
            assert state.runtime == "opencode"
            assert await runtime.get_session_notices(session_id) == ()

            # full calibration: no persisted checkpoint yet -> full snapshot
            await runtime.resynchronize(session_id)
            await asyncio.wait_for(ingested.wait(), 8.0)
            first = sync_calls[-1]
            assert first["complete"] is True
            assert first["session_id"] == session_id
            assert [item.id for item in first["items"]] == [
                item.id for item in snapshot.items
            ]
            diagnostics = first["metadata"]["syncDiagnostics"]
            assert diagnostics["skippedItemCount"] == 0
            assert diagnostics["skippedEventCount"] == 0
            assert isinstance(diagnostics["updatedAt"], str)
            key = f"opencode/rti_live/{session_id}"
            assert checkpoints[key]["throughSeq"] == 7
            assert len(checkpoints[key]["historyHash"]) == 64
            assert checkpoints[key]["version"] == 1

            # incremental: the persisted checkpoint calibrates a delta
            ingested.clear()
            await runtime.resynchronize(session_id)
            await asyncio.wait_for(ingested.wait(), 8.0)
            second = sync_calls[-1]
            assert second["complete"] is False, "the resumed delta must not replace the timeline"

            # live notification reaches the host
            await asyncio.to_thread(
                live_hub.seed,
                "session.text.delta",
                {"assistantMessageID": "msg_1", "delta": "!!", "ordinal": 0},
                durable_seq=8,
            )
            assert await _wait_until(notified.is_set, 8.0), "no live timeline_item_upsert"
            assert upserts[-1].session_id == session_id
            assert "!!" in json.dumps(upserts[-1].content)
        finally:
            await runtime.stop()

    asyncio.run(scenario())
    assert host.session_meta_upsert.await_count >= 1
    assert host.session_meta_upsert.await_args.kwargs["cwd"] == str(live_hub.loc_a)


# --------------------------------------------------------------------------- 7
def test_live_runtime_write_round_trip_and_remote_approval(live_hub: LiveHub) -> None:
    """P3 acceptance: a complete remote round-trip over real loopback TCP.

    createAndStart → timeline, approval notice → respondInteraction(allow_once) →
    permission.reply (never `always`) → interrupt, plus every §6 refusal
    (already_answered / unsupported_action / unknown_notice /
    local_confirmation_required / neutral hook)."""
    live_hub.seed_demo_session()
    host = create_autospec(RuntimeHostClient, instance=True)
    host.connector_id = CONNECTOR_ID
    host.session_namespace = NAMESPACE
    host.sync_state_read.return_value = None
    notices: list[Any] = []
    notice_seen = asyncio.Event()

    async def notice_upsert(notice: Any) -> None:
        notices.append(notice)
        notice_seen.set()

    host.notice_upsert = notice_upsert

    config = RuntimeConfig(
        runtime="opencode",
        revision=1,
        values={
            "location": str(live_hub.loc_a),
            "registryDir": str(live_hub.registry_dir),
            "servicePid": live_hub.info["pid"],
        },
        runtime_id="rti_write",
    )
    runtime = OpenCodeRuntime(config, host, client_version="1.0")
    session_id = platform_session_id(NATIVE_A)

    async def scenario() -> None:
        try:
            await runtime.start()

            # --- round trip 1: createAndStart (host mints the native id) --------
            created = await runtime.create_and_start_session(
                platform_session_id("ses_placeholder"),
                "hello from the phone",
                cwd=str(live_hub.loc_a),
                client_message_id="cm-1",
            )
            assert created.ok is True
            native_new = created.result.get("externalSessionId")
            assert isinstance(native_new, str) and native_new.startswith("ses_created_"), created.result
            new_session_id = platform_session_id(native_new)

            listed = {meta.session_id: meta for meta in await runtime.list_sessions(limit=50)}
            assert new_session_id in listed, listed
            snapshot = await runtime.get_session_snapshot(new_session_id)
            assert any(
                item.role == "user" and item.content.get("text") == "hello from the phone"
                for item in snapshot.items
            ), [item.content for item in snapshot.items]

            # --- round trip 2: startTurn on the created session -----------------
            turn = await runtime.start_turn(new_session_id, native_new, "one more")
            assert turn.ok is True

            # --- 链路: a permission notice reaches host.notice_upsert (§6) ------
            await runtime.resynchronize(session_id)
            live_hub.permission({"id": "req_e2e", "action": "webfetch", "sessionID": NATIVE_A})
            assert await _wait_until(notice_seen.is_set, 8.0), "no notice.upsert reached the host"
            linked = notices[-1]
            assert linked.type == "interaction"
            # AA contract (finding 2): interactionType is `approval`; `blocking`
            # is the NoticeBlocking shape and the permission details live in
            # `context`.
            assert linked.interaction_type == "approval"
            assert linked.response_required is True
            assert [a["actionId"] for a in linked.actions] == ["allow_once", "deny"], linked.actions
            assert linked.blocking == {"scope": "session", "targetId": session_id}, linked.blocking
            assert linked.context["permission"] == "webfetch"
            assert linked.context["requestId"] == "req_e2e"
            assert linked.context["requiresLocalConfirmation"] is False

            fetched = await runtime.get_session_notices(session_id)
            assert len(fetched) == 1
            assert fetched[0].notice_id == "notice_req_e2e"
            assert [a["actionId"] for a in fetched[0].actions] == ["allow_once", "deny"]

            # --- respondInteraction(allow_once) lands through permission.reply --
            answer = await runtime.respond_interaction(session_id, "notice_req_e2e", "allow_once")
            assert answer.ok is True
            replies = live_hub.replies()
            assert replies == [{"path": {"requestID": "req_e2e"}, "body": {"reply": "once"}}], replies

            # `permission.replied` (synthesised by the host stub) resolves the
            # notice end-to-end: getNotices now reports it resolved.
            settled = await runtime.get_session_notices(session_id)
            assert settled[0].status == "resolved", settled[0].status

            # first-answer lock (never retried, never cascaded)
            again = await runtime.respond_interaction(session_id, "notice_req_e2e", "deny")
            assert again.ok is False and again.code == "already_answered"

            # --- remote `always` is refused and never reaches permission.reply --
            live_hub.permission({"id": "req_always", "action": "webfetch", "sessionID": NATIVE_A})
            always = await runtime.respond_interaction(session_id, "notice_req_always", "always")
            assert always.ok is False and always.code == "unsupported_action"

            # --- high-risk stays local-only ------------------------------------
            live_hub.permission({"id": "req_high", "action": "write", "sessionID": NATIVE_A})
            high = await runtime.respond_interaction(session_id, "notice_req_high", "allow_once")
            assert high.ok is False and high.code == "local_confirmation_required"

            # --- unknown notice -------------------------------------------------
            missing = await runtime.respond_interaction(session_id, "notice_missing", "allow_once")
            assert missing.ok is False and missing.code == "unknown_notice"

            # none of the refusals may have touched permission.reply
            assert live_hub.replies() == replies, live_hub.replies()
            assert all("always" not in json.dumps(r) for r in replies)

            # --- the evaluate hook stays neutral (A11 unproven → undefined) -----
            assert live_hub.evaluate(
                {"sessionID": NATIVE_A, "agent": "build", "action": "shell", "effect": "ask"}
            ) == "undefined"

            # --- interrupt takes effect ----------------------------------------
            assert (await runtime.interrupt_session(new_session_id, "user")).ok is True
            reason = None
            for _ in range(60):
                state = await runtime.get_session_state(new_session_id)
                reason = state.status_reason
                if reason == "interrupted":
                    break
                await asyncio.sleep(0.05)
            assert reason == "interrupted", f"interrupt did not reach the state: {reason}"

            # --- steerTurn fails loudly (capability=false, never a silent drop) --
            with pytest.raises(RuntimeUnsupportedError):
                await runtime.steer_turn(session_id, NATIVE_A, "steer me")

            # the host saw every write method we claim to serve
            recorded = {call["name"] for call in live_hub.calls()}
            assert {"create", "prompt", "interrupt"} <= recorded, recorded
        finally:
            await runtime.stop()

    asyncio.run(scenario())
