#!/usr/bin/env python3
import argparse
import contextlib
import csv
import fcntl
import itertools
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", HOME / ".cache")) / "ai-usage"
# The index outlives the transcripts it was built from, so it is user data
# (XDG_DATA_HOME), not a disposable cache.
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local" / "share")) / "ai-usage"
DB_PATH = DATA_DIR / "tokens.sqlite"
LEGACY_DB_PATH = CACHE_DIR / "tokens.sqlite"
BACKUP_DIR = DATA_DIR / "backups"
BACKUP_KEEP = 7
STATS_PATH = CACHE_DIR / "token-stats.json"
LOCK_PATH = CACHE_DIR / "token-stats.lock"

CLAUDE_ROOTS = [HOME / ".claude" / "projects"]
CODEX_ROOTS = [HOME / ".codex" / "sessions", HOME / ".codex" / "archived_sessions"]
USAGE_PATH = HOME / ".claude" / "usage.json"

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

# Bump to force a full rescan of every transcript; stored rows are kept.
SCHEMA_VERSION = 3

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
CREATE TABLE IF NOT EXISTS limit_samples (
    limit_id    TEXT NOT NULL,
    resets_at   INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    utilization REAL NOT NULL,
    PRIMARY KEY (limit_id, resets_at, ts)
);
"""


HOUR = 3600
DAY = 24 * HOUR
WEEK = 7 * DAY
SESSION_PERIOD = 5 * HOUR
WEEKLY_ALL = "weekly_all"
SESSION = "session"
# resets_at drifts by a fraction of a second between fetches ("16:59:59.58" vs
# "17:00:00"); rounding folds those into one cycle.
RESET_ROUNDING = 600
# A finished cycle counts as fully observed when a sample landed this close to its reset.
FINAL_SAMPLE_WINDOW = DAY

# The SessionStart usage hook writes this line into every transcript, which
# leaves a history of limit utilization that no API keeps.
HOOK_SAMPLE_RE = re.compile(
    r"limit=([a-z_]+), utilization=([0-9.]+)%, resets in ([0-9]+) min \(([0-9T:.+Z-]+)\)")
HOOK_EVENT = "SessionStart"
# Two readings of one reset can drift across a rounding boundary; ends closer
# than this are the same reset.
RESET_MERGE_WINDOW = 30 * 60
# Pre-limits[] usage.json keys, with the utilization field they carry.
LEGACY_USAGE_KEYS = {
    "five_hour": SESSION,
    "seven_day": WEEKLY_ALL,
    "seven_day_sonnet": "weekly:sonnet",
    "seven_day_opus": "weekly:opus",
}


def parse_ts(value):
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def as_int(value):
    return value if isinstance(value, int) and value > 0 else 0


def round_reset(ts):
    return int(round(ts / RESET_ROUNDING) * RESET_ROUNDING)


def model_family(name):
    """"Sonnet 5" / "claude-sonnet-5" -> "sonnet"."""
    words = re.findall(r"[a-z]+", str(name or "").lower())
    words = [word for word in words if word != "claude"]
    return words[0] if words else None


def hook_limit_id(name):
    if name == "five_hour":
        return SESSION
    if name == "seven_day":
        return WEEKLY_ALL
    if name.startswith("seven_day_"):
        family = model_family(name.removeprefix("seven_day_"))
        return f"weekly:{family}" if family else None
    return None


def hook_samples(raw):
    # The same text also turns up in prompts, tool output and replies that quote
    # it, so only the SessionStart hook attachment itself is trusted.
    if b"utilization=" not in raw or b'"attachment"' not in raw:
        return []
    try:
        entry = json.loads(raw)
    except ValueError:
        return []
    attachment = entry.get("attachment") if entry.get("type") == "attachment" else None
    if not isinstance(attachment, dict) or attachment.get("hookEvent") != HOOK_EVENT:
        return []
    content = attachment.get("content")
    texts = [attachment.get("stdout"), *(content if isinstance(content, list) else [content])]
    samples = set()
    for text in texts:
        if not isinstance(text, str):
            continue
        for name, utilization, minutes, resets in HOOK_SAMPLE_RE.findall(text):
            limit_id = hook_limit_id(name)
            resets_at = parse_ts(resets)
            if limit_id and resets_at is not None:
                taken = resets_at - int(minutes) * 60
                samples.add((limit_id, round_reset(resets_at), taken, float(utilization)))
    return list(samples)


def usage_limit_id(item):
    family = model_family(((item.get("scope") or {}).get("model") or {}).get("display_name"))
    if item.get("group") == "session":
        return SESSION
    if item.get("group") == "weekly":
        return f"weekly:{family}" if family else WEEKLY_ALL
    return None


def live_samples():
    """Current utilization from the fetcher's usage.json, stamped with its mtime."""
    try:
        data = json.loads(USAGE_PATH.read_text())
        taken = int(USAGE_PATH.stat().st_mtime)
    except (OSError, ValueError):
        return []
    readings = []
    if isinstance(data.get("limits"), list) and data["limits"]:
        for item in data["limits"]:
            if isinstance(item, dict):
                readings.append((usage_limit_id(item), item.get("resets_at"), item.get("percent")))
    else:
        for key, limit_id in LEGACY_USAGE_KEYS.items():
            block = data.get(key)
            if isinstance(block, dict):
                readings.append((limit_id, block.get("resets_at"), block.get("utilization")))
    samples = []
    for limit_id, resets, percent in readings:
        resets_at = parse_ts(resets)
        if limit_id and resets_at is not None and isinstance(percent, (int, float)):
            samples.append((limit_id, round_reset(resets_at), taken, float(percent)))
    return samples


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


def save_samples(db, samples):
    db.executemany(
        "INSERT INTO limit_samples VALUES (?, ?, ?, ?) ON CONFLICT(limit_id, resets_at, ts) "
        "DO UPDATE SET utilization = max(utilization, excluded.utilization)",
        samples,
    )


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
    samples = []
    end = offset
    for raw, end in iter_new_lines(path, offset):
        if source == SOURCE_CLAUDE:
            record = claude_record(raw)
            if record:
                records.append(record)
            samples.extend(hook_samples(raw))
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
    save_samples(db, samples)
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
    save_samples(db, live_samples())
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


def limit_period(limit_id):
    return SESSION_PERIOD if limit_id == SESSION else WEEK


def cycle_tokens(db, limit_id, start, end):
    query = ("SELECT SUM(input), SUM(cache_write), SUM(cache_read), SUM(output), COUNT(*) "
             "FROM messages WHERE source = ? AND ts >= ? AND ts < ?")
    params = [SOURCE_CLAUDE, start, end]
    # A model-scoped limit ("weekly:sonnet") only counts that model family.
    if limit_id.startswith("weekly:"):
        family = limit_id.split(":", 1)[1]
        query += " AND (model LIKE ? OR model LIKE ? OR model = ?)"
        params += [f"%-{family}-%", f"%-{family}", family]
    return [value or 0 for value in db.execute(query, params).fetchone()]


def inferred_weekly_ends(sampled_ends, first_ts):
    """Weekly resets repeat every 7 days, so gaps without samples are filled by stepping back."""
    if not sampled_ends or first_ts is None:
        return []
    ends = sorted(sampled_ends)
    inferred = []
    end = ends[0] - WEEK
    while end > first_ts:
        inferred.append(end)
        end -= WEEK
    for earlier, later in itertools.pairwise(ends):
        end = later - WEEK
        while end > earlier + DAY:
            inferred.append(end)
            end -= WEEK
    return inferred


def merge_close_ends(by_end):
    """Fold resets closer than RESET_MERGE_WINDOW into the most sampled one."""
    merged = {}
    group = []

    def flush():
        if not group:
            return
        end = max(group, key=lambda e: (by_end[e][2], e))
        merged[end] = (
            max(by_end[e][0] for e in group),
            max(by_end[e][1] for e in group),
            sum(by_end[e][2] for e in group),
        )

    for end in sorted(by_end):
        if group and end - group[-1] > RESET_MERGE_WINDOW:
            flush()
            group = []
        group.append(end)
    flush()
    return merged


def build_cycles(db, now):
    first_ts = db.execute("SELECT MIN(ts) FROM messages WHERE source = ?", (SOURCE_CLAUDE,)).fetchone()[0]
    sampled = {}
    for limit_id, resets_at, percent, last_ts, count in db.execute(
        "SELECT limit_id, resets_at, MAX(utilization), MAX(ts), COUNT(*) "
        "FROM limit_samples GROUP BY limit_id, resets_at"
    ):
        sampled.setdefault(limit_id, {})[resets_at] = (percent, last_ts, count)
    sampled = {limit_id: merge_close_ends(by_end) for limit_id, by_end in sampled.items()}

    cycles = {}
    for limit_id, by_end in sampled.items():
        ends = dict(by_end)
        if limit_id == WEEKLY_ALL:
            for end in inferred_weekly_ends(ends.keys(), first_ts):
                ends.setdefault(end, None)
        ordered = sorted(ends)
        if limit_id == SESSION:
            ordered = ordered[-1:]
        period = limit_period(limit_id)
        records = []
        previous_end = None
        for end in ordered:
            # A moved reset time would otherwise make two cycles overlap.
            start = max(end - period, previous_end or 0)
            previous_end = end
            sample = ends[end]
            percent, last_ts, count = sample if sample else (None, None, 0)
            records.append({
                "start": start,
                "end": end,
                "percent": percent,
                "samples": count,
                "last_sample": last_ts,
                "final": bool(last_ts and end <= now and last_ts >= end - FINAL_SAMPLE_WINDOW),
                "tokens": cycle_tokens(db, limit_id, start, min(end, now)),
            })
        cycles[limit_id] = records
    return cycles


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
        "cycles": build_cycles(db, int(time.time())),
    }
    temporary = STATS_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")))
    temporary.replace(STATS_PATH)


def write_cycles_csv(db, out_path):
    records = build_cycles(db, int(time.time())).get(WEEKLY_ALL, [])
    with open(out_path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["cycle_start", "cycle_end", "percent_used", "percent_final", "input",
                         "cache_write", "cache_read", "output", "total", "messages",
                         "tokens_per_percent"])
        for cycle in records:
            inp, cw, cr, out, messages = cycle["tokens"]
            total = inp + cw + cr + out
            percent = cycle["percent"]
            writer.writerow([
                time.strftime("%Y-%m-%dT%H:%M", time.localtime(cycle["start"])),
                time.strftime("%Y-%m-%dT%H:%M", time.localtime(cycle["end"])),
                "" if percent is None else percent,
                cycle["final"],
                inp, cw, cr, out, total, messages,
                round(total / percent) if percent else "",
            ])
    return len(records)


def write_csv(db, out_path, granularity):
    if granularity == "cycle":
        return write_cycles_csv(db, out_path)
    rows = sorted(aggregate(db, granularity).items())
    with open(out_path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["period", "source", "model", "input", "cache_write",
                         "cache_read", "output", "total", "messages"])
        for (period, source, model), (inp, cw, cr, out, messages) in rows:
            writer.writerow([period, source, model, inp, cw, cr, out,
                             inp + cw + cr + out, messages])
    return len(rows)


def migrate_legacy_db():
    """Copy an index left in the cache by older versions into DATA_DIR.

    The SQLite backup API carries any WAL content with it and the result is
    verified before it is published by an atomic rename. The legacy file is
    renamed, not deleted, so nothing is lost if an older process still has it.
    """
    if not LEGACY_DB_PATH.exists() or DB_PATH.exists():
        return
    temporary = DB_PATH.with_suffix(".migrating")
    temporary.unlink(missing_ok=True)
    source = sqlite3.connect(LEGACY_DB_PATH)
    target = sqlite3.connect(temporary)
    try:
        source.backup(target)
        if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise sqlite3.DatabaseError("migrated index failed quick_check")
    except sqlite3.Error:
        target.close()
        temporary.unlink(missing_ok=True)
        raise
    finally:
        source.close()
    target.close()
    temporary.replace(DB_PATH)
    LEGACY_DB_PATH.replace(LEGACY_DB_PATH.with_suffix(".sqlite.migrated"))


def daily_backup(db):
    """One consistent snapshot per day, so a bad release can never erase the history.

    Best effort: a failed snapshot (a full disk, say) must not stop the stats
    and export that follow it.
    """
    target = BACKUP_DIR / f"tokens-{time.strftime('%Y%m%d')}.sqlite"
    temporary = target.with_suffix(".tmp")
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temporary.unlink(missing_ok=True)
            db.execute("VACUUM INTO ?", (str(temporary),))
            temporary.replace(target)
        for old in sorted(BACKUP_DIR.glob("tokens-*.sqlite"))[:-BACKUP_KEEP]:
            old.unlink()
    except (OSError, sqlite3.Error) as error:
        with contextlib.suppress(OSError):
            temporary.unlink(missing_ok=True)
        print(f"warning: daily backup failed: {error}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Aggregate AI token usage from local transcripts.")
    parser.add_argument("--csv", metavar="PATH", help="export aggregated usage to a CSV file")
    parser.add_argument("--granularity", choices=[*GRANULARITY_FORMATS, "cycle"], default="day")
    args = parser.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        migrate_legacy_db()
        db = sqlite3.connect(DB_PATH)
        if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
            # Only the read offsets are reset. Stored messages and samples must
            # survive: their transcripts may already be pruned, and a full rescan
            # can only raise the kept values (see the upsert in scan_file).
            db.execute("DROP TABLE IF EXISTS files")
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        db.executescript(SCHEMA)
        scan(db)
        daily_backup(db)
        write_stats(db)
        if args.csv:
            count = write_csv(db, args.csv, args.granularity)
            print(f"{count} rows -> {args.csv}")
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
