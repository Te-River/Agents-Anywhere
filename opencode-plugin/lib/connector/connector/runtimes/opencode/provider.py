from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeResourceClaim,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.filesystem import filesystem_resource_key
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.opencode import discovery, provider_config
from connector.runtimes.opencode.runtime import OpenCodeRuntime

OPENCODE_CONFIG_SCHEMA_REVISION = 1

Discovery = Callable[[Mapping[str, Any]], Awaitable[discovery.OpenCodeDiscovery]]
Probe = Callable[[Mapping[str, Any]], Awaitable[discovery.OpenCodeDiscovery]]


class OpenCodeProvider(RuntimeProvider):
    """OpenCode V2 runtime: attach to a loopback bridge, one instance per location."""

    def __init__(
        self,
        discoverer: Discovery | None = None,
        prober: Probe | None = None,
    ) -> None:
        self._discoverer = discoverer or discovery.discover
        # Reachability is a configuration/start concern. Callers that inject a
        # discoverer (tests, embedders) keep using it for both so a single fake
        # still drives the whole provider surface.
        self._prober = prober or discoverer or discovery.probe
        self._last_discovery: discovery.OpenCodeDiscovery | None = None
        self._last_values = provider_config.default_config_values()

    def _remember(self, result: discovery.OpenCodeDiscovery) -> None:
        self._last_discovery = result

    @property
    def runtime(self) -> str:
        return "opencode"

    @property
    def runtime_type(self) -> str:
        return "opencode"

    @property
    def implementation_type(self) -> str:
        return "local-service"

    @property
    def instance_policy(self) -> str:
        return "multiple"

    @property
    def max_instances(self) -> None:
        return None

    @property
    def display_name(self) -> str:
        return "OpenCode"

    @property
    def description(self) -> str:
        return "OpenCode V2 loopback bridge runtime"

    async def discover(self) -> RuntimeTypeDescriptor:
        """Report the supported runtime type. Bridge reachability is not discovery."""

        values = self._last_values
        result = await self._discoverer(values)
        self._remember(result)
        metadata = dict(result.metadata or {})
        capabilities = provider_config.opencode_capabilities(
            metadata.get("runtimeCapabilities")
        )
        metadata.update(
            {
                "protocolVersion": "1.0",
                "storageMode": "opencode-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "configured": result.configured,
            }
        )
        if "runtimeCapabilities" in metadata:
            metadata["readOnly"] = not capabilities["startTurn"]
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            implementation_type=self.implementation_type,
            available=result.available,
            capabilities=capabilities,
            reason=(
                None
                if result.available
                else result.reason or "OpenCode is unavailable"
            ),
            config_schema=self._config_schema(),
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            recommended=False,
            metadata=metadata,
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return self._config_schema()

    def _config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=OPENCODE_CONFIG_SCHEMA_REVISION,
            schema=provider_config.opencode_config_schema(),
            ui_schema={
                "order": [
                    "registryDir",
                    "servicePid",
                    "location",
                    "startupTimeoutMs",
                    "requestTimeoutMs",
                    "maxRestartAttempts",
                    "restartBackoffMs",
                ],
                "registryDir": {"component": "path"},
            },
            defaults=provider_config.default_config_values(),
            metadata={
                "storageMode": "opencode-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "instanceGranularity": "location",
            },
        )

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        raw = dict(values)
        errors = sorted(
            Draft202012Validator(provider_config.opencode_config_schema()).iter_errors(
                raw
            ),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"opencode config is invalid at {path or '/'}: {errors[0].message}"
            )
        normalized = provider_config.normalized_config_values(raw)
        result = await self._prober(normalized)
        self._remember(result)
        self._last_values = normalized
        # Offline is temporary, not an invalid configuration. The runtime owns
        # reconnection and re-reads the registry when a bridge appears.
        metadata = dict(result.metadata or {})
        capabilities = provider_config.opencode_capabilities(
            metadata.get("runtimeCapabilities")
        )
        metadata.update(
            {
                "protocolVersion": "1.0",
                "readOnly": not capabilities["startTurn"],
                "storageMode": "opencode-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "configured": result.configured,
            }
        )
        schema_info = self._config_schema()
        return RuntimeConfig(
            runtime=self.runtime,
            revision=OPENCODE_CONFIG_SCHEMA_REVISION,
            values=normalized,
            schema=schema_info.schema,
            ui_schema=schema_info.ui_schema,
            metadata=metadata,
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        return OpenCodeRuntime(config=config, host=host)

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        registry = str(provider_config.registry_dir(dict(config.values)))
        return (
            RuntimeResourceClaim(
                kind="opencode_bridge_registry",
                key=_instance_resource_key(dict(config.values)),
                label=f"OpenCode bridge registry {registry!r}",
            ),
        )

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey:
        return RuntimeSourceKey(
            kind="opencode_service",
            key=_instance_resource_key(dict(config.values)),
        )


def _instance_resource_key(values: Mapping[str, Any]) -> str:
    """Registry key narrowed to one running OpenCode instance.

    ``resource_claims``/``session_source_key`` used to collapse every OpenCode
    process sharing a registry directory into a single identity, so two instances
    on the same machine were indistinguishable to the host (audit M1). The config
    schema already binds one runtime instance to a ``(servicePid, location)``
    pair, so the canonical registry key is suffixed with whichever of those are
    configured; with neither set the key is the plain registry key, unchanged. No
    token or other secret ever enters the key.
    """

    parts = [filesystem_resource_key(provider_config.registry_dir(dict(values)))]
    pid = values.get("servicePid")
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
        parts.append(f"servicePid={pid}")
    location = values.get("location")
    if isinstance(location, str) and location:
        parts.append(f"location={discovery.normalize_location(location)}")
    return "::".join(parts)
