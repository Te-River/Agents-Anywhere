"""Project the host service's stored messages into canonical timeline items.

The item shapes are the ones Agents Anywhere already renders -- content kinds
`markdown`, `tool_call`, `turn_start` / `turn_end`, and ids of the form
`itm_<sha256(native key)[:24]>` -- because that is what the plugin projector
emitted. Inventing a new `kind` here would render as nothing on the client, so
this module mirrors the existing vocabulary rather than designing a new one.

Turn structure comes from the stored data itself: a `user` message opens a turn
and the following `idle` message closes it, carrying the outcome
(`interrupted` / `cancelled` / otherwise done). `model-switched` messages are
deliberately **not** projected yet -- their Agents Anywhere kind is undecided,
and silently dropping a type is safer than emitting one the client cannot show.
See `docs/opencode-server-surface.md` §4.1 for the measured shapes.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtime_protocol.timeline import timeline_content_hash

RUNTIME = "opencode"
TOOL_STATUS = {
    "completed": "done",
    "error": "failed",
    "failed": "failed",
    "running": "running",
    "pending": "pending",
    "cancelled": "cancelled",
}
TURN_END_STATUS = {"interrupted": "interrupted", "cancelled": "cancelled", "rejected": "failed"}


def timeline_item_id(native_key: str) -> str:
    return f"itm_{hashlib.sha256(native_key.encode('utf-8')).hexdigest()[:24]}"


def _markdown(text: str) -> dict[str, Any]:
    return {"kind": "markdown", "text": text, "format": "markdown"}


def _build(
    *,
    native_key: str,
    session_id: str,
    item_type: str,
    status: str,
    role: str | None,
    order_seq: int,
    content: dict[str, Any],
    source_event: str,
    turn_id: str | None,
    native_item_id: str | None,
    metadata: dict[str, Any],
) -> RuntimeTimelineItem:
    item_id = timeline_item_id(native_key)
    return RuntimeTimelineItem(
        id=item_id,
        session_id=session_id,
        type=item_type,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        order_seq=order_seq,
        content_hash=timeline_content_hash(item_type, status, role, content),  # type: ignore[arg-type]
        role=role,  # type: ignore[arg-type]
        turn_id=turn_id,
        content=content,
        source={"runtime": RUNTIME, "event": source_event, **({"itemId": native_item_id} if native_item_id else {})},
        revision=1,
        metadata=metadata,
    )


def project_messages(rows: Sequence[Any], *, session_id: str) -> tuple[RuntimeTimelineItem, ...]:
    """Project stored `/api/session/{id}/message` rows into ordered items."""
    items: list[RuntimeTimelineItem] = []
    turn_id: str | None = None

    def emit(**kwargs: Any) -> RuntimeTimelineItem:
        item = _build(session_id=session_id, order_seq=len(items) + 1, **kwargs)
        items.append(item)
        return item

    for position, message in enumerate(rows):
        if not isinstance(message, Mapping):
            continue
        kind = message.get("type")
        native_id = message.get("id")
        if not isinstance(native_id, str):
            continue

        if kind == "user":
            text = message.get("text")
            marker = emit(
                native_key=f"turn:start:{native_id}",
                item_type="turn.start",
                status="done",
                role="user",
                content={"kind": "turn_start"},
                source_event="message.user",
                turn_id=None,
                native_item_id=native_id,
                metadata={},
            )
            turn_id = marker.id
            emit(
                native_key=f"user:{native_id}",
                item_type="message",
                status="done",
                role="user",
                content=_markdown(text if isinstance(text, str) else ""),
                source_event="message.user",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata={},
            )

        elif kind == "assistant":
            parts = message.get("content")
            if not isinstance(parts, Sequence) or isinstance(parts, (str, bytes)):
                continue
            for ordinal, part in enumerate(parts):
                if not isinstance(part, Mapping):
                    continue
                part_type = part.get("type")
                if part_type in ("text", "reasoning"):
                    text = part.get("text")
                    emit(
                        native_key=f"{ 'reasoning' if part_type == 'reasoning' else 'text'}:{native_id}:{ordinal}",
                        item_type="message",
                        status="done",
                        role="assistant",
                        content=_markdown(text if isinstance(text, str) else ""),
                        source_event="message.assistant",
                        turn_id=turn_id,
                        native_item_id=native_id,
                        metadata={"ordinal": ordinal, **({"reasoning": True} if part_type == "reasoning" else {})},
                    )
                elif part_type == "tool":
                    tool_id = part.get("id")
                    if not isinstance(tool_id, str):
                        continue
                    state = part.get("state")
                    state = state if isinstance(state, Mapping) else {}
                    raw_status = state.get("status")
                    content: dict[str, Any] = {"kind": "tool_call", "title": str(part.get("name") or tool_id)}
                    if "input" in state:
                        content["input"] = state["input"]
                    for output_key in ("output", "result"):
                        if state.get(output_key) is not None:
                            content["output"] = state[output_key]
                            break
                    emit(
                        native_key=f"tool:{tool_id}",
                        item_type="tool",
                        # A stored snapshot means the call already finished, so an
                        # unrecognised status is reported as done with the native
                        # value kept in metadata rather than guessed at.
                        status=TOOL_STATUS.get(raw_status if isinstance(raw_status, str) else "", "done"),
                        role="tool",
                        content=content,
                        source_event="message.assistant",
                        turn_id=turn_id,
                        native_item_id=tool_id,
                        metadata={
                            "nativeToolId": tool_id,
                            "messageId": native_id,
                            **({"executed": part["executed"]} if isinstance(part.get("executed"), bool) else {}),
                            **({} if isinstance(raw_status, str) and raw_status in TOOL_STATUS else {"nativeStatus": raw_status}),
                        },
                    )

        elif kind == "synthetic":
            text = message.get("text")
            emit(
                native_key=f"synthetic:{native_id}",
                item_type="message",
                status="done",
                role="system",
                content=_markdown(text if isinstance(text, str) else ""),
                source_event="message.synthetic",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata={"synthetic": True, **({"description": message["description"]} if isinstance(message.get("description"), str) else {})},
            )

        elif kind == "idle":
            outcome = message.get("outcome")
            status = TURN_END_STATUS.get(outcome if isinstance(outcome, str) else "", "done")
            metadata: dict[str, Any] = {}
            if isinstance(outcome, str) and outcome:
                metadata["outcome"] = outcome
            emit(
                native_key=f"turn:end:{native_id}",
                item_type="turn.end",
                status=status,
                role=None,
                content={"kind": "turn_end"},
                source_event="message.idle",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata=metadata,
            )
            turn_id = None

    return tuple(items)
