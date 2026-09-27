"""OpenCode agent directory (D3) — Hub contract decoding and host wiring.

No real Connector or OpenCode process is started: the decoder, the sync
notification handler and `OpenCodeRuntime.list_agent_catalog()` are exercised
against in-process fakes, matching the rest of `test_opencode_*`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeHostClient,
    RuntimeIdentity,
    RuntimeInstanceHost,
    RuntimeInstanceSpec,
    RuntimeUnsupportedError,
)
from connector.runtimes.opencode.bridge.client import BridgeRpcError
from connector.runtimes.opencode.bridge.models import (
    RuntimeAgentCatalog,
    RuntimeAgentItem,
    agent_catalog,
)
from connector.runtimes.opencode.bridge.sync import SyncRelay
from connector.runtimes.opencode.runtime import OpenCodeRuntime
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_rpc import RuntimeRpcHandler


def test_agent_catalog_decodes_the_hub_contract() -> None:
    catalog = agent_catalog(
        {
            "agents": [
                {"id": "build", "name": "Build", "description": "默认构建代理", "mode": "primary", "hidden": False},
                {"id": "general", "mode": "subagent", "hidden": False},
                # Unknown mode → "all" (switchable), never dropped.
                {"id": "weird", "mode": "made-up", "hidden": False},
            ]
        }
    )
    assert isinstance(catalog, RuntimeAgentCatalog)
    # The Hub sends no envelope; defaults mirror ProtocolAgentCatalog.
    assert catalog.runtime == "opencode"
    assert catalog.revision == 1
    assert catalog.agents == (
        RuntimeAgentItem(id="build", name="Build", description="默认构建代理", mode="primary", hidden=False),
        RuntimeAgentItem(id="general", mode="subagent", hidden=False),
        RuntimeAgentItem(id="weird", mode="all", hidden=False),
    )


def test_agent_catalog_passes_hidden_through_and_requires_ids() -> None:
    catalog = agent_catalog({"agents": [{"id": "compaction", "mode": "primary", "hidden": True}]})
    # `hidden` is passed through verbatim: filtering is unverified, so the
    # Connector must not pretend the Hub already removed it.
    assert catalog.agents[0].hidden is True
    with pytest.raises(ValueError):
        agent_catalog({"agents": [{"mode": "primary"}]})
    with pytest.raises(ValueError):
        agent_catalog({"agents": "not-an-array"})


class _SyncHost:
    def __init__(self, *, agent_catalog_update: bool) -> None:
        self.updates: list[RuntimeAgentCatalog] = []
        if agent_catalog_update:

            async def update(catalog: RuntimeAgentCatalog) -> None:
                self.updates.append(catalog)

            self.agent_catalog_update = update  # type: ignore[attr-defined]


def test_sync_routes_catalog_agent_update_to_the_host() -> None:
    async def run() -> None:
        host = _SyncHost(agent_catalog_update=True)
        relay = SyncRelay(client=None, host=host)  # type: ignore[arg-type]
        await relay.publish_notification(
            {
                "method": "catalog.agent.update",
                "params": {"agents": [{"id": "plan", "mode": "primary", "hidden": False}]},
            }
        )
        assert len(host.updates) == 1
        assert host.updates[0].agents[0].id == "plan"

    asyncio.run(run())


def test_sync_ignores_catalog_agent_update_without_a_host_publisher() -> None:
    async def run() -> None:
        # No `agent_catalog_update` yet (the server side lands separately): the
        # update must be survived, not raised — and the decode still validates
        # the payload, so a malformed frame is still rejected.
        relay = SyncRelay(client=None, host=_SyncHost(agent_catalog_update=False))  # type: ignore[arg-type]
        await relay.publish_notification(
            {"method": "catalog.agent.update", "params": {"agents": []}}
        )

    asyncio.run(run())


class _FakeClient:
    def __init__(self, *, payload: Any = None, error: Exception | None = None) -> None:
        self.connected = True
        self.calls: list[tuple[str, Any]] = []
        self._payload = payload
        self._error = error

    async def request(self, method: str, params: Any = None) -> Any:
        self.calls.append((method, params))
        if self._error is not None:
            raise self._error
        return self._payload


class _RuntimeHost:
    connector_id = "connector-test"


def _runtime(client: _FakeClient) -> OpenCodeRuntime:
    runtime = OpenCodeRuntime(
        RuntimeConfig(runtime="opencode", revision=1, runtime_id="opencode"),
        _RuntimeHost(),  # type: ignore[arg-type]
    )
    runtime._client = client  # type: ignore[assignment]
    return runtime


def test_list_agent_catalog_requests_the_literal_empty_params_contract() -> None:
    async def run() -> None:
        client = _FakeClient(payload={"agents": [{"id": "build", "mode": "primary", "hidden": False}]})
        catalog = await _runtime(client).list_agent_catalog()
        assert client.calls == [("catalog.listAgents", {})]
        assert catalog.agents[0].id == "build"

    asyncio.run(run())


def test_list_agent_catalog_maps_unsupported_to_runtime_unsupported() -> None:
    async def run() -> None:
        client = _FakeClient(
            error=BridgeRpcError(
                -32601,
                "the host exposes no agent catalog (ctx.agent.list/transform)",
                {"code": "UNSUPPORTED_OPERATION", "retryable": False},
            )
        )
        with pytest.raises(RuntimeUnsupportedError):
            await _runtime(client).list_agent_catalog()

    asyncio.run(run())


def test_connector_runtime_host_publishes_agent_catalog_as_agent_type() -> None:
    asyncio.run(_exercise_agent_catalog_notification())


async def _exercise_agent_catalog_notification() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        _ = session_id
        return b"data", f"{file_id}.txt", "text/plain"

    host = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
    )
    await host.agent_catalog_update(
        RuntimeAgentCatalog(
            runtime="opencode",
            revision=3,
            agents=(
                RuntimeAgentItem(id="build", name="Build", mode="primary", hidden=False),
                RuntimeAgentItem(id="compaction", mode="primary", hidden=True),
            ),
        )
    )

    assert notifications == [
        (
            "runtime.catalog.updated",
            {
                "runtime": "opencode",
                "runtimeId": "opencode",
                "catalogType": "agent",
                "catalog": {
                    "runtime": "opencode",
                    "revision": 3,
                    "agents": [
                        {
                            "id": "build",
                            "name": "Build",
                            "description": None,
                            "mode": "primary",
                            "hidden": False,
                        },
                        {
                            "id": "compaction",
                            "name": None,
                            "description": None,
                            "mode": "primary",
                            "hidden": True,
                        },
                    ],
                },
            },
        )
    ]


class _RecordingHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.catalogs: list[RuntimeAgentCatalog] = []

    @property
    def connector_id(self) -> str:
        return "conn_1"

    async def agent_catalog_update(self, catalog: RuntimeAgentCatalog) -> None:
        self.catalogs.append(catalog)


def test_instance_bound_host_stamps_runtime_and_instance_id() -> None:
    async def run() -> None:
        base = _RecordingHost()
        host = RuntimeInstanceHost(
            base,
            RuntimeInstanceSpec(
                runtime_id="rti_opencode_home_01",
                runtime_type="opencode",
                name="OpenCode",
            ),
        )
        await host.agent_catalog_update(
            RuntimeAgentCatalog(
                runtime="opencode",
                revision=1,
                agents=(RuntimeAgentItem(id="build", mode="primary"),),
            )
        )
        assert base.catalogs[0].runtime == "opencode"
        assert base.catalogs[0].runtime_id == "rti_opencode_home_01"

    asyncio.run(run())


class _CatalogRuntime(AgentRuntime):
    """Runtime exposing only the agent directory, keyed via its identity."""

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="opencode",
            runtime_version="test",
            runtime_id="opencode",
        )

    async def list_agent_catalog(self) -> RuntimeAgentCatalog:
        return RuntimeAgentCatalog(
            runtime="opencode",
            revision=2,
            agents=(
                RuntimeAgentItem(
                    id="build",
                    name="Build",
                    mode="primary",
                    hidden=False,
                ),
            ),
        )


class _NoAgentCatalogRuntime(AgentRuntime):
    """Stands in for codex/claude/dsh: no `list_agent_catalog` override."""

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="codex",
            runtime_version="test",
            runtime_id="codex",
        )


class _CatalogSupervisor:
    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    def resolve_runtime(
        self,
        runtime_id: str | None,
        runtime_type: str,
    ) -> AgentRuntime:
        _ = runtime_id, runtime_type
        return self._runtime


def _catalog_handler(runtime: AgentRuntime) -> RuntimeRpcHandler:
    return RuntimeRpcHandler(
        _CatalogSupervisor(runtime),  # type: ignore[arg-type]
        _RuntimeHost(),  # type: ignore[arg-type]
    )


def test_rpc_advertises_and_dispatches_agent_catalog() -> None:
    async def run() -> None:
        handler = _catalog_handler(_CatalogRuntime())
        assert handler.supports("runtime.agentCatalog")

        result = await handler.dispatch(
            "runtime.agentCatalog",
            {"runtime": "opencode", "runtimeId": "opencode", "limit": 200},
        )

        assert result["runtime"] == "opencode"
        assert result["runtimeId"] == "opencode"
        assert result["catalog"]["runtime"] == "opencode"
        assert result["catalog"]["revision"] == 2
        assert result["catalog"]["agents"] == [
            {
                "id": "build",
                "name": "Build",
                "description": None,
                "mode": "primary",
                "hidden": False,
            }
        ]

    asyncio.run(run())


def test_rpc_agent_catalog_without_a_runtime_method_reports_unsupported() -> None:
    async def run() -> None:
        # A runtime without `list_agent_catalog` (codex/claude/dsh) must surface
        # the runtime-level unsupported error — never AttributeError/500.
        handler = _catalog_handler(_NoAgentCatalogRuntime())

        with pytest.raises(RuntimeUnsupportedError) as excinfo:
            await handler.dispatch(
                "runtime.agentCatalog",
                {"runtime": "codex", "runtimeId": "codex", "limit": 200},
            )

        assert excinfo.value.method == "list_agent_catalog"
        assert excinfo.value.code == "runtime_unsupported"

    asyncio.run(run())
