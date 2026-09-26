import csv
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "token-stats.py"


def claude_line(message_id, request_id, timestamp, usage, model="claude-opus-5"):
    return json.dumps({
        "type": "assistant",
        "timestamp": timestamp,
        "requestId": request_id,
        "message": {"id": message_id, "model": model, "usage": usage},
    }) + "\n"


def codex_token_line(timestamp, input_tokens, cached, output):
    return json.dumps({
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {"type": "token_count", "info": {"total_token_usage": {
            "input_tokens": input_tokens, "cached_input_tokens": cached,
            "cache_write_input_tokens": 0, "output_tokens": output,
            "total_tokens": input_tokens + output,
        }}},
    }) + "\n"


USAGE = {"input_tokens": 10, "cache_creation_input_tokens": 100,
         "cache_read_input_tokens": 1000, "output_tokens": 1}


class TokenStatsTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.projects = self.home / ".claude" / "projects" / "demo"
        self.projects.mkdir(parents=True)
        self.codex = self.home / ".codex" / "sessions" / "2026" / "09" / "24"
        self.codex.mkdir(parents=True)

    def tearDown(self):
        subprocess.run(["rm", "-rf", str(self.home)], check=True)

    def run_script(self, *args):
        env = dict(os.environ, HOME=str(self.home), TZ="UTC")
        env.pop("XDG_CACHE_HOME", None)
        env.pop("XDG_DATA_HOME", None)
        subprocess.run([sys.executable, str(SCRIPT), *args], env=env, check=True,
                       capture_output=True, text=True)
        return json.loads((self.home / ".cache" / "ai-usage" / "token-stats.json").read_text())

    def totals(self, stats):
        sums = [0, 0, 0, 0, 0]
        for models in stats["hours"].values():
            for values in models.values():
                sums = [a + b for a, b in zip(sums, values)]
        return sums

    def test_repeated_content_blocks_count_once(self):
        line = claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE)
        (self.projects / "a.jsonl").write_text(line * 3)
        self.assertEqual(self.totals(self.run_script()), [10, 100, 1000, 1, 1])

    def test_streaming_rewrites_keep_the_final_counts(self):
        partial = dict(USAGE, output_tokens=1)
        final = dict(USAGE, output_tokens=250)
        (self.projects / "a.jsonl").write_text(
            claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", partial) +
            claude_line("msg_1", "req_1", "2026-09-24T10:00:03Z", final))
        self.assertEqual(self.totals(self.run_script()), [10, 100, 1000, 250, 1])

    def test_resumed_session_copy_is_not_double_counted(self):
        line = claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE)
        (self.projects / "a.jsonl").write_text(line)
        (self.projects / "b.jsonl").write_text(line)
        self.assertEqual(self.run_script()["messages"], 1)

    def test_synthetic_replies_are_ignored(self):
        line = claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE, model="<synthetic>")
        (self.projects / "a.jsonl").write_text(line)
        self.assertEqual(self.run_script()["messages"], 0)

    def test_incremental_scan_waits_for_complete_lines(self):
        path = self.projects / "a.jsonl"
        full = claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE)
        second = claude_line("msg_2", "req_2", "2026-09-24T11:00:00Z", USAGE)
        path.write_text(full + second[:40])
        self.assertEqual(self.run_script()["messages"], 1)
        path.write_text(full + second)
        stats = self.run_script()
        self.assertEqual(stats["messages"], 2)
        self.assertEqual(sorted(stats["hours"]), ["2026-09-24T10", "2026-09-24T11"])

    def test_codex_uses_running_total_deltas(self):
        lines = [
            json.dumps({"type": "session_meta", "payload": {"id": "s1"}}) + "\n",
            json.dumps({"type": "turn_context", "payload": {"model": "gpt-test"}}) + "\n",
            codex_token_line("2026-09-24T10:00:00Z", 100, 60, 5),
            codex_token_line("2026-09-24T10:00:01Z", 100, 60, 5),
            codex_token_line("2026-09-24T10:05:00Z", 250, 160, 12),
        ]
        (self.codex / "rollout.jsonl").write_text("".join(lines))
        stats = self.run_script()
        # input excludes cached tokens: (100 - 60) + (150 - 100)
        self.assertEqual(self.totals(stats), [90, 0, 160, 12, 2])
        self.assertEqual(stats["models"], {"codex/gpt-test": {"source": "codex", "model": "gpt-test"}})

    def test_same_model_name_from_two_sources_is_not_merged(self):
        (self.projects / "a.jsonl").write_text(
            claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE, model="unknown"))
        (self.codex / "rollout.jsonl").write_text(codex_token_line("2026-09-24T10:00:00Z", 100, 60, 5))
        hour = self.run_script()["hours"]["2026-09-24T10"]
        self.assertEqual(sorted(hour), ["claude/unknown", "codex/unknown"])

    def hook_line(self, utilization, minutes, resets_at, limit="seven_day"):
        text = (f"Usage snapshot: limit={limit}, utilization={utilization}%, "
                f"resets in {minutes} min ({resets_at}).")
        return json.dumps({"type": "attachment", "attachment": {
            "type": "hook_additional_context", "hookEvent": "SessionStart", "content": [text],
        }}) + "\n"

    def test_quoted_usage_text_is_not_a_sample(self):
        text = "limit=seven_day, utilization=99%, resets in 60 min (2026-09-28T17:00:00Z)"
        (self.projects / "a.jsonl").write_text(
            json.dumps({"type": "user", "message": {"content": text}}) + "\n")
        self.assertEqual(self.run_script()["cycles"], {})

    def test_reset_drift_across_rounding_boundary_is_one_cycle(self):
        (self.projects / "a.jsonl").write_text(
            self.hook_line(40, 600, "2026-09-28T17:04:59Z") +
            self.hook_line(45, 300, "2026-09-28T17:05:01Z"))
        cycles = self.run_script()["cycles"]["weekly_all"]
        self.assertEqual([c["percent"] for c in cycles if c["percent"] is not None], [45.0])

    def test_scoped_hook_limit_maps_to_model_family(self):
        (self.projects / "a.jsonl").write_text(
            self.hook_line(10, 600, "2026-09-28T17:00:00Z", limit="seven_day_fable") +
            claude_line("msg_1", "req_1", "2026-09-26T10:00:00Z", USAGE, model="claude-fable-5-1") +
            claude_line("msg_2", "req_2", "2026-09-26T11:00:00Z", USAGE, model="claude-opus-5-5"))
        cycle = self.run_script()["cycles"]["weekly:fable"][-1]
        self.assertEqual(sum(cycle["tokens"][:4]), 1111)

    def test_legacy_usage_file_is_sampled(self):
        (self.home / ".claude").mkdir(exist_ok=True)
        (self.home / ".claude" / "usage.json").write_text(json.dumps(
            {"seven_day": {"utilization": 33, "resets_at": "2026-09-28T17:00:00Z"}}))
        self.assertEqual(self.run_script()["cycles"]["weekly_all"][-1]["percent"], 33.0)

    def test_weekly_cycles_come_from_hook_samples(self):
        (self.projects / "a.jsonl").write_text(
            self.hook_line(40, 60 * 24 * 3, "2026-09-28T17:00:00+00:00") +
            self.hook_line(80, 60, "2026-09-28T16:59:59.58+00:00") +
            claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE) +
            claude_line("msg_2", "req_2", "2026-09-20T10:00:00Z", USAGE))
        cycles = self.run_script()["cycles"]["weekly_all"]
        current = cycles[-1]
        self.assertEqual(current["end"], 1790614800)
        self.assertEqual(current["percent"], 80.0)
        self.assertEqual(current["samples"], 2)
        self.assertEqual(sum(current["tokens"][:4]), 1111)
        # the week before has no samples: its bounds are inferred, tokens still counted
        self.assertEqual(cycles[-2]["end"], 1790614800 - 7 * 86400)
        self.assertIsNone(cycles[-2]["percent"])
        self.assertEqual(sum(cycles[-2]["tokens"][:4]), 1111)

    def test_schema_upgrade_keeps_rows_of_pruned_transcripts(self):
        path = self.projects / "a.jsonl"
        path.write_text(claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE))
        self.run_script()
        path.unlink()
        db = sqlite3.connect(self.home / ".local" / "share" / "ai-usage" / "tokens.sqlite")
        db.execute("PRAGMA user_version = 0")
        db.commit()
        db.close()
        self.assertEqual(self.run_script()["messages"], 1)

    def test_index_moves_out_of_the_cache_and_is_backed_up(self):
        (self.projects / "a.jsonl").write_text(claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE))
        self.run_script()
        data = self.home / ".local" / "share" / "ai-usage"
        cache = self.home / ".cache" / "ai-usage"
        (data / "tokens.sqlite").rename(cache / "tokens.sqlite")
        (self.projects / "a.jsonl").unlink()
        self.assertEqual(self.run_script()["messages"], 1)
        self.assertFalse((cache / "tokens.sqlite").exists())
        self.assertTrue((cache / "tokens.sqlite.migrated").exists())
        self.assertEqual(len(list((data / "backups").glob("tokens-*.sqlite"))), 1)

    def test_failed_backup_still_writes_stats(self):
        (self.projects / "a.jsonl").write_text(claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE))
        backups = self.home / ".local" / "share" / "ai-usage" / "backups"
        backups.parent.mkdir(parents=True)
        backups.write_text("a file where the backup directory should be")
        self.assertEqual(self.run_script()["messages"], 1)

    def test_csv_export_matches_totals(self):
        (self.projects / "a.jsonl").write_text(
            claude_line("msg_1", "req_1", "2026-09-24T10:00:00Z", USAGE) +
            claude_line("msg_2", "req_2", "2026-09-25T10:00:00Z", USAGE, model="claude-sonnet-5"))
        out = self.home / "out.csv"
        self.run_script("--csv", str(out), "--granularity", "week")
        rows = list(csv.DictReader(out.open()))
        self.assertEqual({row["period"] for row in rows}, {"2026-W39"})
        self.assertEqual(sum(int(row["total"]) for row in rows), 2 * 1111)


if __name__ == "__main__":
    unittest.main()
