#!/usr/bin/env python3
import argparse
import csv
import fcntl
import json
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", HOME / ".cache")) / "ai-usage"
DB_PATH = CACHE_DIR / "tokens.sqlite"
STATS_PATH = CACHE_DIR / "token-stats.json"
LOCK_PATH = CACHE_DIR / "token-stats.lock"

CLAUDE_ROOTS = [HOME / ".claude" / "projects"]
CODEX_ROOTS = [HOME / ".codex" / "sessions", HOME / ".codex" / "archived_sessions"]

SOURCE_CLAUDE = "claude"
SOURCE_CODEX = "codex"
UNKNOWN_MODEL = "unknown"
# Claude Code writes locally generated placeholder replies under this model name.
SYNTHETIC_MODEL = "<synthetic>"

GRANULARITY_FORMATS = {
    "hour": "%Y-%m-%dT%H:00",
    "day": "%Y-%m-%d",
    "week": "%G-W%V",
    "month": "%Y-%m",
    "year": "%Y",
}

# Bump when stored rows must be rebuilt from scratch.
SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    path   TEXT PRIMARY KEY,
    offset INTEGER NOT NULL,
    state  TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    key         TEXT PRIMARY KEY,
    ts          INTEGER NOT NULL,
    source      TEXT NOT NULL,
    model       TEXT NOT NULL,
    input       INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cache_read  INTEGER NOT NULL,
    output      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
"""


def parse_ts(value):
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def as_int(value):
    return value if isinstance(value, int) and value > 0 else 0


def iter_new_lines(path, offset):
    """Yield complete lines after `offset`; the last yielded end offset is safe to store."""
    with open(path, "rb") as handle:
        handle.seek(offset)
        position = offset
        for raw in handle:
            if not raw.endswith(b"\n"):
                break
            position += len(raw)
            yield raw, position


def claude_record(raw):
    # Cheap byte filter first: most transcript lines are user turns and tool output.
    if b'"usage"' not in raw or b'"assistant"' not in raw:
        return None
    try:
        entry = json.loads(raw)
    except ValueError:
        return None
    message = entry.get("message") or {}
    usage = message.get("usage")
    if entry.get("type") != "assistant" or not isinstance(usage, dict):
        return None
    model = message.get("model") or UNKNOWN_MODEL
    if model == SYNTHETIC_MODEL:
        return None
    ts = parse_ts(entry.get("timestamp"))
    if ts is None:
        return None
    # One API response is logged once per content block, and resumed sessions
    # copy earlier responses into a new file.
    key = f"c:{message.get('id') or entry.get('uuid')}:{entry.get('requestId') or ''}"
    return (
        key, ts, SOURCE_CLAUDE, model,
        as_int(usage.get("input_tokens")),
        as_int(usage.get("cache_creation_input_tokens")),
        as_int(usage.get("cache_read_input_tokens")),
        as_int(usage.get("output_tokens")),
    )


def codex_records(raw, state):
    if b'"token_count"' not in raw and b'"turn_context"' not in raw and b'"session_meta"' not in raw:
        return []
    try:
        entry = json.loads(raw)
    except ValueError:
        return []
    payload = entry.get("payload") or {}
    kind = entry.get("type")
    if kind == "session_meta":
        state["session"] = payload.get("id") or payload.get("session_id") or state.get("session")
        return []
    if kind == "turn_context":
        state["model"] = payload.get("model") or state.get("model")
        return []
    if kind != "event_msg" or payload.get("type") != "token_count":
        return []
    total = (payload.get("info") or {}).get("total_token_usage")
    ts = parse_ts(entry.get("timestamp"))
    if not isinstance(total, dict) or ts is None:
        return []

    # Codex repeats token_count events, so usage is the delta of the running total.
    fields = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens")
    current = {name: as_int(total.get(name)) for name in fields}
    previous = state.get("totals") or {name: 0 for name in fields}
    delta = {name: current[name] - previous.get(name, 0) for name in fields}
    if any(value < 0 for value in delta.values()):
        delta = current
    state["totals"] = current
    if not any(delta.values()):
        return []

    cached = delta["cached_input_tokens"]
    key = f"x:{state.get('session')}:{total.get('total_tokens')}:{current['output_tokens']}"
    return [(
        key, ts, SOURCE_CODEX, state.get("model") or UNKNOWN_MODEL,
        max(0, delta["input_tokens"] - cached),
        delta["cache_write_input_tokens"],
        cached,
        delta["output_tokens"],
    )]


def scan_file(db, path, source):
    row = db.execute("SELECT offset, state FROM files WHERE path = ?", (str(path),)).fetchone()
    offset, state = (row[0], json.loads(row[1] or "{}")) if row else (0, {})
    try:
        size = path.stat().st_size
    except OSError:
        return 0
    if size < offset:
        offset, state = 0, {}
    if size == offset:
        return 0

    records = []
    end = offset
    for raw, end in iter_new_lines(path, offset):
        if source == SOURCE_CLAUDE:
            record = claude_record(raw)
            if record:
                records.append(record)
        else:
            records.extend(codex_records(raw, state))

    # Claude Code rewrites a streaming response several times with growing
    # output counts, so every field keeps the largest value seen for its key.
    db.executemany(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET "
        "ts = min(ts, excluded.ts), input = max(input, excluded.input), "
        "cache_write = max(cache_write, excluded.cache_write), "
        "cache_read = max(cache_read, excluded.cache_read), output = max(output, excluded.output)",
        records,
    )
    db.execute(
        "INSERT INTO files (path, offset, state) VALUES (?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, state = excluded.state",
        (str(path), end, json.dumps(state) if state else None),
    )
    return len(records)


def scan(db):
    scanned = 0
    for source, roots in ((SOURCE_CLAUDE, CLAUDE_ROOTS), (SOURCE_CODEX, CODEX_ROOTS)):
        for root in roots:
            if root.is_dir():
                for path in sorted(root.rglob("*.jsonl")):
                    scanned += scan_file(db, path, source)
    db.commit()
    return scanned


def aggregate(db, granularity):
    buckets = {}
    fmt = GRANULARITY_FORMATS[granularity]
    rows = db.execute(
        "SELECT ts, source, model, input, cache_write, cache_read, output FROM messages ORDER BY ts"
    )
    for ts, source, model, *tokens in rows:
        period = time.strftime(fmt, time.localtime(ts))
        bucket = buckets.setdefault((period, source, model), [0, 0, 0, 0, 0])
        for index, value in enumerate(tokens):
            bucket[index] += value
        bucket[4] += 1
    return buckets


def write_stats(db):
    hours = {}
    models = {}
    for (period, source, model), values in aggregate(db, "hour").items():
        # Keyed per source so two tools reporting the same model name never merge.
        key = f"{source}/{model}"
        hours.setdefault(period[:13], {})[key] = values
        models[key] = {"source": source, "model": model}
    first, last, count = db.execute("SELECT MIN(ts), MAX(ts), COUNT(*) FROM messages").fetchone()
    payload = {
        "version": 2,
        "generated_at": int(time.time()),
        "first_ts": first,
        "last_ts": last,
        "messages": count,
        "fields": ["input", "cache_write", "cache_read", "output", "messages"],
        "models": models,
        "hours": hours,
    }
    temporary = STATS_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")))
    temporary.replace(STATS_PATH)


def write_csv(db, out_path, granularity):
    rows = sorted(aggregate(db, granularity).items())
    with open(out_path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["period", "source", "model", "input", "cache_write",
                         "cache_read", "output", "total", "messages"])
        for (period, source, model), (inp, cw, cr, out, messages) in rows:
            writer.writerow([period, source, model, inp, cw, cr, out,
                             inp + cw + cr + out, messages])
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="Aggregate AI token usage from local transcripts.")
    parser.add_argument("--csv", metavar="PATH", help="export aggregated usage to a CSV file")
    parser.add_argument("--granularity", choices=GRANULARITY_FORMATS, default="day")
    args = parser.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        db = sqlite3.connect(DB_PATH)
        if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
            db.executescript("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS messages;")
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        db.executescript(SCHEMA)
        scan(db)
        write_stats(db)
        if args.csv:
            count = write_csv(db, args.csv, args.granularity)
            print(f"{count} rows -> {args.csv}")
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
