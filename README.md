# AI Usage Limits — GNOME Shell Extension

A GNOME Shell extension that shows AI service usage limits in the panel, left of the clock. Currently supports Claude; Codex and Gemini support planned.

![AI Usage Limits — panel widget and popup showing current session and weekly usage](https://raw.githubusercontent.com/serboox/gnome-ai-usage/main/preview.png)

## Features

- **Cairo-drawn Claude starburst icon** in the panel
- **Horizontal progress bar** showing current session usage
- **Compact time display** — session % · reset countdown · weekly % · weekly reset countdown
  - Supports full range: `2mo5d` · `1d6h` · `3h54m` · `42m` · `↺`
- **Temporary boost chip** — a bolt plus `+50% · 16d` in the panel while a promotional limit boost is running, in a cool accent so it never reads as a warning
- **Today's token count** (`Σ257M`) in the panel, next to the limits
- **Popup on click** with two tabs: **LIMITS** (current session + weekly limits per model) and **TOKENS** (token history heatmap)
- **Auto-refresh** every 30 seconds from `~/.claude/usage.json`
- **Manual refresh button** (↺) in the popup
- Segmented neon bars; colors follow usage level: cyan (normal) → yellow (≥50%) → magenta (≥80%)

## Compatibility

Tested on **GNOME Shell 49.6** (Fedora, Wayland). The extension declares compatibility with GNOME Shell 45–49, but only 49.6 has been verified. Feedback on other versions is welcome.

## Requirements

- GNOME Shell 45–49
- [`fetch-usage.sh`](https://github.com/serboox/gnome-ai-usage/wiki) script that writes usage data to `~/.claude/usage.json`

## Installation

### Manual

```bash
git clone https://github.com/serboox/gnome-ai-usage.git \
  ~/.local/share/gnome-shell/extensions/ai-usage@serboox.github.io
gnome-extensions enable ai-usage@serboox.github.io
```

### Reload the extension after changes

```bash
gnome-extensions disable ai-usage@serboox.github.io
gnome-extensions enable ai-usage@serboox.github.io
```

Or press `Alt+F2`, type `r`, press Enter (X11 only; on Wayland, log out and back in).

## Usage data format

The extension reads `~/.claude/usage.json`. Expected structure:

```json
{
  "five_hour": {
    "utilization": 28.4,
    "resets_at": "2025-06-02T18:00:00Z"
  },
  "seven_day": {
    "utilization": 78.1,
    "resets_at": "2025-06-08T00:00:00Z"
  },
  "seven_day_sonnet": {
    "utilization": 45.0,
    "resets_at": "2025-06-08T00:00:00Z"
  }
}
```

## Temporary boosts

Anthropic occasionally raises limits for a while ("Your weekly Claude Code limit is 50%
higher through August 19"). No usage API reports these promotions — not the Claude Code
OAuth endpoint, not claude.ai's own `/api/organizations/<id>/usage`, not `/api/bootstrap`,
where the banner is frontend text behind a feature flag. So they are declared by hand in
`~/.claude/usage-boosts.json`:

```json
[
  {
    "label": "Claude Code weekly",
    "boost_percent": 50,
    "ends_at": "2026-08-19T23:59:59Z"
  },
  {
    "label": "Cowork 5-hour window",
    "boost_percent": 100,
    "ends_at": "2026-08-05T23:59:59Z"
  }
]
```

- `label` — free text, shown in the popup.
- `boost_percent` — number; rendered as `+50%`.
- `ends_at` — ISO timestamp. Entries drop off on their own once it passes; an entry with
  no parsable `ends_at` is treated as open-ended.
- Optional `note` — appended to the popup subtitle.

A `{"boosts": [...]}` wrapper works too. The panel chip shows the **first** active entry,
so keep the one you care about most at the top; the popup lists all of them. A missing or
malformed file simply means no boosts are shown.

## Token history

The **TOKENS** tab shows how many tokens were sent and received, built from the local
transcripts Claude Code and Codex already keep:

- `~/.claude/projects/**/*.jsonl` — every assistant response carries a `usage` block
  (input, cache write, cache read, output). A response is logged once per content block and
  rewritten while it streams, and resumed sessions copy earlier responses into a new file,
  so rows are keyed by message and request id and each field keeps its largest value.
- `~/.codex/sessions/**` and `~/.codex/archived_sessions/**` — `token_count` events hold a
  running total, so usage is the delta between consecutive totals. Codex reports cached
  input inside `input_tokens`; it is split out into the cache-read column.

The first scan reaches back as far as those transcripts do (Claude Code prunes old sessions
according to its `cleanupPeriodDays` setting). After that the index keeps every response it has
seen, even once its transcript is pruned, so the history keeps growing past the cleanup window.
A schema upgrade only forces a full rescan; it never drops stored rows.
Periods before the oldest indexed response are shown as empty "no signal" tiles rather than
zeros.

The index is long-lived user data, so it lives in `~/.local/share/ai-usage/tokens.sqlite`
(`$XDG_DATA_HOME`), not in the cache; an index left in `~/.cache/ai-usage/` by older versions
is copied there on the next scan (verified, then the old file is renamed to
`tokens.sqlite.migrated` and can be deleted). Once a day a consistent snapshot is written with
`VACUUM INTO` to `~/.local/share/ai-usage/backups/tokens-YYYYMMDD.sqlite`; the last 7 are kept.
Deleting the index rebuilds it only from the transcripts that still exist, so older history
would be lost — restore a snapshot instead.

Hours are local wall-clock hours: on a DST fall-back day the repeated hour is counted in one
tile, and the hour skipped in spring is shown as an empty tile.

`token-stats.py` does the parsing in a niced child process, never inside GNOME Shell. It is
incremental: the SQLite index remembers how far each file
was read, so a rescan only reads new lines (about half a second; the first full scan of a few
gigabytes takes several seconds). It writes hourly aggregates to
`~/.cache/ai-usage/token-stats.json`, which the extension reads. The scan runs on enable, every
5 minutes, when the tab is opened with stats older than a minute, and on the ↻ button.

Views:

| View  | Tiles                                                        | Click drills into |
|-------|--------------------------------------------------------------|-------------------|
| DAY   | 24 hours                                                     | —                 |
| WEEK  | 7 day totals + 4-hour blocks per day                         | day               |
| MONTH | calendar days + a weekly total column                        | day / week        |
| YEAR  | 12 months + a GitHub-style daily pulse strip                 | month / day       |
| YEARS | one tile per year + a year × month matrix                    | year / month      |

- Every tile shows its number and is colored on an 8-step heat scale. Each granularity has
  its own scale built from quantiles of all recorded periods, so a color means the same thing
  whichever month you look at; the warm colors are reserved for the top quarter.
- Metric chips switch what is counted: **ALL** (everything), **IN** (input + cache write +
  cache read), **OUT**, **NO CACHE** (input + output).
- Hovering a tile shows the breakdown by token type and model, its rank among all periods of
  that size, and how it compares with the average. The title (▴) climbs one level up; the
  mouse wheel over the grid pages through periods; **NOW** jumps back to the present.
- **EXPORT CSV** writes `~/Downloads/ai-tokens-<granularity>-<timestamp>.csv` with one row per
  period, source and model:
  `period,source,model,input,cache_write,cache_read,output,total,messages`.
  The same export works from a terminal:

  ```bash
  python3 token-stats.py --csv tokens.csv --granularity day   # hour|day|week|month|year
  ```

## Tokens per 1% of a limit and weekly cycles

Each limit row on the **LIMITS** tab shows how many tokens one percent of that limit cost in the
current window, e.g. `≈ 47.9M tokens per 1% · 4.41B this cycle`. The window is the 5 hours
(session) or 7 days (weekly) before `resets_at`; a model-scoped limit ("Fable only") counts only
that model family. Below 1% the integer utilization is too coarse, so nothing is shown.

**WEEKLY CYCLES** lists the last 8 weekly cycles: tokens spent, the share of the weekly limit
used, and tokens per 1%. Utilization history comes from two places, because no usage API keeps
one:

- the usage line the SessionStart hook writes into every transcript
  (`limit=seven_day, utilization=42%, resets in 7484 min (…)`), which reaches back as far as the
  transcripts do;
- `~/.claude/usage.json`, sampled on every scan from now on.

The percent is the highest value seen in the cycle. A finished cycle whose last sample landed more
than a day before its reset is shown as a lower bound (`≥91%`); a cycle with no sample at all has
its bounds inferred by stepping back 7 days from a known reset and shows tokens only. Tokens come
from this machine only, so usage on other devices or on claude.ai makes the real cost per percent
higher than shown. **EXPORT CSV › CYCLES** writes the same table with every token column.

Tests: `gjs -m tests/tokens.test.js` and `python3 -m unittest discover -s tests`.

## fetch-usage.sh

Place a script at `~/.claude/fetch-usage.sh` that fetches the usage data from the Claude API and writes it to `~/.claude/usage.json`. The extension calls this script when the manual refresh button is pressed.

## License

MIT
