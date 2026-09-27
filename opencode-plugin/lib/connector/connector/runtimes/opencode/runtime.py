from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from contextlib import suppress
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeTimelineSnapshot,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.opencode import discovery, provider_config
from connector.runtimes.opencode.bridge import models
from connector.runtimes.opencode.bridge.client import BridgeClient, BridgeRpcError
from connector.runtimes.opencode.bridge.sync import SyncRelay

BRIDGE_POLL_INTERVAL_SECONDS = 5.0


class OpenCodeRuntime(AgentRuntime):
    """Attach-only adapter; the plugin owns projection, the Connector only decodes.

    One instance binds one ``(servicePid, location)`` pair of a running OpenCode
    service. ``start()``/``stop()`` never spawn OpenCode: the plugin spawns the
    Connector, and this runtime only attaches to the endpoint it advertises.
    """

    def __init__(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
        client_version: str = "1.0",
    ) -> None:
        self.config = config
        self.host = host
        self.client_version = client_version
        self._identity = RuntimeIdentity(
            "opencode", "unknown", "OpenCode", runtime_id=config.runtime_id
        )
        self._client: BridgeClient | None = None
        self._connect_lock = asyncio.Lock()
        # Each connection owns one inventory and one history capture.
        self._read_lock = asyncio.Lock()
        self._stopping = False
        self._restart_task: asyncio.Task[None] | None = None
        self._sync: SyncRelay | None = None
        self._sync_mode = "events"

    @property
    def _runtime_id(self) -> str:
        return self.config.runtime_id or "opencode"

    @property
    def sync_mode(self) -> str:
        return self._sync_mode

    async def resynchronize(
        self, session_id: str | None = None, external_session_id: str | None = None
    ) -> None:
        _ = external_session_id
        await self._ensure_client()
        if self._sync is None:
            return
        if session_id:
            checkpoint = await self._sync.read_checkpoint(session_id)
            from_seq = checkpoint.get("throughSeq") if checkpoint else None
            history_hash = checkpoint.get("historyHash") if checkpoint else None
            # rev3 ruling 3: always send the hash so the Hub can detect prefix
            # drift and fall back to a full snapshot instead of trusting fromSeq.
            await self._sync.subscribe(
                session_id, from_seq=from_seq, history_hash=history_hash
            )
            return
        self._sync.restart()

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    async def start(self) -> None:
        self._stopping = False
        await self.host.runtime_health_update(
            "starting",
            {
                "code": "runtime_initializing",
                "message": "正在连接 OpenCode 并同步会话…",
                "retryable": True,
            },
        )
        try:
            await self._ensure_client()
        except (OSError, RuntimeError, ValueError):
            with suppress(Exception):
                await self.host.runtime_health_update(
                    "starting",
                    {
                        "code": "runtime_unavailable",
                        "message": "正在等待本地 OpenCode Bridge；请启动 OpenCode 并启用 Agents Anywhere 插件。",
                        "retryable": True,
                    },
                )
            self._schedule_restart()

    async def stop(self) -> None:
        self._stopping = True
        if self._sync is not None:
            await self._sync.close()
            self._sync = None
        if self._restart_task is not None:
            self._restart_task.cancel()
            await asyncio.gather(self._restart_task, return_exceptions=True)
            self._restart_task = None
        async with self._connect_lock:
            client, self._client = self._client, None
            if client is not None:
                await client.close()

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return _decode(
            models.capability_set,
            await self._request("runtime.getCapabilities"),
            connector_id=self.host.connector_id,
        )

    async def list_model_catalog(
        self, query: str | None = None, limit: int = 100
    ) -> RuntimeModelCatalog:
        return _decode(
            models.model_catalog,
            await self._request("catalog.listModels", {"query": query, "limit": limit}),
        )

    async def list_permission_catalog(
        self, query: str | None = None, limit: int = 100
    ) -> RuntimePermissionCatalog:
        return _decode(
            models.permission_catalog,
            await self._request(
                "catalog.listPermissions", {"query": query, "limit": limit}
            ),
        )

    async def list_agent_catalog(self) -> models.RuntimeAgentCatalog:
        """Agent directory (D3). The Hub contract is `params {}` →
        `{ agents: [...] }`; a Hub without `ctx.agent` rejects with
        UNSUPPORTED_OPERATION, which `_request` maps to RuntimeUnsupportedError.
        """

        return _decode(models.agent_catalog, await self._request("catalog.listAgents", {}))

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        _ = force
        async with self._read_lock:
            result = await self._request(
                "session.list", {"limit": limit, "cursor": cursor}
            )
            return tuple(
                _decode(models.session_meta, item) for item in _array(result, "sessions")
            )

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        async with self._read_lock:
            output: list[SessionMeta] = []
            cursors: set[str] = set()
            identities: set[str] = set()
            cursor: str | None = None
            while True:
                result = await self._request(
                    "session.list", {"limit": page_size, "cursor": cursor}
                )
                for item in _array(result, "sessions"):
                    meta = _decode(models.session_meta, item)
                    if meta.session_id in identities:
                        raise RuntimeUpstreamError("OpenCode inventory repeated a session")
                    identities.add(meta.session_id)
                    output.append(meta)
                cursor = _next_cursor(result, cursors)
                if cursor is None:
                    return tuple(output)

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        params: dict[str, Any] = {"sessionId": session_id}
        if limit is not None:
            params["limit"] = limit
        async with self._read_lock:
            items = []
            ids: set[str] = set()
            cursors: set[str] = set()
            first: dict[str, Any] | None = None
            while True:
                result = _object(await self._request("session.getSnapshot", params))
                if result.get("sessionId") != session_id:
                    raise RuntimeUpstreamError(
                        "OpenCode snapshot returned a different session"
                    )
                native_id = result.get("externalSessionId")
                if not isinstance(native_id, str) or not native_id:
                    raise RuntimeUpstreamError(
                        "OpenCode snapshot has no native session identity"
                    )
                if external_session_id and external_session_id != native_id:
                    raise RuntimeUpstreamError(
                        "OpenCode snapshot returned a different native session"
                    )
                if first is None:
                    first = result
                elif result.get("watermark") != first.get(
                    "watermark"
                ) or native_id != first.get("externalSessionId"):
                    raise RuntimeUpstreamError(
                        "OpenCode snapshot changed during pagination"
                    )
                for value in _array(result, "items"):
                    item = _decode(models.timeline_item, value)
                    if item.session_id != session_id or item.id in ids:
                        raise RuntimeUpstreamError(
                            "OpenCode snapshot has duplicate or foreign items"
                        )
                    ids.add(item.id)
                    items.append(item)
                cursor = _next_cursor(result, cursors)
                if cursor is None:
                    complete = (
                        first.get("snapshotComplete", first.get("complete")) is True
                    )
                    metadata = dict(first.get("metadata") or {})
                    total = metadata.get("totalItems")
                    if total is not None and total != len(items):
                        raise RuntimeUpstreamError("OpenCode snapshot is missing a page")
                    return RuntimeTimelineSnapshot(
                        session_id=session_id,
                        external_session_id=native_id,
                        runtime="opencode",
                        items=tuple(items),
                        complete=complete,
                        metadata=metadata,
                    )
                params["cursor"] = cursor

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState:
        payload = _object(
            await self._request("session.getState", {"sessionId": session_id})
        )
        state = _decode(models.session_state, payload)
        if external_session_id and payload.get("externalSessionId") != external_session_id:
            raise RuntimeUpstreamError(
                "OpenCode state returned a different native session"
            )
        return state

    async def get_session_notices(
        self, session_id: str, external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        _ = external_session_id
        result = await self._request(
            "session.getNotices", {"sessionId": session_id}
        )
        return tuple(_decode(models.notice, item) for item in _array(result, "notices"))

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        # `title`/`runtime_options` are DSH-era knobs with no V2 equivalent.
        _ = title, runtime_options
        _reject_attachments(attachments)
        params: dict[str, Any] = {
            "sessionId": session_id,
            "content": content,
            "selections": dict(selections or {}),
        }
        if cwd:
            params["cwd"] = cwd
        if client_message_id:
            params["clientMessageId"] = client_message_id
        return _operation_result(await self._request("session.createAndStart", params))

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        _reject_attachments(attachments)
        params: dict[str, Any] = {
            "sessionId": session_id,
            "content": content,
            "selections": dict(selections or {}),
        }
        if external_session_id:
            params["externalSessionId"] = external_session_id
        if client_message_id:
            params["clientMessageId"] = client_message_id
        if cwd:
            params["cwd"] = cwd
        return _operation_result(await self._request("session.startTurn", params))

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        # V2 exposes no native steer (design rev2 §2.3): capability stays false and
        # a call fails loudly instead of silently dropping the turn.
        _ = session_id, external_session_id, content, attachments, client_message_id
        raise RuntimeUnsupportedError("steer_turn")

    async def interrupt_session(
        self, session_id: str, reason: str | None = None
    ) -> RuntimeOperationResult:
        params: dict[str, Any] = {"sessionId": session_id}
        if reason:
            params["reason"] = reason
        return _operation_result(await self._request("session.interrupt", params))

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        params: dict[str, Any] = {
            "sessionId": session_id,
            "selections": dict(selections),
        }
        if external_session_id:
            params["externalSessionId"] = external_session_id
        return _operation_result(await self._request("session.updateSelections", params))

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        # The Hub enforces §6: only allow_once/deny survive; `always`, a second
        # answer and unknown notices come back as ok=false + a stable code.
        return _operation_result(
            await self._request(
                "session.respondInteraction",
                {
                    "sessionId": session_id,
                    "noticeId": notice_id,
                    "actionId": action_id,
                    "inputData": dict(input_data or {}),
                },
            )
        )

    async def _start_client(self) -> None:
        values = provider_config.normalized_config_values(dict(self.config.values))
        # location is the connection's binding identity (rev3 ruling 1): the Hub
        # fail-closes without it, so an opencode instance must supply one.
        location = values.get("location")
        if not isinstance(location, str) or not location:
            raise RuntimeUnavailableError(
                "OpenCode runtime instances require a project location"
            )
        endpoint = discovery.resolve_endpoint(values)
        if endpoint is None:
            raise RuntimeUnavailableError(
                "请启动 OpenCode，并启用 Agents Anywhere 插件。"
            )
        client = BridgeClient(
            endpoint=endpoint,
            connector_id=self.host.connector_id,
            session_namespace=getattr(
                self.host, "session_namespace", self.host.connector_id
            ),
            location=location,
            client_version=self.client_version,
            startup_timeout=int(values["startupTimeoutMs"]) / 1000,
            request_timeout=int(values["requestTimeoutMs"]) / 1000,
            notification_handler=self._handle_notification,
            exit_handler=self._handle_exit,
        )
        try:
            try:
                result = await client.start()
            except BaseException as error:
                # Handshake success is the authoritative liveness signal, but
                # only a *definitive* failure may delete the Hub-owned file
                # (rev3 4.2): a timeout must be preserved for retry.
                discovery.discard_if_stale(endpoint, error)
                raise
            identity = result["identity"]
            self._identity = RuntimeIdentity(
                runtime="opencode",
                runtime_version=identity.get("runtimeVersion", "unknown"),
                display_name="OpenCode",
                protocol_version=identity["protocolVersion"],
                runtime_id=self.config.runtime_id,
            )
            # Bootstrap only declared capabilities; read-only startup needs no model catalog.
            capabilities = models.capability_set(
                await client.request("runtime.getCapabilities"),
                connector_id=self.host.connector_id,
            )
            await self.host.runtime_capabilities_update(capabilities)
            supported = {
                item.capability_id
                for item in capabilities.capabilities
                if item.available and item.supported
            }
            for capability, method, decode, publish in (
                (
                    "catalog.model",
                    "catalog.listModels",
                    models.model_catalog,
                    "model_catalog_update",
                ),
                (
                    "catalog.permission",
                    "catalog.listPermissions",
                    models.permission_catalog,
                    "permission_catalog_update",
                ),
                (
                    "catalog.agent",
                    "catalog.listAgents",
                    models.agent_catalog,
                    "agent_catalog_update",
                ),
            ):
                # `hasattr` keeps third-party structural hosts that predate
                # `RuntimeHostClient.agent_catalog_update` working: such a host
                # must not turn a healthy bootstrap into a warning per connect,
                # and `catalog.agent` capability stays the source of truth for
                # whether the Hub can list agents.
                if capability not in supported or not hasattr(self.host, publish):
                    continue
                try:
                    await getattr(self.host, publish)(
                        decode(await client.request(method, {"limit": 10000}))
                    )
                except Exception as error:  # noqa: BLE001 - one catalog must not close the runtime
                    logger.warning(
                        "OpenCode initial catalog unavailable method={} error_type={}; other runtime operations remain available",
                        method,
                        type(error).__name__,
                    )
            if self._stopping or not client.connected:
                raise RuntimeUnavailableError("OpenCode bridge is stopping")
            self._client = client
            self._sync_mode = _sync_mode_from(result)
            if self._sync_mode == "events":
                await self.host.runtime_health_update(
                    "starting",
                    {
                        "code": "runtime_initializing",
                        "message": "正在同步 OpenCode 会话…",
                        "retryable": True,
                    },
                )
                self._sync = SyncRelay(client, self.host, runtime_id=self._runtime_id)
                self._sync.start()
            else:
                with suppress(Exception):
                    await self.host.runtime_health_update("running")
        except BaseException:
            await client.close()
            raise

    async def _ensure_client(self) -> None:
        if self._client is not None and self._client.connected:
            return
        async with self._connect_lock:
            if self._stopping:
                raise RuntimeUnavailableError("OpenCode bridge is stopping")
            if self._client is not None and not self._client.connected:
                client, self._client = self._client, None
                await client.close()
            if self._client is None:
                await self._start_client()

    async def _request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> Any:
        try:
            await self._ensure_client()
            if self._client is None:
                raise RuntimeUnavailableError("OpenCode bridge is not running")
            return await self._client.request(method, params)
        except BridgeRpcError as exc:
            if exc.bridge_code in {"UNSUPPORTED_OPERATION", "METHOD_NOT_FOUND"}:
                raise RuntimeUnsupportedError(method) from exc
            if exc.bridge_code in {
                "INVALID_REQUEST",
                "INVALID_PARAMS",
                "SESSION_NOT_FOUND",
            }:
                raise RuntimeInvalidRequestError(str(exc)) from exc
            if exc.retryable:
                raise RuntimeUnavailableError(str(exc)) from exc
            raise RuntimeUpstreamError(str(exc)) from exc
        except (OSError, TimeoutError, ConnectionError, RuntimeError) as exc:
            logger.warning(
                "OpenCode bridge request unavailable method={} error_type={}; check the plugin Bridge logs page",
                method,
                type(exc).__name__,
            )
            raise RuntimeUnavailableError("OpenCode bridge is unavailable") from exc
        except ValueError as exc:
            raise RuntimeUpstreamError(str(exc)) from exc

    async def _handle_notification(
        self, method: str, params: Mapping[str, Any]
    ) -> None:
        # Additive platform notifications stay mechanical; native OpenCode events
        # are never interpreted here.
        # Contract name (rev3/F2): `runtime.capability.updated` is canonical — the
        # same name this Connector forwards to the backend (`server/runtime_host.py`)
        # and the name the dsh-bridge-next Hub emits. The legacy pre-gateway
        # spelling `runtime.capabilities.update` is kept as an accepted alias so a
        # Hub emitting either spelling resolves identically. Same for the
        # session-scoped pair.
        if method in {"runtime.capability.updated", "runtime.capabilities.update"}:
            await self.host.runtime_capabilities_update(
                models.capability_set(params, connector_id=self.host.connector_id)
            )
        elif method in {"session.capability.updated", "session.capabilities.update"}:
            await self.host.session_capabilities_update(
                models.capability_set(params, connector_id=self.host.connector_id)
            )
        elif method == "sync.batch" and self._sync is not None:
            self._sync.accept(params)
        elif method == "runtime.error" and self._sync is not None:
            data = params.get("data")
            stream_id = data.get("streamId") if isinstance(data, dict) else None
            self._sync.restart(stream_id if isinstance(stream_id, str) else None)
        else:
            # Never silently drop: an unknown notification is still evidence (a
            # newer Hub or a contract drift) and must be visible in the logs.
            logger.debug(
                "OpenCode bridge notification ignored method={} (not on the P1 surface)",
                method,
            )

    async def _handle_exit(self, return_code: int | None) -> None:
        _ = return_code
        self._client = None
        if self._sync is not None:
            await self._sync.close()
            self._sync = None
        if self._stopping:
            return
        with suppress(Exception):
            await self.host.runtime_error(
                "opencode",
                "OPENCODE_BRIDGE_EXITED",
                "OpenCode bridge disconnected",
                details={"retryable": True},
            )
        # The instance is still the user's active runtime, but it is no longer
        # usable: surface that instead of leaving the platform showing "running".
        with suppress(Exception):
            await self.host.runtime_health_update(
                "error",
                {
                    "code": "runtime_unavailable",
                    "message": "OpenCode 已断开，正在等待本地 Bridge 恢复；请确认 OpenCode 和 Agents Anywhere 插件已启动。",
                    "retryable": True,
                },
            )
        self._schedule_restart()

    def _schedule_restart(self) -> None:
        if not self._stopping and (
            self._restart_task is None or self._restart_task.done()
        ):
            self._restart_task = asyncio.create_task(self._restart_loop())

    async def _restart_loop(self) -> None:
        values = provider_config.normalized_config_values(dict(self.config.values))
        fast_attempts = int(values["maxRestartAttempts"])
        attempt = 0
        while not self._stopping:
            if self._client is not None and self._client.connected:
                return
            delay = BRIDGE_POLL_INTERVAL_SECONDS
            if attempt < fast_attempts:
                delay = min(
                    int(values["restartBackoffMs"]) / 1000 * 2**attempt, delay
                )
            await asyncio.sleep(delay)
            if self._stopping:
                return
            try:
                # Re-read the registry on every attempt: OpenCode can restart on
                # a new port or a new service process.
                await self._ensure_client()
                return
            except Exception:  # noqa: BLE001 - offline is expected while reconnecting
                attempt = min(attempt + 1, fast_attempts)
                # Stay quiet while offline; the exit handler already published health.
                continue


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeUpstreamError("OpenCode response must be an object")
    return value


def _operation_result(payload: Any) -> RuntimeOperationResult:
    """Decode a write-method result; ``{ok:false, code}`` maps to ok=False.

    The bridge reports business outcomes (`already_answered`, `unsupported_action`,
    `unknown_notice`, `local_confirmation_required`) inside a successful RPC
    result, so they surface as an operation result rather than an upstream error.
    """

    data = _object(payload)
    code = data.get("code")
    message = data.get("message")
    raw = data.get("result")
    result = dict(raw) if isinstance(raw, Mapping) else {}
    # The bridge returns session identity at the top level; keep it reachable so
    # callers can map a freshly created session without a second round-trip.
    # `applied`/`ignored` are the `session.updateSelections`回执: an unknown
    # selection key must surface, never be silently dropped.
    for key in ("sessionId", "externalSessionId", "applied", "ignored"):
        value = data.get(key)
        if value is not None:
            result.setdefault(key, value)
    # Fail-closed: an absent/non-boolean `ok` is NOT success. The Hub always
    # emits an explicit boolean, so a missing one means a contract violation,
    # never a silent "assume it worked".
    return RuntimeOperationResult(
        ok=data.get("ok") is True,
        code=code if isinstance(code, str) else None,
        message=message if isinstance(message, str) else None,
        result=result,
    )


def _reject_attachments(attachments: tuple[RuntimeAttachment, ...]) -> None:
    """The Hub advertises ``runtime.attachment`` as unavailable (P3 scope)."""

    if attachments:
        raise RuntimeUnsupportedError("attachments")


def _sync_mode_from(result: Mapping[str, Any]) -> str:
    """Read the bridge sync mode; ``features`` may be absent or null (m4)."""

    features = result.get("features")
    mode = features.get("syncMode") if isinstance(features, Mapping) else None
    return "events" if mode == "events" else "polling"


def _decode(decoder: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Map canonical decode failures onto the contract's upstream error (m5)."""

    try:
        return decoder(*args, **kwargs)
    except ValueError as exc:
        raise RuntimeUpstreamError(str(exc)) from exc


def _array(value: Any, key: str) -> list[Any]:
    field = _object(value).get(key)
    if not isinstance(field, list):
        raise RuntimeUpstreamError(f"OpenCode response {key} must be an array")
    return field


def _next_cursor(value: Any, seen: set[str]) -> str | None:
    cursor = _object(value).get("nextCursor")
    if cursor is None:
        return None
    if not isinstance(cursor, str) or not cursor or cursor in seen:
        raise RuntimeUpstreamError("OpenCode returned an invalid or repeated cursor")
    seen.add(cursor)
    return cursor
