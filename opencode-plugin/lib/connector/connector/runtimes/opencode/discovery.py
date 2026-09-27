from __future__ import annotations

import enum
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.filesystem import canonical_path
from connector.runtimes.opencode import provider_config

_ENDPOINT_NAME_RE = re.compile(r"^\d+-\d+\.json$")

# A busy Hub (handshake > 2s) is not a dead endpoint; keep handshake timeouts
# short but never equate them with staleness (rev3 K1).
HANDSHAKE_STARTUP_TIMEOUT_SECONDS = 2.0
HANDSHAKE_REQUEST_TIMEOUT_SECONDS = 2.0


class _Handshake(enum.Enum):
    LIVE = "live"  # authenticated: usable
    STALE = "stale"  # definitively dead: safe to delete (D1/D2/D3)
    KEEP = "keep"  # inconclusive (timeout / transient IO): never delete (K1/K2)


def normalize_location(location: str) -> str:
    """Location identity agreed with the Hub (rev3 ruling 1).

    realpath + trailing separator stripped + backslashes unified to ``/``;
    win32 additionally casefolds (``canonical_path`` -> ``os.path.normcase``).
    """

    return canonical_path(location).replace("\\", "/").rstrip("/")


@dataclass(frozen=True, slots=True)
class BridgeEndpoint:
    """One validated loopback bridge endpoint file.

    ``pid`` is diagnostic only: the authoritative liveness signal is a
    successful authenticated handshake (see probe()).
    """

    host: str
    port: int
    token: str
    pid: int
    path: Path
    bridge_id: str
    locations: tuple[str, ...]
    protocol_version: str = "1.0"
    service_version: str | None = None
    started_at: str | None = None


@dataclass(frozen=True, slots=True)
class OpenCodeDiscovery:
    available: bool
    configured: bool
    endpoints: tuple[BridgeEndpoint, ...] = ()
    reason: str | None = None
    metadata: dict[str, Any] | None = None


def _static_metadata(values: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "endpointDirectory": str(provider_config.registry_dir(dict(values))),
        "protocolVersion": "1.0",
        "storageMode": "opencode-native",
        "sameSessionWriterLimit": 1,
        "crossProcessWriterExclusion": False,
        "instanceGranularity": "location",
    }


async def discover(values: Mapping[str, Any]) -> OpenCodeDiscovery:
    """Report that this connector supports the OpenCode runtime type.

    The device list only answers "which runtime types does this connector
    support", so discovery must not touch the bridge registry. Whether a bridge
    is reachable is a configuration/start concern and belongs to probe().
    """

    return OpenCodeDiscovery(
        True,
        True,
        (),
        reason=None,
        metadata=_static_metadata(values),
    )


def endpoint_files(values: Mapping[str, Any]) -> tuple[Path, ...]:
    directory = provider_config.registry_dir(dict(values))
    try:
        entries = sorted(directory.glob("*.json"))
    except OSError:
        return ()
    return tuple(
        entry
        for entry in entries
        if entry.is_file() and _ENDPOINT_NAME_RE.fullmatch(entry.name)
    )


def load_endpoints(values: Mapping[str, Any]) -> tuple[BridgeEndpoint, ...]:
    """Read and validate every endpoint file; invalid files are skipped."""

    endpoints: list[BridgeEndpoint] = []
    for path in endpoint_files(values):
        try:
            endpoint = read_endpoint(path)
        except OSError:
            # K2: a transient read failure must not abort endpoint resolution.
            logger.debug(
                "OpenCode endpoint file unreadable; keeping endpoint file={}",
                path.name,
            )
            continue
        if endpoint is not None:
            endpoints.append(endpoint)
    return tuple(endpoints)


def read_endpoint(path: Path) -> BridgeEndpoint | None:
    """Decode one endpoint file; ``None`` means D1 (structurally invalid).

    Only *decoding* failures are swallowed. A transient ``OSError`` (an
    antivirus lock or a concurrent ``os.replace``) deliberately propagates so
    callers can treat it as K2 and keep the Hub-owned file (rev3 4.2).
    """

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return parse_endpoint(path, raw)
    except (ValueError, json.JSONDecodeError):
        return None


def parse_endpoint(path: Path, raw: Any) -> BridgeEndpoint:
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise ValueError("bridge endpoint has an unsupported version")
    if raw.get("runtime") != "opencode":
        raise ValueError("bridge endpoint is not an opencode runtime")
    protocol_version = raw.get("protocolVersion")
    if not isinstance(protocol_version, str) or not protocol_version:
        raise ValueError("bridge endpoint protocolVersion is missing")
    if protocol_version.split(".", 1)[0] != "1":
        raise ValueError("bridge endpoint protocol major is incompatible")
    host = raw.get("host")
    if host != "127.0.0.1":
        raise ValueError("bridge endpoint is not loopback-only")
    port = raw.get("port")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65_535:
        raise ValueError("bridge endpoint port is invalid")
    token = raw.get("token")
    if not isinstance(token, str) or not token:
        raise ValueError("bridge endpoint token is missing")
    pid = raw.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise ValueError("bridge endpoint process is invalid")
    bridge_id = raw.get("bridgeId")
    if not isinstance(bridge_id, str) or not bridge_id:
        raise ValueError("bridge endpoint bridgeId is missing")
    locations = raw.get("locations", [])
    if not isinstance(locations, list) or any(
        not isinstance(item, str) or not item for item in locations
    ):
        raise ValueError("bridge endpoint locations are invalid")
    service_version = raw.get("serviceVersion")
    if service_version is not None and not isinstance(service_version, str):
        raise ValueError("bridge endpoint serviceVersion is invalid")
    started_at = raw.get("startedAt")
    if started_at is not None and not isinstance(started_at, str):
        raise ValueError("bridge endpoint startedAt is invalid")
    return BridgeEndpoint(
        host=host,
        port=port,
        token=token,
        pid=pid,
        path=path,
        bridge_id=bridge_id,
        locations=tuple(locations),
        protocol_version=protocol_version,
        service_version=service_version,
        started_at=started_at,
    )


def select_endpoint(
    values: Mapping[str, Any],
    endpoints: tuple[BridgeEndpoint, ...],
) -> BridgeEndpoint | None:
    """Pick the endpoint serving this instance's (servicePid, location) pair.

    A configured location is binding (rev3 ruling 1): an endpoint that declares
    no locations, or does not list this one, is rejected rather than silently
    accepted.
    """

    pid = values.get("servicePid")
    location = values.get("location")
    candidates = [item for item in endpoints if pid is None or item.pid == pid]
    if isinstance(location, str) and location:
        wanted = normalize_location(location)
        candidates = [
            item
            for item in candidates
            if any(normalize_location(known) == wanted for known in item.locations)
        ]
    if not candidates:
        return None
    # Prefer the most recently started endpoint instead of an arbitrary
    # lexicographic pick (m6); ``10-`` must not outrank ``9-``.
    candidates.sort(
        key=lambda item: (item.started_at or "", item.pid, item.port),
        reverse=True,
    )
    return candidates[0]


def resolve_endpoint(values: Mapping[str, Any]) -> BridgeEndpoint | None:
    """Select an endpoint without a handshake; the attach attempt authenticates."""

    return select_endpoint(values, load_endpoints(values))


def discard_stale(endpoint: BridgeEndpoint) -> None:
    discard_stale_path(endpoint.path)


def discard_stale_path(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        return
    logger.debug("discarded stale OpenCode bridge endpoint file={}", path.name)


def endpoint_is_stale(endpoint: BridgeEndpoint, error: BaseException) -> bool:
    """Whether an attach failure proves the endpoint file is stale (rev3 4.2).

    Only D2 (connection refused with a non-live pid) and D3 (protocol major /
    identity mismatch) qualify; timeouts and unknown IO errors are KEEP.
    """

    from connector.runtimes.opencode.bridge.client import (
        BridgeIdentityError,
        BridgeProtocolError,
    )

    if isinstance(error, (BridgeIdentityError, BridgeProtocolError)):
        return True
    if isinstance(error, TimeoutError):
        return False
    if isinstance(error, ConnectionError):
        return not _pid_alive(endpoint.pid)
    return False


def discard_if_stale(endpoint: BridgeEndpoint, error: BaseException) -> None:
    """Best-effort cleanup; only definitively stale files are removed (D1-D3)."""

    if endpoint_is_stale(endpoint, error):
        discard_stale(endpoint)
    else:
        logger.debug(
            "OpenCode bridge attach failed inconclusively error_type={}; keeping endpoint file",
            type(error).__name__,
        )


def _pid_alive(pid: int) -> bool:
    """Conservative liveness probe; unknown results count as alive (keep file)."""

    if pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _windows_pid_alive(pid: int) -> bool:
    # os.kill(pid, 0) on Windows calls TerminateProcess, so probe the kernel.
    import ctypes

    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(process_query_limited_information, 0, pid)
    if not handle:
        # ERROR_ACCESS_DENIED (5) means the process exists but is protected.
        return kernel32.GetLastError() == 5
    try:
        code = ctypes.c_ulong(0)
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return code.value == still_active
        return True
    finally:
        kernel32.CloseHandle(handle)


async def probe(values: Mapping[str, Any]) -> OpenCodeDiscovery:
    """Authenticate every registered endpoint; unreachable ones are cleaned up.

    Cleanup is deliberately conservative (rev3 4.2): structural garbage,
    refused connections with a dead pid, and protocol-major mismatches are
    removed; handshake timeouts and transient IO failures are kept for retry.
    """

    live: list[BridgeEndpoint] = []
    for path in endpoint_files(values):
        try:
            endpoint = read_endpoint(path)
        except OSError:
            # K2: a transient IO failure (antivirus, concurrent os.replace) must
            # never cost the Hub its endpoint file; keep it for the next probe.
            logger.debug(
                "OpenCode endpoint file unreadable; keeping endpoint file={}",
                path.name,
            )
            continue
        if endpoint is None:
            # D1: a structurally invalid endpoint file can never authenticate.
            discard_stale_path(path)
            continue
        outcome = await _handshake(endpoint)
        if outcome is _Handshake.LIVE:
            live.append(endpoint)
        elif outcome is _Handshake.STALE:
            discard_stale(endpoint)
        # _Handshake.KEEP: leave the file for a later probe (Hub may be busy).
    if not live:
        return OpenCodeDiscovery(
            False,
            False,
            (),
            reason="请启动 OpenCode，并启用 Agents Anywhere 插件。",
        )
    return OpenCodeDiscovery(
        True,
        True,
        tuple(live),
        metadata=_static_metadata(values),
    )


async def _handshake(endpoint: BridgeEndpoint) -> _Handshake:
    # Import here: the client module owns the BridgeEndpoint DTO.
    from connector.runtimes.opencode.bridge.client import (
        BridgeClient,
        BridgeIdentityError,
        BridgeProtocolError,
    )

    async def ignore_notification(method: str, params: Mapping[str, Any]) -> None:
        pass

    async def ignore_exit(code: int | None) -> None:
        pass

    client = BridgeClient(
        endpoint=endpoint,
        connector_id="discovery",
        client_version="1.0",
        # The Hub fail-closes an initialize frame without a location (rev3
        # ruling 1): authenticate as the directory this endpoint itself
        # declares, so a live endpoint is never mistaken for a dead one.
        location=endpoint.locations[0] if endpoint.locations else None,
        startup_timeout=HANDSHAKE_STARTUP_TIMEOUT_SECONDS,
        request_timeout=HANDSHAKE_REQUEST_TIMEOUT_SECONDS,
        notification_handler=ignore_notification,
        exit_handler=ignore_exit,
    )
    try:
        await client.start()
        await client.request("ping")
    except (BridgeIdentityError, BridgeProtocolError):
        # D3: the endpoint answered but is not a compatible opencode bridge.
        logger.debug("OpenCode bridge rejected identity/protocol; endpoint is stale")
        return _Handshake.STALE
    except TimeoutError:
        # K1: a busy Hub must never cost another process its endpoint file.
        logger.debug("OpenCode bridge handshake timed out; keeping endpoint file")
        return _Handshake.KEEP
    except ConnectionError:
        # D2: refused with no response; only stale if the pid is also gone.
        if _pid_alive(endpoint.pid):
            return _Handshake.KEEP
        logger.debug("OpenCode bridge refused connection and pid is gone; stale")
        return _Handshake.STALE
    except (OSError, RuntimeError, ValueError):
        # K2: transient/unknown failure — preserve the file.
        logger.debug("OpenCode bridge handshake was inconclusive; keeping endpoint file")
        return _Handshake.KEEP
    finally:
        await client.close()
    return _Handshake.LIVE
