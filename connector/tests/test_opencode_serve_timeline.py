"""Tests for projecting the host service's stored messages into timeline items.

The fixtures are the shapes measured from the live 2.0.18 service
(`docs/opencode-server-surface.md` §4.1): `user` carries `text`; `assistant`
carries `content[]` with `text` / `reasoning` / `tool` parts, the tool part
holding `{id, name, executed, state:{status, input}}`; `idle` carries `outcome`.
"""

from __future__ import annotations

from typing import Any

from connector.runtime_protocol.timeline import timeline_content_hash
from connector.runtimes.opencode.serve.timeline import project_messages, timeline_item_id

SESSION = "ses_probe"


def sample() -> list[dict[str, Any]]:
    return [
        {"id": "msg_u1", "type": "user", "text": "继续", "time": {"created": 1}},
        {
            "id": "msg_a1",
            "type": "assistant",
            "agent": "team",
            "model": {"id": "glm-5.3", "providerID": "lxns-uni", "variant": "max"},
            "time": {"created": 2},
            "content": [
                {"type": "reasoning", "text": "先看目录", "time": {"created": 2}},
                {"type": "text", "text": "**根因确认**"},
                {
                    "type": "tool",
                    "id": "chatcmpl-tool-943078",
                    "name": "shell",
                    "executed": False,
                    "state": {"status": "completed", "input": {"command": "ls"}},
                    "time": {"created": 3},
                },
            ],
        },
        {"id": "msg_i1", "type": "idle", "outcome": "interrupted", "time": {"created": 4}},
    ]


def types_and_roles(items: object) -> list[tuple[str, str | None]]:
    return [(item.type, item.role) for item in items]  # type: ignore[attr-defined]


def test_projects_a_turn_in_stored_order() -> None:
    items = project_messages(sample(), session_id=SESSION)
    assert types_and_roles(items) == [
        ("turn.start", "user"),
        ("message", "user"),
        ("message", "assistant"),
        ("message", "assistant"),
        ("tool", "tool"),
        ("turn.end", None),
    ]
    assert [item.order_seq for item in items] == [1, 2, 3, 4, 5, 6]
    assert items[2].content["text"] == "先看目录"
    assert items[2].metadata["reasoning"] is True
    assert items[3].content["text"] == "**根因确认**"
    assert "reasoning" not in items[3].metadata


def test_tool_item_keeps_the_native_identity_and_io() -> None:
    items = project_messages(sample(), session_id=SESSION)
    tool = items[4]
    assert tool.content["kind"] == "tool_call"
    assert tool.content["title"] == "shell"
    assert tool.content["input"] == {"command": "ls"}
    assert tool.status == "done"
    assert tool.metadata["nativeToolId"] == "chatcmpl-tool-943078"
    assert tool.metadata["messageId"] == "msg_a1"
    assert tool.metadata["executed"] is False
    assert tool.source["itemId"] == "chatcmpl-tool-943078"


def test_turn_linkage_and_idle_outcome() -> None:
    items = project_messages(sample(), session_id=SESSION)
    start, end = items[0], items[-1]
    assert start.type == "turn.start" and end.type == "turn.end"
    # Everything inside the turn points back at the opening marker.
    for item in items[1:-1]:
        assert item.turn_id == start.id
    assert end.turn_id == start.id
    assert end.status == "interrupted", "the stored idle outcome must survive, not be flattened to done"
    assert end.metadata["outcome"] == "interrupted"


def test_a_clean_turn_ends_done() -> None:
    rows = sample()
    rows[-1] = {"id": "msg_i2", "type": "idle", "outcome": "completed"}
    items = project_messages(rows, session_id=SESSION)
    assert items[-1].status == "done"


def test_content_hash_is_the_canonical_one_the_decoder_recomputes() -> None:
    for item in project_messages(sample(), session_id=SESSION):
        assert item.content_hash == timeline_content_hash(item.type, item.status, item.role, item.content)


def test_ids_are_stable_across_projections() -> None:
    first = project_messages(sample(), session_id=SESSION)
    second = project_messages(sample(), session_id=SESSION)
    assert [item.id for item in first] == [item.id for item in second]
    assert first[1].id == timeline_item_id("user:msg_u1")


def test_model_switched_is_not_invented_into_the_timeline() -> None:
    rows = sample() + [
        {"id": "msg_m1", "type": "model-switched", "model": {"id": "x"}, "previous": {"id": "y"}, "time": {"created": 5}}
    ]
    items = project_messages(rows, session_id=SESSION)
    assert len(items) == 6, "an unmapped message type is skipped until its AA kind is decided"


def test_garbage_rows_are_skipped_without_breaking_the_stream() -> None:
    rows = ["nope", {"type": "user"}, sample()[1], {"id": "msg_x", "type": "assistant", "content": "not-a-list"}]
    items = project_messages(rows, session_id=SESSION)
    # The assistant message yields reasoning + text + tool; the id-less user row
    # and the string-content assistant are dropped.
    assert [item.type for item in items] == ["message", "message", "tool"]
