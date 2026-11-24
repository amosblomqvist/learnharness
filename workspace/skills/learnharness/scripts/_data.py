"""Small read-only filesystem helpers for the LearnHarness skill.

No application imports, discovery scans, migrations, caches, or writes. Paths
inside the selected data folder may not resolve outside it. Imported-note paths
and artifact references are data, not instructions to open another file.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any

sys.dont_write_bytecode = True


class DataError(Exception):
    """An actionable reader error, suitable for stderr without a traceback."""


def data_root(override: str | None = None) -> Path:
    """Resolve an explicit data directory or the normal desktop location.

    Never create a missing directory or try a different installation. For a
    development copy or an app launched with LH_DATA_DIR, pass --data-dir.
    """
    if override is not None:
        root = Path(override).expanduser()
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support" / "LearnHarness" / "data"
    elif sys.platform == "win32":
        roaming = os.environ.get("APPDATA")
        if not roaming:
            raise DataError("APPDATA is not set; specify the learning data folder with --data-dir.")
        root = Path(roaming) / "LearnHarness" / "data"
    elif sys.platform.startswith("linux"):
        configured = os.environ.get("XDG_CONFIG_HOME")
        base = Path(configured) if configured else Path.home() / ".config"
        if configured and not base.is_absolute():
            raise DataError("XDG_CONFIG_HOME is relative; specify an absolute --data-dir instead.")
        root = base / "LearnHarness" / "data"
    else:
        raise DataError("Unknown desktop data location on this OS; specify --data-dir.")
    try:
        root = root.resolve()
        if not root.is_dir():
            raise DataError(f"Data folder not found: {root}. Use --data-dir for another copy; nothing was created.")
    except (OSError, RuntimeError, ValueError) as exc:
        raise DataError(f"Cannot resolve the data folder: {exc}") from exc
    return root


def safe_path(root: Path, relative: str | Path) -> Path:
    """Resolve a data-relative path, rejecting traversal and escaping symlinks."""
    try:
        part = Path(relative)
        if part.is_absolute():
            raise DataError("Expected a path relative to the selected data folder.")
        base = root.resolve()
        target = (base / part).resolve()
        if not target.is_relative_to(base):
            raise DataError(f"Refusing a path outside the selected data folder: {relative}")
    except (OSError, RuntimeError, ValueError) as exc:
        raise DataError(f"Cannot resolve data-relative path {relative!s}: {exc}") from exc
    return target


def _reject_constant(value: str) -> None:
    raise ValueError(f"Non-JSON numeric constant: {value}")


def read_json(root: Path, relative: str | Path, *, missing: Any = None) -> Any:
    """Read a JSON file without creating it; missing optional files use missing."""
    target = safe_path(root, relative)
    try:
        with target.open("r", encoding="utf-8") as source:
            return json.load(source, parse_constant=_reject_constant)
    except FileNotFoundError:
        return missing
    except (OSError, UnicodeError, ValueError) as exc:
        raise DataError(f"Cannot read {target}: {exc}") from exc


def read_chat(root: Path, session_id: str) -> dict[str, Any]:
    """Read a native v1 session; refuse unsupported formats rather than migrate."""
    if not session_id or session_id in {".", ".."} or any(char in session_id for char in ("/", "\\", "\x00")):
        raise DataError("Use a session ID from sessions.py list, not a filesystem path.")
    relative = Path("chats") / f"{session_id}.json"
    record = read_json(root, relative)
    if record is None:
        raise DataError(f"Session not found: {session_id} (under {root / 'chats'}).")
    if not isinstance(record, dict):
        raise DataError(f"Session {session_id} is not a JSON object.")
    version = record.get("version", 1)
    if isinstance(version, bool) or not isinstance(version, (int, float)):
        raise DataError(f"Session {session_id} has an invalid version; this reader supports native format 1.")
    if version > 1:
        raise DataError(f"Session {session_id} uses format {version}; this reader supports 1. Update the skill; no migration was attempted.")
    if record.get("id") != session_id:
        raise DataError(f"Session filename/ID mismatch: {session_id}.")
    if not all(isinstance(record.get(key), str) for key in ("title", "createdAt", "updatedAt")):
        raise DataError(f"Session {session_id} is missing string title/date metadata.")
    messages = record.get("messages")
    if not isinstance(messages, list):
        raise DataError(f"Session {session_id} has no native message array.")
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            raise DataError(f"Session {session_id}, message {index}: unsupported message shape.")
        if "parts" in message and "content" not in message:
            raise DataError(f"Session {session_id} uses the older UIMessage/parts format. This skill reads native v1 records only; inspect the source JSON read-only.")
    return record


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    """Common CLI options precede the subcommand, as shown in SKILL.md."""
    parser.add_argument("--data-dir", metavar="PATH", help="LearnHarness data root (contains chats/ and/or graph/); default: normal desktop location")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown", help="Output format (default: markdown)")


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
