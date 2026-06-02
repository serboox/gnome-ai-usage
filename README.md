# AI Usage Limits — GNOME Shell Extension

A GNOME Shell extension that shows AI service usage limits in the panel, left of the clock. Currently supports Claude; Codex and Gemini support planned.

![AI Usage Limits — panel widget and popup showing current session and weekly usage](https://raw.githubusercontent.com/serboox/gnome-ai-usage/main/preview.png)

## Features

- **Cairo-drawn Claude starburst icon** in the panel
- **Horizontal progress bar** showing current session usage
- **Compact time display** — session % · reset countdown · weekly % · weekly reset countdown
  - Supports full range: `2mo5d` · `1d6h` · `3h54m` · `42m` · `↺`
- **Popup on click** with full usage breakdown (current session + weekly limits per model)
- **Auto-refresh** every 30 seconds from `~/.claude/usage.json`
- **Manual refresh button** (↺) in the popup
- Colors follow usage level: orange (normal) → yellow (≥50%) → red (≥80%)

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

## fetch-usage.sh

Place a script at `~/.claude/fetch-usage.sh` that fetches the usage data from the Claude API and writes it to `~/.claude/usage.json`. The extension calls this script when the manual refresh button is pressed.

## License

MIT
