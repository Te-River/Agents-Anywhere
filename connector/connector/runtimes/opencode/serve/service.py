"""Locate the machine-wide OpenCode service that the host itself uses.

OpenCode runs one shared background service per machine (`opencode serve
--service` for the desktop app) and registers it in
`$XDG_STATE_HOME/opencode/service.json` as `{id, version, url, pid, password}`.
The file is not part of the published docs, and a leftover file from a previous
run is indistinguishable by content alone -- so nothing here trusts it: callers
must confirm the live process through `GET /api/info` and compare `pid` and
`version`, which is the same rule OpenCode's own client applies.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SERVICE_FILENAME = "service.json"
SERVICE_DIR_NAME = "opencode"


@dataclass(frozen=True)
class OpenCodeService:
    """One registered service endpoint, as read from disk (never verified)."""

    url: str
    pid: int
    version: str
    password: str
    path: Path

    @property
    def origin(self) -> str:
        return self.url.rstrip("/")


def service_file(state_home: Path | str | None = None) -> Path:
    """Where OpenCode registers its service: `$XDG_STATE_HOME/opencode/service.json`."""
    import os

    base = Path(state_home) if state_home is not None else Path(
        os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state"
    )
    return base / SERVICE_DIR_NAME / SERVICE_FILENAME


def read_service(state_home: Path | str | None = None) -> OpenCodeService | None:
    """Return the registered service, or None when absent or unusable.

    Never raises: a missing file means "OpenCode is not running here", which the
    runtime reports as unavailable rather than as a failure of our own.
    """
    path = service_file(state_home)
    try:
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    url = raw.get("url")
    pid = raw.get("pid")
    version = raw.get("version")
    password = raw.get("password")
    if not (isinstance(url, str) and url.startswith("http")):
        return None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    if not isinstance(version, str) or not version:
        return None
    if not isinstance(password, str) or not password:
        return None
    return OpenCodeService(url=url, pid=pid, version=version, password=password, path=path)
