from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from connector.logging import logger
from connector.runtimes.opencode.bridge.client import BridgeClient, BridgeProtocolError
from connector.runtimes.opencode.discovery import BridgeEndpoint


def endpoint(port: int, tmp_path: Path, token: str = "test-token") -> BridgeEndpoint:
    return BridgeEndpoint(
        host="127.0.0.1",
        port=port,
        token=token,
        pid=1,
        path=tmp_path / "endpoint.json",
        bridge_id="bridge-1",
        locations=("/repo",),
    )


def test_bridge_client_handshake_notification_and_disconnect(tmp_path: Path) -> None:
    async def run() -> None:
        notifications: list[tuple[str, dict[str, object]]] = []
        exits: list[int | None] = []
        saw_token = False
        saw_location = False

        async def handle(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            nonlocal saw_token, saw_location
            while line := await reader.readline():
                request = json.loads(line)
                method = request.get("method")
                if method == "initialize":
                    saw_token = request["params"].get("authToken") == "test-token"
                    saw_location = request["params"].get("location") == "/repo"
                    # Both the canonical capability-update name and the legacy
                    # pre-gateway alias must survive the wire (F2).
                    for notification_method in (
                        "runtime.capability.updated",
                        "runtime.capabilities.update",
                    ):
                        writer.write(
                            json.dumps(
                                {
                                    "jsonrpc": "2.0",
                                    "method": notification_method,
                                    "params": {
                                        "runtime": "opencode",
                                        "revision": "1",
                                        "capabilities": [],
                                    },
                                }
                            ).encode()
                            + b"\n"
                        )
                    response = {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {
                            "identity": {
                                "runtime": "opencode",
                                "runtimeVersion": "test",
                                "protocolVersion": "1.0",
                            }
                        },
                    }
                elif method == "ping":
                    response = {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {"nonce": request["params"].get("nonce")},
                    }
                else:
                    continue
                writer.write(json.dumps(response).encode() + b"\n")
                await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]

        async def notification(method: str, params: dict[str, object]) -> None:
            notifications.append((method, params))

        async def exited(code: int | None) -> None:
            exits.append(code)

        client = BridgeClient(
            endpoint=endpoint(port, tmp_path),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            notification_handler=notification,
            exit_handler=exited,
            location="/repo",
        )
        try:
            initialized = await client.start()
            assert initialized["identity"]["runtime"] == "opencode"
            assert await client.request("ping", {"nonce": "n1"}) == {"nonce": "n1"}
            await asyncio.sleep(0)
            assert [method for method, _params in notifications] == [
                "runtime.capability.updated",
                "runtime.capabilities.update",
            ]
            assert saw_token is True
            assert saw_location is True
            await client.close()
            assert exits == []
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_bridge_client_rejects_bridge_initiated_requests(tmp_path: Path) -> None:
    async def run() -> None:
        replies: list[dict[str, object]] = []
        reversed_request = asyncio.Event()

        async def handle(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            while line := await reader.readline():
                request = json.loads(line)
                if request.get("method") == "initialize":
                    writer.write(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": request["id"],
                                "result": {
                                    "identity": {
                                        "runtime": "opencode",
                                        "runtimeVersion": "test",
                                        "protocolVersion": "1.0",
                                    }
                                },
                            }
                        ).encode()
                        + b"\n"
                    )
                    # The bridge must never be able to call back into the Connector.
                    writer.write(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": "bridge-1",
                                "method": "runtime.reverseDanger",
                                "params": {},
                            }
                        ).encode()
                        + b"\n"
                    )
                    await writer.drain()
                    continue
                replies.append(request)
                reversed_request.set()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]

        async def ignore(*_args: object) -> None:
            return None

        client = BridgeClient(
            endpoint=endpoint(port, tmp_path),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            notification_handler=ignore,
            exit_handler=ignore,
        )
        try:
            await client.start()
            await asyncio.wait_for(reversed_request.wait(), 1)
            assert replies[0]["id"] == "bridge-1"
            error = replies[0]["error"]
            assert isinstance(error, dict) and error["code"] == -32601
            await client.close()
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_bridge_client_rejects_non_opencode_identity(tmp_path: Path) -> None:
    async def run() -> None:
        async def handle(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            while line := await reader.readline():
                request = json.loads(line)
                writer.write(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": request["id"],
                            "result": {
                                "identity": {
                                    "runtime": "dsh",
                                    "runtimeVersion": "test",
                                    "protocolVersion": "1.0",
                                }
                            },
                        }
                    ).encode()
                    + b"\n"
                )
                await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]

        async def ignore(*_args: object) -> None:
            return None

        client = BridgeClient(
            endpoint=endpoint(port, tmp_path),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            notification_handler=ignore,
            exit_handler=ignore,
        )
        try:
            try:
                await client.start()
            except RuntimeError as exc:
                assert "identity" in str(exc)
            else:
                raise AssertionError("expected a rejected handshake")
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_bridge_client_rejects_incompatible_protocol_major(tmp_path: Path) -> None:
    """A protocol major other than 1 is a definitive, non-retryable mismatch (D3)."""

    async def run() -> None:
        async def handle(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            while line := await reader.readline():
                request = json.loads(line)
                writer.write(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": request["id"],
                            "result": {
                                "identity": {
                                    "runtime": "opencode",
                                    "runtimeVersion": "test",
                                    "protocolVersion": "2.0",
                                }
                            },
                        }
                    ).encode()
                    + b"\n"
                )
                await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]

        async def ignore(*_args: object) -> None:
            return None

        client = BridgeClient(
            endpoint=endpoint(port, tmp_path),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            notification_handler=ignore,
            exit_handler=ignore,
        )
        try:
            with pytest.raises(BridgeProtocolError):
                await client.start()
            assert client.connected is False
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_bridge_client_survives_blank_keepalive_lines(tmp_path: Path) -> None:
    """NDJSON keepalive blank lines must not tear down the link (m2)."""

    async def run() -> None:
        exits: list[int | None] = []

        async def handle(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            while line := await reader.readline():
                request = json.loads(line)
                if request.get("method") == "initialize":
                    result: dict[str, object] = {
                        "identity": {
                            "runtime": "opencode",
                            "runtimeVersion": "test",
                            "protocolVersion": "1.0",
                        }
                    }
                else:
                    result = {"nonce": request["params"].get("nonce")}
                # Keepalive blanks surround every real frame.
                writer.write(
                    b"\n\n"
                    + json.dumps(
                        {"jsonrpc": "2.0", "id": request["id"], "result": result}
                    ).encode()
                    + b"\n\n"
                )
                await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]

        async def exited(code: int | None) -> None:
            exits.append(code)

        async def ignore(*_args: object) -> None:
            return None

        client = BridgeClient(
            endpoint=endpoint(port, tmp_path),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            notification_handler=ignore,
            exit_handler=exited,
        )
        try:
            await client.start()
            assert await client.request("ping", {"nonce": "n2"}) == {"nonce": "n2"}
            await asyncio.sleep(0)
            assert exits == []
            assert client.connected is True
            await client.close()
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_bridge_runtime_error_is_logged_without_native_message(tmp_path: Path) -> None:
    async def ignore(*_args: object) -> None:
        pass

    client = BridgeClient(
        endpoint=endpoint(1, tmp_path, token="private-token"),
        connector_id="test",
        client_version="test",
        startup_timeout=2,
        request_timeout=2,
        notification_handler=ignore,
        exit_handler=ignore,
    )
    messages: list[str] = []
    sink = logger.add(lambda message: messages.append(message.record["message"]))
    try:
        client._handle_frame(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "method": "runtime.error",
                    "params": {
                        "message": "PRIVATE_SESSION_JSON private-token",
                        "code": -32008,
                        "data": {"code": "PERSISTENCE_ERROR", "retryable": False},
                    },
                }
            ).encode()
        )
        assert client.failure_code == "PERSISTENCE_ERROR"
        assert any("PERSISTENCE_ERROR" in message for message in messages)
        assert all(
            "PRIVATE_SESSION_JSON" not in message and "private-token" not in message
            for message in messages
        )
    finally:
        logger.remove(sink)
