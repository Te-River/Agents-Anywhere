"""OpenCode runtime that attaches to the host's own service over HTTP.

This is the shape Codex (`codex app-server`) and Claude (SDK subprocess) already
use: the Connector is the client, OpenCode stays untouched, and nothing is
installed inside the host process. Discovery is the machine-wide
`service.json` registration; every capability below maps to an endpoint measured
on a live 2.0.18 service (`docs/opencode-server-surface.md`).

Session identity is the compatibility-critical part: Agents Anywhere knows
sessions by `mappers.platform_session_id(namespace, externalId)`, which is
derived from a hash and therefore not invertible, so the runtime keeps a
bidirectional map filled by every inventory read. A session that has never been
seen is resolved by fetching the inventory again rather than by guessing.

The approval policy is ported unchanged from the plugin
(`src/shared/permission-policy.ts`): only ``allow_once`` / ``deny`` are ever
answerable remotely, ``always`` is refused everywhere because it would rewrite
the host's persistent rules, and the read-only allowlist is an **allowlist** -- a
denylist would silently make an unrecognised (or empty) action remote-answerable.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from contextlib import suppress
from typing import Any, Callable

from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAgentCatalog,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.opencode.serve import mappers
from connector.runtimes.opencode.serve.client import (
    OpenCodeServerClient,
    OpenCodeServiceError,
    OpenCodeServiceUnavailable,
)
from connector.runtimes.opencode.serve.service import OpenCodeService, read_service
from connector.runtimes.opencode.serve.timeline import project_messages

RUNTIME = "opencode"
REMOTE_ALLOW_ACTION = "allow_once"
REMOTE_DENY_ACTION = "deny"
PERSISTENT_ACTION = "always"

# Mirrors permission-policy.ts READ_ONLY_ACTIONS: actions proven to only read.
READ_ONLY_ACTIONS = frozenset(
    {
        "read",
        "view",
        "cat",
        "ls",
        "list",
        "glob",
        "grep",
        "search",
        "find",
        "stat",
        "tree",
        "webfetch",
        "fetch",
        "websearch",
    }
)

DEFAULT_PAGE_SIZE = 100


def requires_local_confirmation(action: object) -> bool:
    if not isinstance(action, str):
        return True
    normalized = action.strip().lower()
    return not normalized or normalized not in READ_ONLY_ACTIONS


def remote_actions(action: object) -> list[dict[str, Any]]:
    if requires_local_confirmation(action):
        return []
    return [
        {"actionId": REMOTE_ALLOW_ACTION, "label": "Allow once"},
        {"actionId": REMOTE_DENY_ACTION, "label": "Deny"},
    ]


class OpenCodeServiceRuntime(AgentRuntime):
    """Attach-only: never spawns OpenCode, only joins the registered service."""

    def __init__(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
        client_version: str = "1.0",
        *,
        service_reader: Callable[[], OpenCodeService | None] = read_service,
        client_factory: Callable[[OpenCodeService], OpenCodeServerClient] | None = None,
    ) -> None:
        self.config = config
        self.host = host
        self.client_version = client_version
        self._service_reader = service_reader
        self._client_factory = client_factory or (lambda service: OpenCodeServerClient(service))
        self._client: OpenCodeServerClient | None = None
        self._identity = RuntimeIdentity(RUNTIME, "unknown", "OpenCode", runtime_id=config.runtime_id)
        self._external_by_session: dict[str, str] = {}
        self._restart_task: asyncio.Task[None] | None = None
        self._stopping = False
        self._catalog_revision = 0

    # ------------------------------------------------------------------ identity

    @property
    def _runtime_id(self) -> str:
        return self.config.runtime_id or RUNTIME

    @property
    def sync_mode(self) -> str:
        # The host service is polled and event-streamed from one place; there is
        # no per-session relay channel to negotiate.
        return "events"

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    @property
    def directory(self) -> str | None:
        value = self.config.values.get("location")
        return value if isinstance(value, str) and value else None

    # --------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        self._stopping = False
        await self.host.runtime_health_update(
            "starting",
            {"code": "runtime_initializing", "message": "正在连接 OpenCode 服务…", "retryable": True},
        )
        try:
            await self._attach()
        except (OpenCodeServiceUnavailable, OpenCodeServiceError, OSError, ValueError) as error:
            with suppress(Exception):
                await self.host.runtime_health_update(
                    "starting",
                    {
                        "code": "runtime_unavailable",
                        "message": (
                            "未找到可用的 OpenCode 服务：请打开 OpenCode 桌面版，或执行 "
                            "`opencode serve --service`。"
                        ),
                        "retryable": True,
                        "detail": type(error).__name__,
                    },
                )
            self._schedule_restart()
            return
        with suppress(Exception):
            await self.host.runtime_health_update("running")

    async def _attach(self) -> dict[str, Any]:
        service = self._service_reader()
        if service is None:
            raise OpenCodeServiceUnavailable("no OpenCode service registration found")
        client = self._client_factory(service)
        try:
            info = await client.verify()
        except BaseException:
            await client.aclose()
            raise
        old = self._client
        self._client = client
        if old is not None:
            await old.aclose()
        self._identity = RuntimeIdentity(
            RUNTIME, str(info.get("version") or "unknown"), "OpenCode", runtime_id=self._runtime_id
        )
        return info

    def _schedule_restart(self) -> None:
        if self._stopping or self._restart_task is not None:
            return

        async def loop() -> None:
            attempts = int(self.config.values.get("maxRestartAttempts") or 3)
            backoff = float(self.config.values.get("restartBackoffMs") or 1000) / 1000.0
            for _ in range(max(0, attempts)):
                await asyncio.sleep(max(0.2, backoff))
                if self._stopping:
                    return
                try:
                    await self._attach()
                except Exception:
                    continue
                with suppress(Exception):
                    await self.host.runtime_health_update("running")
                return

        self._restart_task = asyncio.create_task(loop())

    async def stop(self) -> None:
        self._stopping = True
        if self._restart_task is not None:
            self._restart_task.cancel()
            await asyncio.gather(self._restart_task, return_exceptions=True)
            self._restart_task = None
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def resynchronize(
        self, session_id: str | None = None, external_session_id: str | None = None
    ) -> None:
        await self._ensure_client()
        if session_id and external_session_id is None:
            external_session_id = self._external(session_id)
        if external_session_id:
            await self._snapshot(external_session_id)

    # ------------------------------------------------------------- capabilities

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        await self._ensure_client()
        directory = self.directory
        rows = [
            self._capability("session.list", supported=True, available=True),
            self._capability("session.getSnapshot", supported=True, available=True),
            self._capability("session.getState", supported=True, available=True),
            self._capability("session.getNotices", supported=True, available=True),
            self._capability("catalog.model", supported=True, available=True),
            self._capability("catalog.agent", supported=True, available=True),
            self._capability(
                "catalog.permission",
                supported=False,
                available=False,
                reason="the host exposes no permission catalog over HTTP",
            ),
            self._capability("session.send_message", supported=True, available=True),
            self._capability("session.interrupt", supported=True, available=True),
            self._capability("session.commands", supported=True, available=True),
            self._capability("session.interaction.approval", supported=True, available=True),
            self._capability(
                "session.steer",
                supported=False,
                available=False,
                reason="the host exposes no steer endpoint",
            ),
            self._capability(
                "runtime.attachment",
                supported=False,
                available=False,
                reason="attachment upload is not implemented on this transport yet",
            ),
            # rev3 ruling 2: discovery state rides this row's metadata. The host
            # service answers `GET /api/session` with a paginated inventory, so
            # unlike the in-process event stream this really can be complete --
            # but only when a location is bound (otherwise we would over-report).
            RuntimeCapability(
                capability_id="session.discovery",
                scope="runtime",
                runtime=RUNTIME,
                runtime_id=self._runtime_id,
                connector_id=self.host.connector_id,
                supported=True,
                available=bool(directory),
                allowed=True,
                unavailable_reason=None if directory else "no location configured for this instance",
                metadata={"discoveryState": "complete" if directory else "partial"},
            ),
        ]
        self._catalog_revision += 1
        return RuntimeCapabilitySet(
            runtime=RUNTIME,
            revision=self._catalog_revision,
            capabilities=tuple(rows),
            connector_id=self.host.connector_id,
            runtime_id=self._runtime_id,
            metadata={"transport": "service-http", "serviceVersion": self._identity.runtime_version},
        )

    def _capability(
        self, capability_id: str, *, supported: bool, available: bool, reason: str | None = None
    ) -> RuntimeCapability:
        return RuntimeCapability(
            capability_id=capability_id,
            scope="runtime",
            runtime=RUNTIME,
            runtime_id=self._runtime_id,
            connector_id=self.host.connector_id,
            supported=supported,
            available=available,
            allowed=supported and available,
            unavailable_reason=reason,
        )

    # ---------------------------------------------------------------- catalogs

    async def list_model_catalog(self, query: str | None = None, limit: int = 100) -> RuntimeModelCatalog:
        client = await self._ensure_client()
        rows = await client.get("/api/model", self._location_params())
        items = [row for row in rows if isinstance(row, Mapping)]
        if query:
            needle = query.lower()
            items = [
                row
                for row in items
                if needle in str(row.get("id", "")).lower() or needle in str(row.get("name", "")).lower()
            ]
        self._catalog_revision += 1
        return mappers.model_catalog(items[: max(1, limit)], revision=self._catalog_revision)

    async def list_permission_catalog(
        self, query: str | None = None, limit: int = 100
    ) -> RuntimePermissionCatalog:
        raise RuntimeUnsupportedError("the OpenCode host service exposes no permission catalog")

    async def list_agent_catalog(self) -> RuntimeAgentCatalog:
        client = await self._ensure_client()
        rows = await client.get("/api/agent", self._location_params())
        self._catalog_revision += 1
        return mappers.agent_catalog([row for row in rows if isinstance(row, Mapping)], revision=self._catalog_revision)

    # ---------------------------------------------------------------- sessions

    async def list_sessions(
        self, limit: int = 100, cursor: str | None = None, force: bool = False
    ) -> tuple[SessionMeta, ...]:
        inventory = await self._inventory(force=force)
        try:
            offset = int(cursor) if cursor else 0
        except ValueError as error:
            raise RuntimeInvalidRequestError("cursor must be an offset into the inventory") from error
        page = inventory[offset : offset + max(1, limit)]
        return tuple(page)

    async def list_complete_session_inventory(
        self, page_size: int = DEFAULT_PAGE_SIZE, force: bool = False
    ) -> tuple[SessionMeta, ...]:
        return await self._inventory(force=force)

    def supports_complete_session_inventory(self) -> bool:
        return bool(self.directory)

    async def get_session_snapshot(
        self, session_id: str, external_session_id: str | None = None, limit: int | None = None
    ) -> RuntimeTimelineSnapshot:
        external = await self._resolve_external(session_id, external_session_id)
        return await self._snapshot(external, limit=limit)

    async def get_session_state(
        self, session_id: str, external_session_id: str | None = None
    ) -> SessionState | None:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        row = await client.get(f"/api/session/{external}")
        if not isinstance(row, Mapping):
            return None
        active = await client.get("/api/session/active")
        active_ids = {str(item.get("id")) for item in _rows(active) if isinstance(item, Mapping)}
        status = "running" if external in active_ids else "idle"
        return SessionState(
            session_id=session_id,
            external_session_id=external,
            runtime=RUNTIME,
            status=status,  # type: ignore[arg-type]
            selections=_selections(row),
            metadata={"outcome": row.get("outcome"), "agent": row.get("agent")} if row.get("outcome") else {},
        )

    async def get_session_notices(
        self, session_id: str, external_session_id: str | None = None
    ) -> tuple[SessionNotice, ...]:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        rows = await client.get(f"/api/session/{external}/permission")
        notices: list[SessionNotice] = []
        for row in _rows(rows):
            if not isinstance(row, Mapping):
                continue
            request_id = row.get("id")
            action = row.get("action")
            if not isinstance(request_id, str):
                continue
            resources = [str(item) for item in row.get("resources") or [] if isinstance(item, str)]
            notices.append(
                SessionNotice(
                    notice_id=request_id,
                    session_id=session_id,
                    runtime=RUNTIME,
                    type="interaction",
                    title=f"OpenCode 请求执行 {action}" if isinstance(action, str) else "OpenCode 请求权限",
                    message=" · ".join(resources[:4]) or None,
                    severity="warning",
                    status="open",
                    interaction_type="permission",
                    response_required=True,
                    actions=tuple(remote_actions(action)),
                    source={"runtime": RUNTIME, "event": "permission.asked", "itemId": request_id},
                    context={"action": action, "resources": resources},
                    metadata={"requiresLocalConfirmation": requires_local_confirmation(action)},
                )
            )
        return tuple(notices)

    async def get_session_capabilities(
        self, session_id: str, external_session_id: str | None = None
    ) -> RuntimeCapabilitySet:
        base = await self.get_runtime_capabilities()
        external = self._external_by_session.get(session_id) or external_session_id
        return RuntimeCapabilitySet(
            runtime=RUNTIME,
            revision=base.revision,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=row.capability_id,
                    scope="session",
                    runtime=RUNTIME,
                    version=row.version,
                    session_id=session_id,
                    connector_id=row.connector_id,
                    supported=row.supported,
                    available=row.available,
                    allowed=row.allowed,
                    unavailable_reason=row.unavailable_reason,
                    metadata=row.metadata,
                    runtime_id=row.runtime_id,
                )
                for row in base.capabilities
            ),
            session_id=session_id,
            connector_id=base.connector_id,
            runtime_id=base.runtime_id,
            metadata={**dict(base.metadata), "externalSessionId": external},
        )

    # -------------------------------------------------------------- commands

    async def list_commands(
        self, session_id: str, external_session_id: str | None = None, query: str | None = None, limit: int = 50
    ) -> tuple[RuntimeCommand, ...]:
        return await self.list_runtime_commands(limit=limit)

    async def list_runtime_commands(self, limit: int = 100) -> tuple[RuntimeCommand, ...]:
        client = await self._ensure_client()
        rows = _rows(await client.get("/api/command", self._location_params()))
        commands: list[RuntimeCommand] = []
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            name = row.get("name") or row.get("id")
            if not isinstance(name, str):
                continue
            commands.append(
                RuntimeCommand(
                    id=name,
                    title=str(row.get("title") or name),
                    description=row.get("description") if isinstance(row.get("description"), str) else None,
                    scope="session",
                    accepts_args=True,
                    metadata={"source": row.get("source")} if row.get("source") else {},
                )
            )
        return tuple(commands[: max(1, limit)])

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        body: dict[str, Any] = {"command": command}
        if raw is not None:
            body["arguments"] = raw
        elif args:
            body["arguments"] = " ".join(args)
        payload = await client.post(f"/api/session/{external}/command", body)
        return RuntimeCommandResult(
            command=command,
            ok=True,
            code="executed",
            result=payload if isinstance(payload, Mapping) else {"result": payload},
        )

    # ----------------------------------------------------------------- writes

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[Any, ...] = (),
        client_message_id: str | None = None,
        runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        if attachments:
            return RuntimeOperationResult(ok=False, code="unsupported", message="attachments are not supported yet")
        client = await self._ensure_client()
        body: dict[str, Any] = {"title": title or (content[:40] or "Agents Anywhere")}
        # `parentID` is accepted by the host and silently dropped, so it is never
        # sent: pretending a child session exists would mislead the UI.
        created = await client.post("/api/session", body)
        rows = _rows(created)
        external = (rows[0].get("id") if rows and isinstance(rows[0], Mapping) else created.get("id") if isinstance(created, Mapping) else None)
        if not isinstance(external, str):
            raise RuntimeUpstreamError("the host did not return the created session id")
        platform_id = mappers.platform_session_id(self.host.session_namespace, external)
        self._external_by_session[platform_id] = external
        await self._apply_selections(client, external, selections)
        turn = await self._prompt(client, external, content, client_message_id)
        return RuntimeOperationResult(
            ok=True,
            code="created",
            result={**turn.result, "sessionId": platform_id, "externalSessionId": external},
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[Any, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        if attachments:
            return RuntimeOperationResult(ok=False, code="unsupported", message="attachments are not supported yet")
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        await self._apply_selections(client, external, selections)
        return await self._prompt(client, external, content, client_message_id)

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[Any, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("the OpenCode host service exposes no steer operation")

    async def interrupt_session(self, session_id: str, reason: str | None = None) -> RuntimeOperationResult:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, None)
        await client.post(f"/api/session/{external}/interrupt", {})
        return RuntimeOperationResult(ok=True, code="interrupted", result={"externalSessionId": external})

    async def update_session_selections(
        self, session_id: str, external_session_id: str | None, selections: Mapping[str, str | None]
    ) -> RuntimeOperationResult:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        applied = await self._apply_selections(client, external, selections)
        return RuntimeOperationResult(ok=True, code="updated", result={"applied": applied})

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        if action_id == PERSISTENT_ACTION:
            return _refuse(notice_id, "the persistent answer is never accepted remotely")
        if action_id not in (REMOTE_ALLOW_ACTION, REMOTE_DENY_ACTION):
            return _refuse(notice_id, f"unsupported action: {action_id}")
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, None)
        notices = await self.get_session_notices(session_id, external)
        notice = next((item for item in notices if item.notice_id == notice_id), None)
        if notice is None:
            return _refuse(notice_id, "unknown or already-answered permission request")
        if not any(item.get("actionId") == action_id for item in notice.actions):
            return _refuse(notice_id, "this action needs confirmation inside OpenCode")
        decision = "once" if action_id == REMOTE_ALLOW_ACTION else "reject"
        await client.post(f"/api/session/{external}/permission/{notice_id}/reply", {"decision": decision})
        return RuntimeOperationResult(ok=True, code="answered", result={"decision": decision})

    # ------------------------------------------------------------------ helpers

    async def _ensure_client(self) -> OpenCodeServerClient:
        if self._client is None:
            await self._attach()
        client = self._client
        if client is None:
            raise OpenCodeServiceUnavailable("not attached to an OpenCode service")
        return client

    def _location_params(self) -> dict[str, str]:
        directory = self.directory
        return {"directory": directory} if directory else {}

    async def _inventory(self, *, force: bool = False) -> tuple[SessionMeta, ...]:
        client = await self._ensure_client()
        rows = await client.list_sessions(limit=DEFAULT_PAGE_SIZE, **self._location_params())
        namespace = self.host.session_namespace
        output: list[SessionMeta] = []
        seen: set[str] = set()
        for row in rows:
            meta = mappers.session_meta(row, namespace=namespace)
            if meta.session_id in seen:
                raise RuntimeUpstreamError("OpenCode inventory repeated a session")
            seen.add(meta.session_id)
            self._external_by_session[meta.session_id] = str(meta.external_session_id)
            output.append(meta)
        return tuple(output)

    async def _snapshot(self, external: str, limit: int | None = None) -> RuntimeTimelineSnapshot:
        client = await self._ensure_client()
        params: dict[str, str] = {}
        if limit:
            params["limit"] = str(limit)
        rows = _rows(await client.get(f"/api/session/{external}/message", params))
        session_id = mappers.platform_session_id(self.host.session_namespace, external)
        self._external_by_session[session_id] = external
        items = project_messages(rows, session_id=session_id)
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external,
            runtime=RUNTIME,
            items=items,
            complete=not bool(limit),
            metadata={"source": "service-http", "messages": len(rows)},
        )

    def _external(self, session_id: str) -> str | None:
        return self._external_by_session.get(session_id)

    async def _resolve_external(self, session_id: str, external: str | None) -> str:
        if external:
            self._external_by_session.setdefault(session_id, external)
            return external
        known = self._external(session_id)
        if known:
            return known
        await self._inventory()
        known = self._external(session_id)
        if known:
            return known
        raise RuntimeUpstreamError(f"session {session_id} is not present in the OpenCode service")

    async def _apply_selections(
        self, client: OpenCodeServerClient, external: str, selections: Mapping[str, str | None] | None
    ) -> list[str]:
        applied: list[str] = []
        if not selections:
            return applied
        model = selections.get("model")
        if isinstance(model, str) and model:
            provider_id, slash, model_id = model.partition("/")
            if not slash or not model_id:
                # `Model.Ref` requires both halves; a bare id would be a guess
                # about which provider the user meant.
                raise RuntimeInvalidRequestError(
                    f"model selection {model!r} must be 'providerID/modelID'"
                )
            await client.post(f"/api/session/{external}/model", {"model": {"id": model_id, "providerID": provider_id}})
            applied.append("model")
        agent = selections.get("agent")
        if isinstance(agent, str) and agent:
            await client.post(f"/api/session/{external}/agent", {"agent": agent})
            applied.append("agent")
        return applied

    async def _prompt(
        self, client: OpenCodeServerClient, external: str, content: str, client_message_id: str | None
    ) -> RuntimeOperationResult:
        body: dict[str, Any] = {"text": content}
        if client_message_id:
            body["id"] = client_message_id
        payload = await client.post(f"/api/session/{external}/prompt", body)
        return RuntimeOperationResult(
            ok=True,
            code="queued",
            result={"externalSessionId": external, "accepted": isinstance(payload, Mapping)},
        )


def _rows(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, Mapping):
        for key in ("data", "items", "commands", "models", "agents"):
            if isinstance(payload.get(key), list):
                return list(payload[key])
    return []


def _selections(row: Mapping[str, Any]) -> dict[str, str | None]:
    selections: dict[str, str | None] = {}
    agent = row.get("agent")
    if isinstance(agent, str):
        selections["agent"] = agent
    model = row.get("model")
    if isinstance(model, Mapping):
        model_id = model.get("id")
        provider_id = model.get("providerID")
        if isinstance(model_id, str):
            selections["model"] = f"{provider_id}/{model_id}" if isinstance(provider_id, str) else model_id
    return selections


def _refuse(notice_id: str, message: str) -> RuntimeOperationResult:
    logger.warning("OpenCode approval refused", {"noticeId": notice_id, "reason": message})
    return RuntimeOperationResult(ok=False, code="unsupported", message=message, result={"noticeId": notice_id})
