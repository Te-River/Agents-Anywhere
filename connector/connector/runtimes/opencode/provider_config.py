from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from connector.paths import DATA_DIR_ENV, DATA_DIR_NAME
from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtime_protocol.filesystem import canonical_path

DEFAULT_STARTUP_TIMEOUT_MS = 30_000
DEFAULT_REQUEST_TIMEOUT_MS = 60_000
DEFAULT_MAX_RESTART_ATTEMPTS = 3
DEFAULT_RESTART_BACKOFF_MS = 1_000

BRIDGE_DIR_NAME = "opencode-bridge"
ENDPOINTS_DIR_NAME = "endpoints"

# rev3 ruling 2: partial session discovery rides this capability row's
# metadata (``discoveryState`` in {"complete","partial"}), never the boolean
# supported/available/allowed channel that AA gates on.
CAPABILITY_SESSION_DISCOVERY = "session.discovery"


def opencode_config_schema() -> dict[str, Any]:
    positive_timeout = {"type": "integer", "minimum": 100, "maximum": 600_000}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "registryDir": {
                "type": "string",
                "minLength": 1,
                "title": "OpenCode bridge registry",
                "description": "Optional absolute directory holding the loopback endpoint files; defaults to the per-user OpenCode bridge directory.",
            },
            "servicePid": {
                "type": "integer",
                "minimum": 1,
                "title": "OpenCode service PID",
                "description": "Target OpenCode service process. One runtime instance binds each (servicePid, location) pair.",
            },
            "location": {
                "type": "string",
                "minLength": 1,
                "title": "OpenCode location",
                "description": "Absolute project location served by this instance.",
            },
            "startupTimeoutMs": {**positive_timeout, "default": DEFAULT_STARTUP_TIMEOUT_MS},
            "requestTimeoutMs": {**positive_timeout, "default": DEFAULT_REQUEST_TIMEOUT_MS},
            "maxRestartAttempts": {
                "type": "integer",
                "minimum": 0,
                "maximum": 10,
                "default": DEFAULT_MAX_RESTART_ATTEMPTS,
                "description": "Fast attach attempts before polling the local bridge registry every 5 seconds.",
            },
            "restartBackoffMs": {**positive_timeout, "default": DEFAULT_RESTART_BACKOFF_MS},
        },
        "additionalProperties": False,
    }


def default_config_values() -> dict[str, Any]:
    return {
        "startupTimeoutMs": DEFAULT_STARTUP_TIMEOUT_MS,
        "requestTimeoutMs": DEFAULT_REQUEST_TIMEOUT_MS,
        "maxRestartAttempts": DEFAULT_MAX_RESTART_ATTEMPTS,
        "restartBackoffMs": DEFAULT_RESTART_BACKOFF_MS,
    }


def normalized_config_values(raw: dict[str, Any]) -> dict[str, Any]:
    values = {**default_config_values(), **raw}
    registry = values.get("registryDir")
    if registry is not None:
        if (
            not isinstance(registry, str)
            or not Path(registry).expanduser().is_absolute()
        ):
            raise RuntimeInvalidRequestError("registryDir must be an absolute path")
        values["registryDir"] = canonical_path(registry)
    pid = values.get("servicePid")
    if pid is not None and (
        not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0
    ):
        raise RuntimeInvalidRequestError("servicePid must be a positive integer")
    location = values.get("location")
    if location is not None:
        if not isinstance(location, str) or not location:
            raise RuntimeInvalidRequestError("location must be a non-empty string")
        if not Path(location).expanduser().is_absolute():
            raise RuntimeInvalidRequestError("location must be an absolute path")
    for key in ("startupTimeoutMs", "requestTimeoutMs", "restartBackoffMs"):
        value = values.get(key)
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or not 100 <= value <= 600_000
        ):
            raise RuntimeInvalidRequestError(
                f"{key} must be an integer between 100 and 600000"
            )
    attempts = values.get("maxRestartAttempts")
    if (
        not isinstance(attempts, int)
        or isinstance(attempts, bool)
        or not 0 <= attempts <= 10
    ):
        raise RuntimeInvalidRequestError(
            "maxRestartAttempts must be an integer between 0 and 10"
        )
    return values


def registry_dir(values: dict[str, Any]) -> Path:
    """Resolve the endpoints directory without creating it.

    Follows the ``connector/paths.py`` ``.agents-anywhere`` convention so a
    self-hosted data directory override keeps working.
    """

    configured = values.get("registryDir")
    if isinstance(configured, str):
        return Path(canonical_path(configured))
    override = os.environ.get(DATA_DIR_ENV)
    base = Path(override).expanduser() if override else Path.home() / DATA_DIR_NAME
    return Path(canonical_path(base / BRIDGE_DIR_NAME / ENDPOINTS_DIR_NAME))


def opencode_capabilities(reported: dict[str, Any] | None = None) -> dict[str, bool]:
    enabled = {
        row.get("capabilityId")
        for row in (reported or {}).get("capabilities", [])
        if isinstance(row, dict)
        and row.get("supported")
        and row.get("available")
        and row.get("allowed")
    }
    return {
        "modelCatalog": "catalog.model" in enabled,
        "permissionCatalog": "catalog.permission" in enabled,
        # Derived from the Hub capability, never hardcoded: if the Hub cannot
        # run discovery the descriptor must not claim support (m3).
        "sessionDiscovery": CAPABILITY_SESSION_DISCOVERY in enabled,
        "sessionSnapshot": True,
        "sessionState": True,
        "sessionNotices": True,
        "createAndStartSession": "session.send_message" in enabled,
        "startTurn": "session.send_message" in enabled,
        "steerTurn": "session.steer" in enabled,
        "interruptTurn": "session.interrupt" in enabled,
        "commands": "session.commands" in enabled,
        "interactions": "session.interaction.approval" in enabled,
        "attachments": "runtime.attachment" in enabled,
        "ipc": True,
    }
