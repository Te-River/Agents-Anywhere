from __future__ import annotations

import asyncio
from collections.abc import Mapping
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.opencode.bridge.client import BridgeClient
from connector.runtimes.opencode.bridge.models import (
    agent_catalog,
    capability_set,
    model_catalog,
    permission_catalog,
    session_meta,
    session_state,
    timeline_item,
)
from connector.runtimes.opencode.bridge.models import notice as session_notice

PHASES = frozenset({"begin", "items", "commit", "notifications"})


def checkpoint_key(runtime_id: str, session_id: str) -> str:
    return f"opencode/{runtime_id}/{session_id}"


def _checkpoint(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    seq = value.get("throughSeq")
    fingerprint = value.get("historyHash")
    if (
        value.get("version") != 1
        or type(seq) is not int
        or not -1 <= seq <= 9007199254740991
        or not isinstance(value.get("updatedAt"), str)
    ):
        return None
    if fingerprint is not None and (
        not isinstance(fingerprint, str)
        or len(fingerprint) != 64
        or any(character not in "0123456789abcdef" for character in fingerprint)
    ):
        return None
    # ``historyHash`` is optional in the persisted shape (legacy/older writers),
    # so a missing key must yield None, never a KeyError (m1).
    return {key: value.get(key) for key in ("version", "throughSeq", "historyHash", "updatedAt")}


def _skipped_event_count(batch: Mapping[str, Any]) -> int | None:
    """Hub-owned ``diagnostics.skippedEventCount``; tolerant decode, else ignore."""

    diagnostics = batch.get("diagnostics")
    if not isinstance(diagnostics, Mapping):
        return None
    value = diagnostics.get("skippedEventCount")
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


class SyncRelay:
    """Reassemble bridge sync pages, then forward platform notifications.

    The plugin owns projection; this relay only decodes canonical items during
    ``begin``/``items`` and publishes once on ``commit``. Checkpoints use the
    ``opencode/<runtime_id>/<session_id>`` key and never advance before the
    corresponding host callbacks complete.
    """

    def __init__(
        self,
        client: BridgeClient,
        host: RuntimeHostClient,
        *,
        runtime_id: str = "opencode",
        retry_delay: float = 1.0,
    ) -> None:
        self.client = client
        self.host = host
        self.runtime_id = runtime_id
        self.retry_delay = retry_delay
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=4)
        self.task: asyncio.Task[None] | None = None
        self.stream_id: str | None = None
        self._active: dict[str, dict[str, Any]] = {}
        # Sessions this relay has subscribed to; used to re-subscribe and
        # re-calibrate after any internal recovery (rev3 n4).
        self._session_ids: set[str] = set()
        # Connector-owned diagnostics (rev3 ruling 4 / 4.1): only this side runs
        # the canonical decoders, so only it may count skipped items. The count
        # is per session — one process-wide number would mix sessions and
        # notification drops (fix Minor-2).
        self.skipped_item_counts: dict[str, int] = {}
        self.skipped_notification_count = 0
        self.skipped_event_count: int | None = None
        self.dropped_batch_count = 0

    @property
    def skipped_item_count(self) -> int:
        """Legacy aggregate over all sessions plus non-item notification drops.

        Kept for observability; ``syncDiagnostics.skippedItemCount`` reports the
        per-session ``skipped_item_counts`` entry instead.
        """

        return sum(self.skipped_item_counts.values()) + self.skipped_notification_count

    def _skip_item(self, session_id: str, error: BaseException) -> None:
        total = self.skipped_item_counts.get(session_id, 0) + 1
        self.skipped_item_counts[session_id] = total
        logger.warning(
            "OpenCode timeline item skipped error_type={} session_skipped_total={}",
            type(error).__name__,
            total,
        )

    def _skip_notification(self, error: BaseException) -> None:
        self.skipped_notification_count += 1
        logger.warning(
            "OpenCode notification skipped error_type={} notification_skipped_total={}",
            type(error).__name__,
            self.skipped_notification_count,
        )

    def start(self) -> None:
        self.task = asyncio.create_task(self.run(), name="opencode-event-sync")

    def accept(self, payload: Mapping[str, Any]) -> None:
        try:
            self.queue.put_nowait(dict(payload))
        except asyncio.QueueFull:
            # Never silently drop a batch: surface it, count it, and force a
            # re-subscription instead of trusting positional continuation (n3).
            self.dropped_batch_count += 1
            logger.warning(
                "OpenCode sync queue is full; dropping a batch and resyncing dropped_total={}",
                self.dropped_batch_count,
            )
            self.restart()

    def restart(self, reason: str | None = None) -> None:
        if reason:
            logger.debug("OpenCode sync restart requested stream={}", reason)
        while not self.queue.empty():
            self.queue.get_nowait()
        self.clear_snapshot()
        with suppress(asyncio.QueueFull):
            self.queue.put_nowait(None)

    async def close(self) -> None:
        if self.task and self.task is not asyncio.current_task():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        self.clear_snapshot()

    def clear_snapshot(self) -> None:
        self._active.clear()

    async def subscribe(
        self,
        session_id: str,
        from_seq: int | None = None,
        history_hash: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"sessionId": session_id}
        if from_seq is not None:
            params["fromSeq"] = from_seq
        if isinstance(history_hash, str) and history_hash:
            # rev3 ruling 3: the Hub prefix-calibrates on this hash; if it is
            # missing or does not match, the Hub must send a full snapshot.
            params["historyHash"] = history_hash
        self._session_ids.add(session_id)
        subscription = await self.client.request("runtime.sync.subscribe", params)
        if isinstance(subscription, Mapping):
            stream_id = subscription.get("streamId")
            if isinstance(stream_id, str) and stream_id:
                self.stream_id = stream_id
            return dict(subscription)
        return {}

    async def read_checkpoint(self, session_id: str) -> dict[str, Any] | None:
        return _checkpoint(
            await self.host.sync_state_read(checkpoint_key(self.runtime_id, session_id))
        )

    def _page(self, session_id: str) -> dict[str, Any]:
        page = self._active.get(session_id)
        if page is None:
            page = {"items": [], "meta": {}, "throughSeq": None, "historyHash": None}
            self._active[session_id] = page
        return page

    async def operation(self, batch: Mapping[str, Any]) -> None:
        session_id = batch.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("Sync batch requires a session identity")
        phase = batch.get("phase")
        if phase not in PHASES:
            raise ValueError(f"Unsupported sync phase: {phase!r}")
        stream_id = batch.get("streamId")
        if isinstance(stream_id, str) and self.stream_id and stream_id != self.stream_id:
            raise ValueError("Sync batch belongs to another stream")
        if phase == "begin":
            self._record_hub_diagnostics(batch)
            page = self._page(session_id)
            page["items"] = []
            meta = batch.get("meta")
            if meta is None:
                page["meta"] = {}
            elif isinstance(meta, Mapping):
                page["meta"] = dict(meta)
            else:
                # A non-mapping meta must never destroy the page (rev3 4.1).
                self._skip_item(
                    session_id, ValueError("Sync begin meta must be a mapping")
                )
                page["meta"] = {}
            page["throughSeq"] = batch.get("throughSeq")
            page["historyHash"] = batch.get("historyHash")
        elif phase == "items":
            page = self._page(session_id)
            raw_items = batch.get("items")
            if not isinstance(raw_items, list):
                raise ValueError("Sync items page must contain an items array")
            for raw in raw_items:
                # rev2 §6① / rev3 4.1: one malformed item must never destroy the
                # page; skip, count, and keep decoding the rest.
                try:
                    item = timeline_item(raw)
                except ValueError as error:
                    self._skip_item(session_id, error)
                    continue
                if item.session_id != session_id:
                    self._skip_item(
                        session_id,
                        ValueError("Incremental item belongs to another session"),
                    )
                    continue
                page["items"].append(item)
        elif phase == "commit":
            self._record_hub_diagnostics(batch)
            page = self._active.pop(session_id, None)
            if page is None:
                raise ValueError("Sync commit has no open page")
            meta = dict(page["meta"] or {})
            external_session_id = (
                meta.get("externalSessionId") or batch.get("externalSessionId")
            )
            page_metadata = meta.get("metadata")
            if meta:
                await self.host.session_meta_upsert(
                    session_id=session_id,
                    runtime="opencode",
                    external_session_id=external_session_id,
                    title=meta.get("title"),
                    cwd=meta.get("cwd"),
                    ordering_time=meta.get("orderingTime"),
                    metadata=page_metadata
                    if isinstance(page_metadata, Mapping)
                    else None,
                )
            sync_metadata = (
                dict(page_metadata) if isinstance(page_metadata, Mapping) else {}
            )
            sync_metadata["syncDiagnostics"] = {
                # Hub-owned native event counter is passed through; the
                # Connector never derives it (rev3 ruling 4).
                "skippedEventCount": self.skipped_event_count,
                "skippedItemCount": self.skipped_item_counts.get(session_id, 0),
                "updatedAt": _utc_now(),
            }
            await self.host.timeline_sync(
                session_id,
                "opencode",
                tuple(page["items"]),
                external_session_id=external_session_id,
                complete=batch.get("complete") is True
                or batch.get("snapshotComplete") is True,
                metadata=sync_metadata,
            )
            await self._write_checkpoint(
                session_id,
                batch.get("throughSeq", page["throughSeq"]),
                batch.get("historyHash", page["historyHash"]),
            )
        else:
            notifications = batch.get("notifications")
            if not isinstance(notifications, list):
                raise ValueError(
                    "Sync notifications page must contain a notifications array"
                )
            for notice in notifications:
                try:
                    await self.publish_notification(notice)
                except (ValueError, KeyError, TypeError) as error:
                    # Notification decode is tolerant too (rev3 4.1): skip and
                    # count so an unknown platform method can never break the
                    # feed. An upsert that fails to decode *is* a skipped item
                    # and is attributed to this session; every other method is a
                    # non-item drop, counted separately (fix Minor-2).
                    method = notice.get("method") if isinstance(notice, Mapping) else None
                    if method == "timeline.itemUpsert":
                        self._skip_item(session_id, error)
                    else:
                        self._skip_notification(error)

    def _record_hub_diagnostics(self, batch: Mapping[str, Any]) -> None:
        value = _skipped_event_count(batch)
        if value is not None:
            self.skipped_event_count = value

    async def _write_checkpoint(
        self,
        session_id: str,
        through_seq: Any,
        history_hash: Any,
    ) -> None:
        if (
            not isinstance(through_seq, int)
            or isinstance(through_seq, bool)
            or through_seq < -1
        ):
            return
        if history_hash is not None and not isinstance(history_hash, str):
            return
        # §6③ responsibility (rev3 §2.6): ``throughSeq`` means "the largest
        # ``durable.seq`` delivered on this connection" and is guaranteed by the
        # Hub — non-durable events never advance it. The Connector persists the
        # Hub's value verbatim and must never derive or reinterpret it.
        # Every history operation above was synchronously ingested before this
        # write, so the persisted checkpoint can never run ahead of the platform.
        await self.host.sync_state_write(
            checkpoint_key(self.runtime_id, session_id),
            {
                "version": 1,
                "throughSeq": through_seq,
                "historyHash": history_hash if isinstance(history_hash, str) else None,
                "updatedAt": _utc_now(),
            },
        )

    async def publish_notification(self, notice: Any) -> None:
        method = notice.get("method") if isinstance(notice, Mapping) else None
        params = notice.get("params") if isinstance(notice, Mapping) else None
        if not isinstance(params, Mapping):
            raise ValueError("Invalid runtime notification")  # noqa: TRY004 - decode error parity with DSH decoders
        data = dict(params)
        # These are the Connector's own platform notification names (the plugin
        # projects OpenCode events onto them); native event enums never appear here.
        if method == "timeline.itemUpsert":
            item = timeline_item(data.get("item"))
            if item.session_id != data.get("sessionId"):
                raise ValueError("Incremental item belongs to a different session")
            await self.host.timeline_item_upsert(item)
        elif method == "notice.upsert":
            await self.host.notice_upsert(session_notice(data))
        elif method == "session.meta.upsert":
            meta = session_meta(data)
            await self.host.session_meta_upsert(
                session_id=meta.session_id,
                runtime="opencode",
                external_session_id=meta.external_session_id,
                title=meta.title,
                cwd=meta.cwd,
                ordering_time=meta.ordering_time,
                metadata=meta.metadata,
            )
        elif method == "session.state.updated":
            state = session_state(data)
            await self.host.session_state_update(
                session_id=state.session_id,
                runtime="opencode",
                external_session_id=state.external_session_id,
                status=state.status,
                selections=state.selections,
                status_reason=state.status_reason,
                error=state.error,
                metadata=state.metadata,
            )
        # Canonical capability-update names, with the legacy pre-gateway aliases
        # kept working (rev3/F2): both spellings must resolve identically and
        # nothing here is ever silently swallowed.
        elif method in {"runtime.capability.updated", "runtime.capabilities.update"}:
            await self.host.runtime_capabilities_update(
                capability_set(data, connector_id=self.host.connector_id)
            )
        elif method in {"session.capability.updated", "session.capabilities.update"}:
            await self.host.session_capabilities_update(
                capability_set(data, connector_id=self.host.connector_id)
            )
        elif method == "catalog.model.update":
            await self.host.model_catalog_update(model_catalog(data))
        elif method == "catalog.permission.update":
            await self.host.permission_catalog_update(permission_catalog(data))
        elif method == "catalog.agent.update":
            # Agent directory (D3). `RuntimeHostClient.agent_catalog_update`
            # now covers the Connector host; a structural host that predates
            # that surface is skipped with a warning, never silently swallowed.
            publish = getattr(self.host, "agent_catalog_update", None)
            if publish is None:
                logger.warning(
                    "OpenCode agent catalog update ignored: host exposes no agent_catalog_update"
                )
            else:
                await publish(agent_catalog(data))
        else:
            raise ValueError(f"Unsupported runtime notification: {method}")

    async def _ack(self, batch: Mapping[str, Any]) -> None:
        session_id = batch.get("sessionId")
        through_seq = batch.get("throughSeq")
        if (
            batch.get("phase") in {"commit", "notifications"}
            and isinstance(session_id, str)
            and isinstance(through_seq, int)
            and not isinstance(through_seq, bool)
        ):
            await self.client.request(
                "runtime.sync.ack",
                {"sessionId": session_id, "throughSeq": through_seq},
            )

    async def run(self) -> None:
        try:
            while True:
                try:
                    await self.consume()
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - isolate and recover a failed feed
                    logger.warning(
                        "OpenCode event sync interrupted; resubscribing for history calibration ({})",
                        type(error).__name__,
                    )
                    await self.host.runtime_health_update(
                        "starting",
                        {
                            "code": "runtime_sync_interrupted",
                            "message": "OpenCode 会话同步中断，正在重试…",
                            "retryable": True,
                        },
                    )
                    if not self.client.connected:
                        return
                    self.clear_snapshot()
                    await asyncio.sleep(self.retry_delay)
                    while not self.queue.empty():
                        self.queue.get_nowait()
                    # rev3 n4: any internal recovery must re-subscribe and
                    # re-calibrate from the persisted checkpoint, never resume
                    # positionally on a snapshot it just dropped.
                    await self._resubscribe()
        finally:
            self.clear_snapshot()

    async def _resubscribe(self) -> None:
        for session_id in tuple(self._session_ids):
            checkpoint = None
            try:
                checkpoint = await self.read_checkpoint(session_id)
            except Exception as error:  # noqa: BLE001 - a bad checkpoint must not stop recovery
                logger.debug(
                    "OpenCode checkpoint unreadable during resync error_type={}",
                    type(error).__name__,
                )
            from_seq = checkpoint.get("throughSeq") if checkpoint else None
            history_hash = checkpoint.get("historyHash") if checkpoint else None
            try:
                await self.subscribe(session_id, from_seq=from_seq, history_hash=history_hash)
            except Exception as error:  # noqa: BLE001 - keep trying other sessions
                logger.debug(
                    "OpenCode resubscribe failed session=... error_type={}",
                    type(error).__name__,
                )

    async def consume(self) -> None:
        while True:
            batch = await self.queue.get()
            if batch is None:
                raise RuntimeError("The OpenCode sync stream needs a new subscription")
            await self.operation(batch)
            await self._ack(batch)
