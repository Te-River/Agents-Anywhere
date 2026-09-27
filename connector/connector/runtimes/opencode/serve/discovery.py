"""Provider-facing discovery of the OpenCode host service.

The Connector's `discover()` answers "is this runtime type usable here" and
`probe()` answers "is this configuration reachable right now". On this transport
both reduce to: is a service registered, and does it confirm itself over
`GET /api/info` with the pid and version the registration promised.

Capabilities come from the same :func:`capability_rows` the attached runtime
reports, so the descriptor can never advertise something the runtime would then
refuse. The service password never leaves this module -- metadata is forwarded to
Agents Anywhere.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtimes.opencode.serve.client import (
    OpenCodeServerClient,
    OpenCodeServiceError,
    OpenCodeServiceUnavailable,
)
from connector.runtimes.opencode.serve.runtime import capability_rows
from connector.runtimes.opencode.serve.service import OpenCodeService, read_service

UNAVAILABLE_REASON = (
    "未检测到 OpenCode 服务：请打开 OpenCode 桌面版，或执行 `opencode serve --service`。"
)
STALE_REASON = "OpenCode 服务登记已过期（进程或版本已变），正在等待新的登记。"


@dataclass(frozen=True, slots=True)
class ServiceDiscovery:
    available: bool
    configured: bool
    reason: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


def _location(values: Mapping[str, Any]) -> str | None:
    value = values.get("location")
    return value if isinstance(value, str) and value else None


async def discover(
    values: Mapping[str, Any],
    *,
    service_reader: Callable[[], OpenCodeService | None] = read_service,
    client_factory: Callable[[OpenCodeService], OpenCodeServerClient] | None = None,
) -> ServiceDiscovery:
    """Report whether the host service is present and confirms itself."""
    location = _location(values)
    configured = bool(location)
    service = service_reader()
    if service is None:
        return ServiceDiscovery(
            available=False,
            configured=configured,
            reason=UNAVAILABLE_REASON,
            metadata={"runtimeCapabilities": {"capabilities": capability_rows(location)}},
        )
    client = (client_factory or (lambda item: OpenCodeServerClient(item)))(service)
    try:
        try:
            info = await client.verify()
        except OpenCodeServiceUnavailable as error:
            reason = STALE_REASON if "pid changed" in str(error) else UNAVAILABLE_REASON
            return ServiceDiscovery(
                available=False,
                configured=configured,
                reason=reason,
                metadata={"runtimeCapabilities": {"capabilities": capability_rows(location)}},
            )
        except OpenCodeServiceError as error:
            return ServiceDiscovery(
                available=False,
                configured=configured,
                reason=f"{UNAVAILABLE_REASON}（{error.tag}）",
                metadata={"runtimeCapabilities": {"capabilities": capability_rows(location)}},
            )
        return ServiceDiscovery(
            available=True,
            configured=configured,
            reason=None,
            metadata={
                "serviceVersion": info.get("version"),
                "servicePid": service.pid,
                "serviceUrl": service.origin,
                "runtimeCapabilities": {"capabilities": capability_rows(location)},
            },
        )
    finally:
        await client.aclose()


async def probe(
    values: Mapping[str, Any],
    *,
    service_reader: Callable[[], OpenCodeService | None] = read_service,
    client_factory: Callable[[OpenCodeService], OpenCodeServerClient] | None = None,
) -> ServiceDiscovery:
    """Same question as :func:`discover`, kept separate for the provider's wiring."""
    return await discover(
        values, service_reader=service_reader, client_factory=client_factory
    )
