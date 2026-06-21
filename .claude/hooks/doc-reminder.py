#!/usr/bin/env python3
"""Claude Code PostToolUse drift guard (non-blocking).

Fires after Edit/Write. If the edited file is pipeline/source code (server/,
services/, client/scripts/) but NOT a doc, it injects a short reminder into the
agent's context to keep CLAUDE.md / docs/ in sync. It never errors or blocks the
tool — on any problem it exits 0 silently.

Wired in .claude/settings.json. See docs/ARCHITECTURE.md#keeping-docs-fresh.
"""
import json
import sys


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return

    path = (data.get("tool_input") or {}).get("file_path", "")
    if not path:
        return

    p = path.replace("\\", "/")

    # Skip the docs themselves — editing them is the cure, not the disease.
    if "/CLAUDE.md" in p or p.endswith("CLAUDE.md") or "/docs/" in p:
        return

    is_source = any(
        seg in p for seg in ("/server/", "/services/", "/client/scripts/")
    )
    if not is_source:
        return

    reminder = (
        "Doc drift guard: you just edited pipeline/source code. If this changed "
        "the pipeline stages, the 9-view contract, run steps, or env knobs, update "
        "CLAUDE.md and docs/ARCHITECTURE.md in this same change so the docs don't "
        "go stale. (No action needed if it was a no-behavior change.)"
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": reminder,
        }
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
