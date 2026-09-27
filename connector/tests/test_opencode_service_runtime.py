"""Tests for the OpenCode service-HTTP runtime.

A `httpx.MockTransport` stands in for the host service, so these exercise the
real client + real decoding against recorded 2.0.18 response shapes rather than
against a stubbed client. The approval tests are the security-critical ones:
`always` never leaves this process, and an action outside the read-only
allowlist must not be answerable remotely at all.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from connector.runtimes.opencode.serve.client import OpenCodeServerClient
from connector.runtimes.opencode.serve.runtime import (
    OpenCodeServiceRuntime,
    remote_actions,
    requires_local_confirmation,
)
from connector.runtimes.opencode.serve.service import OpenCodeService
from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError, RuntimeUnsupportedError
from connector.runtimes.opencode.serve import mappers

SERVICE = OpenCodeService(
    url="http://127.0.0.1:49374", pid=18772, version="2.0.18", password="pw", path=__import__("pathlib").Path("s.json")
)
# Opaque paths: the runtime only forwards/echoes them, so nothing here may
# depend on a directory that exists on the machine running the tests.
DIRECTORY = "/work/repo"
EXTERNAL = "ses_f22107110ffdwOAm3Bcv9JiTBV"
# Agents Anywhere addresses a session by the id derived from the inventory, exactly
# as the production caller does after list_sessions().
MAIN_PLATFORM = mappers.platform_session_id("ns_test", EXTERNAL)


def envelope(rows: Any, cursor: Any = None) -> httpx.Response:
    return httpx.Response(200, json={"data": rows, "cursor": cursor or {"previous": None, "next": None}})


SESSION_ROWS = [
    {"id": EXTERNAL, "title": "主会话", "location": {"directory": DIRECTORY}, "time": {"updated": 10}},
    {
        "id": "ses_child",
        "parentID": EXTERNAL,
        "title": "子会话",
        "agent": "general",
        "location": {"directory": DIRECTORY},
        "time": {"updated": 20},
    },
]

MESSAGES = [
    {"id": "msg_u", "type": "user", "text": "做点什么"},
    {
        "id": "msg_a",
        "type": "assistant",
        "content": [{"type": "text", "text": "好的"}, {"type": "tool", "id": "t1", "name": "read", "state": {"status": "completed"}}],
    },
    {"id": "msg_i", "type": "idle", "outcome": "ok"},
]


class Recorder:
    def __init__(self) -> None:
        self.health: list[tuple[str, Any]] = []
        self.requests: list[tuple[str, str, Any]] = []
        self.query: list[tuple[str, str, tuple[tuple[str, str], ...]]] = []

    async def runtime_health_update(self, status: str, detail: Any = None) -> None:
        self.health.append((status, detail))

    async def runtime_capabilities_update(self, *args: Any, **kwargs: Any) -> None:
        return None


def build(routes: dict[tuple[str, str], Any], values: dict[str, Any] | None = None) -> tuple[OpenCodeServiceRuntime, Recorder]:
    host = Recorder()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode()) if request.content else None
        key = (request.method, request.url.path)
        host.requests.append((request.method, request.url.path, body))
        host.query.append((request.method, request.url.path, tuple(sorted(request.url.params.items()))))
        outcome = routes.get(key, httpx.Response(404, json={"_tag": "NotFound"}))
        return outcome if isinstance(outcome, httpx.Response) else envelope(outcome)

    runtime = OpenCodeServiceRuntime(
        RuntimeConfig(RUNTIME_NAME, 1, values={"location": DIRECTORY, **(values or {})}),
        SimpleNamespace(connector_id="conn_test", session_namespace="ns_test", **{k: getattr(host, k) for k in ("runtime_health_update", "runtime_capabilities_update")}),
        service_reader=lambda: SERVICE,
        client_factory=lambda service: OpenCodeServerClient(service, transport=httpx.MockTransport(handler)),
    )
    return runtime, host


RUNTIME_NAME = "opencode"

BASE_ROUTES: dict[tuple[str, str], Any] = {
    ("GET", "/api/info"): httpx.Response(200, json={"version": "2.0.18", "pid": 18772, "urls": [], "paths": {"tmp": "T"}}),
    ("GET", "/api/debug/location"): [{"directory": DIRECTORY}],
    ("GET", "/api/session"): SESSION_ROWS,
    ("GET", "/api/session/active"): [],
    ("GET", f"/api/session/{EXTERNAL}/message"): MESSAGES,
    ("GET", f"/api/session/{EXTERNAL}"): httpx.Response(200, json={"data": {"id": EXTERNAL}}),
    ("GET", "/api/session/ses_child/message"): MESSAGES,
}


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


# ------------------------------------------------------------------- lifecycle


def test_start_reports_running_once_attached() -> None:
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()

    run(scenario())
    assert host.health[0][0] == "starting"
    assert host.health[-1] == ("running", None)
    assert runtime.identity.runtime_version == "2.0.18"


def test_missing_registration_is_actionable_not_a_crash() -> None:
    host = Recorder()
    runtime = OpenCodeServiceRuntime(
        RuntimeConfig(RUNTIME_NAME, 1, values={"location": DIRECTORY, "maxRestartAttempts": 0}),
        SimpleNamespace(connector_id="c", session_namespace="ns", **{k: getattr(host, k) for k in ("runtime_health_update", "runtime_capabilities_update")}),
        service_reader=lambda: None,
    )

    async def scenario() -> None:
        await runtime.start()

    run(scenario())
    _status, detail = host.health[-1]
    assert detail["code"] == "runtime_unavailable"
    assert "opencode serve" in detail["message"], "the message must name what the user can actually run"


def test_a_location_the_service_never_loaded_is_named_not_shown_as_empty() -> None:
    # `/api/session?directory=` answers `[]` for a location the host has not
    # loaded, so "no sessions" and "wrong path typed" are the same symptom at
    # that layer. Resolving against /api/debug/location keeps them distinct.
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/debug/location")] = [{"directory": "/other/place"}]
    runtime, host = build(routes, values={"maxRestartAttempts": 0})

    async def scenario() -> None:
        await runtime.start()

    run(scenario())
    _status, detail = host.health[-1]
    assert detail["code"] == "location_not_loaded"
    assert DIRECTORY in detail["message"]
    assert "/other/place" not in detail["message"], "the ask is the user's own path, not a dump of the host's"


def test_scoped_queries_use_the_hosts_own_spelling_of_the_location() -> None:
    # The host compares `?directory=` case-sensitively, so what goes out must be
    # the string the host itself reports, not what was typed into the config.
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/debug/location")] = [{"directory": "D:\\Work\\Repo"}]
    routes[("GET", "/api/session")] = [
        {"id": EXTERNAL, "location": {"directory": "D:\\Work\\Repo"}, "time": {"updated": 10}}
    ]
    runtime, host = build(routes, values={"location": "d:/work/repo"})

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.list_complete_session_inventory()

    assert [row.external_session_id for row in run(scenario())] == [EXTERNAL]
    scoped = [call for call in host.query if call[1] in ("/api/session", "/api/model", "/api/agent", "/api/command")]
    assert scoped, "the runtime must scope its location-bound queries"
    for _method, _path, params in scoped:
        assert ("directory", "D:\\Work\\Repo") in params, params


# ------------------------------------------------------------------- inventory


def test_inventory_rows_from_another_location_are_not_attributed_here() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/session")] = SESSION_ROWS + [
        {"id": "ses_foreign", "location": {"directory": "/somewhere/else"}, "time": {"updated": 30}}
    ]
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.list_complete_session_inventory()

    assert [row.external_session_id for row in run(scenario())] == [EXTERNAL, "ses_child"]


def test_inventory_maps_sessions_and_keeps_the_parent_link() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.list_complete_session_inventory()

    rows = run(scenario())
    assert [row.external_session_id for row in rows] == [EXTERNAL, "ses_child"]
    assert rows[1].metadata["parentID"] == EXTERNAL
    assert rows[0].session_id.startswith("sess_opencode_")
    assert runtime.supports_complete_session_inventory() is True


def test_list_sessions_pages_by_offset_over_the_inventory() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        first = await runtime.list_sessions(limit=1)
        second = await runtime.list_sessions(limit=1, cursor=str(len(first)))
        return first, second

    first, second = run(scenario())
    assert [row.external_session_id for row in first] == [EXTERNAL]
    assert [row.external_session_id for row in second] == ["ses_child"]


def test_a_bad_cursor_is_rejected_not_guessed() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await runtime.list_sessions(cursor="not-a-number")

    with pytest.raises(RuntimeInvalidRequestError):
        run(scenario())


def test_discovery_state_is_partial_without_a_location() -> None:
    routes = dict(BASE_ROUTES)
    runtime, _ = build(routes, values={"location": None})
    runtime.config = RuntimeConfig(RUNTIME_NAME, 1, values={})

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_runtime_capabilities()

    caps = run(scenario())
    discovery = next(row for row in caps.capabilities if row.capability_id == "session.discovery")
    assert discovery.available is False
    assert runtime.supports_complete_session_inventory() is False


# ------------------------------------------------------------------- timeline


def test_snapshot_projects_stored_messages_and_is_complete() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_snapshot("unused", external_session_id=EXTERNAL)

    snapshot = run(scenario())
    assert snapshot.external_session_id == EXTERNAL
    assert snapshot.complete is True
    assert [item.type for item in snapshot.items] == ["turn.start", "message", "message", "tool", "turn.end"]


def test_snapshot_with_a_limit_is_not_marked_complete() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_snapshot("unused", external_session_id=EXTERNAL, limit=2)

    assert run(scenario()).complete is False


def test_session_id_is_resolved_through_the_inventory() -> None:
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        rows = await runtime.list_complete_session_inventory()
        return await runtime.get_session_snapshot(rows[1].session_id)

    snapshot = run(scenario())
    assert snapshot.external_session_id == "ses_child"
    assert ("GET", "/api/session/ses_child/message", None) in host.requests


# ------------------------------------------------------------------- state


def test_state_follows_the_active_endpoint() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/session/active")] = [{"id": EXTERNAL}]
    routes[("GET", f"/api/session/{EXTERNAL}")] = httpx.Response(
        200, json={"data": {"id": EXTERNAL, "agent": "team", "model": {"id": "glm", "providerID": "lxns"}}}
    )
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_state("any", external_session_id=EXTERNAL)

    state = run(scenario())
    assert state.status == "running"
    assert state.selections == {"agent": "team", "model": "lxns/glm"}


# ------------------------------------------------------------------ approvals


def test_read_only_actions_are_the_only_remote_answerable_ones() -> None:
    assert requires_local_confirmation("read") is False
    for action in ("write", "bash", "edit_file", "", None, "APPLY_PATCH"):
        assert requires_local_confirmation(action) is True, action
    assert [item["actionId"] for item in remote_actions("grep")] == ["allow_once", "deny"]
    assert remote_actions("write") == []


def _permission_routes(rows: list[dict[str, Any]]) -> dict[tuple[str, str], Any]:
    routes = dict(BASE_ROUTES)
    routes[("GET", f"/api/session/{EXTERNAL}/permission")] = rows
    return routes


def test_permission_notice_exposes_actions_and_context() -> None:
    runtime, _ = build(_permission_routes([{"id": "per_1", "action": "read", "resources": ["/work/repo/src/a.ts"]}]))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_notices("any", external_session_id=EXTERNAL)

    notices = run(scenario())
    assert len(notices) == 1
    assert notices[0].notice_id == "per_1"
    assert [item["actionId"] for item in notices[0].actions] == ["allow_once", "deny"]
    assert notices[0].context["resources"] == ["/work/repo/src/a.ts"]


def test_high_risk_notice_cannot_be_answered_remotely() -> None:
    runtime, host = build(_permission_routes([{"id": "per_2", "action": "write", "resources": ["/work/repo/x"]}]))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.respond_interaction(MAIN_PLATFORM, "per_2", "allow_once")

    result = run(scenario())
    assert result.ok is False
    assert not [call for call in host.requests if call[0] == "POST"], "no reply may reach the host"


def test_always_is_refused_locally_even_for_a_read_action() -> None:
    runtime, host = build(_permission_routes([{"id": "per_3", "action": "read", "resources": []}]))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.respond_interaction("any", "per_3", "always")

    result = run(scenario())
    assert result.ok is False
    assert not [call for call in host.requests if call[0] == "POST"]


def test_allow_once_posts_the_once_decision_to_the_host() -> None:
    routes = _permission_routes([{"id": "per_4", "action": "read", "resources": []}])
    routes[("POST", f"/api/session/{EXTERNAL}/permission/per_4/reply")] = httpx.Response(200, json={})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.respond_interaction(MAIN_PLATFORM, "per_4", "allow_once")

    result = run(scenario())
    assert result.ok is True
    posted = [call for call in host.requests if call[0] == "POST" and call[1].endswith("/reply")]
    assert posted == [("POST", f"/api/session/{EXTERNAL}/permission/per_4/reply", {"decision": "once"})]


def test_answering_a_request_that_is_no_longer_pending_is_refused() -> None:
    runtime, _ = build(_permission_routes([]))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.respond_interaction(MAIN_PLATFORM, "per_gone", "deny")

    assert run(scenario()).ok is False


# --------------------------------------------------------------------- writes


def test_start_turn_posts_the_prompt_text() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", f"/api/session/{EXTERNAL}/prompt")] = httpx.Response(200, json={"data": {"id": "msg_new"}})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.start_turn("any", EXTERNAL, "继续", client_message_id="msg_client")

    result = run(scenario())
    assert result.ok is True
    assert ("POST", f"/api/session/{EXTERNAL}/prompt", {"text": "继续", "id": "msg_client"}) in host.requests


def test_steer_is_unsupported_on_this_transport() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await runtime.steer_turn("any", EXTERNAL, "改一下")

    with pytest.raises(RuntimeUnsupportedError):
        run(scenario())


def test_create_session_applies_selections_then_prompts() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", "/api/session")] = httpx.Response(200, json={"data": {"id": "ses_new"}})
    routes[("POST", "/api/session/ses_new/model")] = httpx.Response(200, json={})
    routes[("POST", "/api/session/ses_new/prompt")] = httpx.Response(200, json={"data": {}})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.create_and_start_session("any", "开工", selections={"model": "lxns-uni/glm-5.3"})

    result = run(scenario())
    assert result.result["externalSessionId"] == "ses_new"
    assert result.result["sessionId"].startswith("sess_opencode_")
    model_call = next(call for call in host.requests if call[1].endswith("/model"))
    assert model_call[2] == {"model": {"id": "glm-5.3", "providerID": "lxns-uni"}}
    assert any(call[1].endswith("/prompt") for call in host.requests)


def test_a_bare_model_selection_is_rejected_not_guessed() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", "/api/session")] = httpx.Response(200, json={"data": {"id": "ses_new2"}})
    runtime, _ = build(routes)

    async def scenario() -> None:
        await runtime.start()
        await runtime.create_and_start_session("any", "开工", selections={"model": "glm-5.3"})

    with pytest.raises(RuntimeInvalidRequestError):
        run(scenario())


def test_interrupt_posts_to_the_host() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", f"/api/session/{EXTERNAL}/interrupt")] = httpx.Response(200, json={})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        rows = await runtime.list_complete_session_inventory()
        return await runtime.interrupt_session(rows[0].session_id)

    run(scenario())
    assert ("POST", f"/api/session/{EXTERNAL}/interrupt", {}) in host.requests


# ------------------------------------------------------------------- catalogs


def test_model_catalog_is_keyed_by_provider_and_model() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/model")] = [
        {"id": "longcat", "providerID": "a", "name": "LongCat A"},
        {"id": "longcat", "providerID": "b", "name": "LongCat B"},
    ]
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.list_model_catalog()

    catalog = run(scenario())
    assert [item.id for item in catalog.models] == ["a/longcat", "b/longcat"]


def test_permission_catalog_is_declared_unsupported() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await runtime.list_permission_catalog()

    with pytest.raises(RuntimeUnsupportedError):
        run(scenario())


def test_capabilities_report_the_attached_service_version() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_runtime_capabilities()

    caps = run(scenario())
    assert caps.metadata["transport"] == "service-http"
    assert caps.metadata["serviceVersion"] == "2.0.18"
    steer = next(row for row in caps.capabilities if row.capability_id == "session.steer")
    assert steer.supported is False
