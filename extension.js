import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HOME        = GLib.get_home_dir();
const USAGE_PATH  = GLib.build_filenamev([HOME, '.claude', 'usage.json']);
const FETCH_SCRIPT = GLib.build_filenamev([HOME, '.claude', 'fetch-usage.sh']);

const POLL_INTERVAL = 30;     // seconds between file re-reads
const BAR_WIDTH     = 320;   // px, popup progress bar
const CLAUDE_COLOR  = '#D4875F';

// ── helpers ──────────────────────────────────────────────────────────────────

function readJson(path) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
        if (ok) return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {}
    return null;
}

function barColor(pct) {
    if (pct >= 80) return '#ef5350';
    if (pct >= 50) return '#ffb300';
    return CLAUDE_COLOR;
}

function fmt(val) {
    return (val === null || val === undefined) ? '—' : `${Math.round(val)}%`;
}

// "2mo5d" / "1d6h" / "3h54m" / "42m" / "↺" for panel chip
function compactUntil(iso) {
    if (!iso) return '';
    const ms = new Date(iso) - new Date();
    if (ms <= 0) return '↺';
    const totalMin = Math.floor(ms / 60_000);
    const totalH   = Math.floor(totalMin / 60);
    const totalD   = Math.floor(totalH / 24);
    if (totalD >= 30) {
        const mo = Math.floor(totalD / 30);
        const rd = totalD % 30;
        return rd > 0 ? `${mo}mo${rd}d` : `${mo}mo`;
    }
    if (totalD >= 1) {
        const rh = totalH % 24;
        return rh > 0 ? `${totalD}d${rh}h` : `${totalD}d`;
    }
    const h = totalH;
    const m = totalMin % 60;
    return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// "Resets in 2 mo 5 d" / "Resets in 1 d 6 hr" / "Resets in 3 hr 54 min" / "Resets in 42 min" for popup
function humanUntil(iso) {
    if (!iso) return '';
    const ms = new Date(iso) - new Date();
    if (ms <= 0) return 'resetting soon';
    const totalMin = Math.floor(ms / 60_000);
    const totalH   = Math.floor(totalMin / 60);
    const totalD   = Math.floor(totalH / 24);
    if (totalD >= 30) {
        const mo = Math.floor(totalD / 30);
        const rd = totalD % 30;
        return rd > 0 ? `Resets in ${mo} mo ${rd} d` : `Resets in ${mo} mo`;
    }
    if (totalD >= 1) {
        const rh = totalH % 24;
        return rh > 0 ? `Resets in ${totalD} d ${rh} hr` : `Resets in ${totalD} d`;
    }
    const h = totalH;
    const m = totalMin % 60;
    return h > 0 ? `Resets in ${h} hr ${m} min` : `Resets in ${m} min`;
}

function timeAgo(date) {
    if (!date) return 'never';
    const s = Math.round((new Date() - date) / 1000);
    if (s < 15) return 'just now';
    if (s < 60) return `${s} sec ago`;
    return `${Math.round(s / 60)} min ago`;
}

// ── Claude starburst icon ─────────────────────────────────────────────────────

function makeClaudeIcon(size) {
    const area = new St.DrawingArea({
        width: size,
        height: size,
        y_align: Clutter.ActorAlign.CENTER,
    });
    area.connect('repaint', (widget) => {
        const cr = widget.get_context();
        cr.translate(size / 2, size / 2);
        const [ir, ig, ib] = hexToRgb(CLAUDE_COLOR);
        cr.setSourceRGBA(ir, ig, ib, 1.0);

        const n  = 12;
        const hw = size * 0.065;   // petal half-width
        const ty = -size * 0.44;   // petal top (from center)
        const by =  size * 0.065;  // petal bottom (from center, extends past center)
        const ph = by - ty;        // petal height
        const r  = hw;             // corner radius = half-width → rounded caps

        for (let i = 0; i < n; i++) {
            cr.save();
            cr.rotate((i / n) * 2 * Math.PI);

            const x = -hw, y = ty, w = hw * 2, h = ph;
            cr.newPath();
            cr.moveTo(x + r, y);
            cr.lineTo(x + w - r, y);
            cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
            cr.lineTo(x + w, y + h - r);
            cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
            cr.lineTo(x + r, y + h);
            cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
            cr.lineTo(x, y + r);
            cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
            cr.closePath();
            cr.fill();

            cr.restore();
        }

        cr.$dispose();
    });
    return area;
}

// ── horizontal progress bar (Cairo) ──────────────────────────────────────────

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function makePanelBar(w, h) {
    const area = new St.DrawingArea({
        width: w,
        height: h,
        y_align: Clutter.ActorAlign.CENTER,
    });
    area._pct   = 0;
    area._color = CLAUDE_COLOR;

    area.connect('repaint', (widget) => {
        const cr  = widget.get_context();
        const r   = h / 2;   // corner radius = half height → pill shape

        // Background track
        cr.setSourceRGBA(0.2, 0.2, 0.2, 1.0);
        _roundedRect(cr, 0, 0, w, h, r);
        cr.fill();

        // Filled portion
        const fill = Math.max(0, Math.min(1, widget._pct / 100)) * w;
        if (fill > 0) {
            const [rr, gg, bb] = hexToRgb(widget._color);
            cr.setSourceRGBA(rr, gg, bb, 1.0);
            _roundedRect(cr, 0, 0, fill, h, Math.min(r, fill / 2));
            cr.fill();
        }

        cr.$dispose();
    });

    return area;
}

function _roundedRect(cr, x, y, w, h, r) {
    cr.newPath();
    cr.moveTo(x + r, y);
    cr.lineTo(x + w - r, y);
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.lineTo(x + w, y + h - r);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.lineTo(x + r, y + h);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.lineTo(x, y + r);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// ── popup helpers ─────────────────────────────────────────────────────────────

function label(text, style) {
    return new St.Label({ text, style });
}

function hbox(style = '') {
    return new St.BoxLayout({ style });
}

function vbox(style = '') {
    return new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style,
    });
}

// Layout matches the Claude.ai usage page:
//   [Title            ]  [======-------]  X% used
//   [Resets in X hr Y ]
function progressRow(title, subtitle, pct, rightText) {
    const color       = barColor(pct);
    const safe        = Math.min(100, Math.max(0, pct));
    const displayText = rightText !== undefined ? rightText : `${Math.round(pct)}% used`;

    const root = hbox('margin-bottom: 22px; spacing: 16px;');

    const left = vbox('');
    left.x_expand = true;
    left.add_child(label(title, 'font-size: 15px; color: #ffffff;'));
    if (subtitle)
        left.add_child(label(subtitle, 'font-size: 13px; color: #cccccc; margin-top: 4px;'));
    root.add_child(left);

    const barArea = makePanelBar(BAR_WIDTH, 7);
    barArea._pct   = safe;
    barArea._color = color;

    const right = hbox('spacing: 12px;');
    right.y_align = Clutter.ActorAlign.CENTER;
    right.add_child(barArea);
    right.add_child(label(displayText, 'font-size: 13px; color: #cccccc; min-width: 72px;'));
    root.add_child(right);

    return root;
}

// ── extension ─────────────────────────────────────────────────────────────────

export default class AiUsageExtension extends Extension {
    enable() {
        this._timer     = null;
        this._data      = null;
        this._fetchedAt = null;

        // Panel button — mirrors system-monitor-next pattern:
        // add to panel first, then attach children
        this._tray = new PanelMenu.Button(0.5);
        // Add to the right end of the left box so the clock stays centered
        Main.panel._addToPanelBox('claude-usage', this._tray, -1, Main.panel._leftBox);

        const box = new St.BoxLayout({
            style: 'spacing: 7px; padding: 0 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tray.add_child(box);

        // Claude starburst icon (Cairo-drawn, 22 × 22 px)
        box.add_child(makeClaudeIcon(22));

        // Horizontal session progress bar (Cairo-drawn, 48 × 5 px)
        this._panelBar = makePanelBar(48, 5);
        box.add_child(this._panelBar);

        // Session percentage
        this._sessionLabel = new St.Label({
            text: '…',
            style: 'font-size: 14px; color: #aaaaaa;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._sessionLabel);

        // Session reset countdown — shown between the two numbers
        this._timeLabel = new St.Label({
            text: '',
            style: 'font-size: 13px; color: #aaaaaa;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._timeLabel);

        // Weekly percentage
        this._weeklyLabel = new St.Label({
            text: '',
            style: 'font-size: 14px; color: #aaaaaa;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._weeklyLabel);

        // Weekly reset countdown
        this._weeklyTimeLabel = new St.Label({
            text: '',
            style: 'font-size: 13px; color: #aaaaaa;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._weeklyTimeLabel);

        // Create the menu item once; rebuild its content on each open
        this._menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._menuRoot = vbox('min-width: 600px; padding: 16px 16px 12px 16px;');
        this._menuItem.add_child(this._menuRoot);
        this._tray.menu.addMenuItem(this._menuItem);

        Main.panel.menuManager.addMenu(this._tray.menu);
        this._tray.menu.connect('open-state-changed', (_m, open) => {
            if (open) this._buildPopup();
        });

        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ── data refresh ───────────────────────────────────────────────────────

    _refresh() {
        const d = readJson(USAGE_PATH);
        if (d) {
            this._data      = d;
            this._fetchedAt = new Date();
        }

        if (!this._data) {
            this._panelBar._pct = 0;
            this._panelBar._color = '#333333';
            this._panelBar.queue_repaint();
            this._sessionLabel.set_text('—');
            this._sessionLabel.set_style('font-size: 14px; color: #444444;');
            this._timeLabel.set_text('');
            this._weeklyLabel.set_text('');
            this._weeklyTimeLabel.set_text('');
            return;
        }

        const session = this._data.five_hour?.utilization ?? 0;
        const weekly  = this._data.seven_day?.utilization ?? 0;
        const safe    = Math.min(100, Math.max(0, session));
        const color   = barColor(session);

        this._panelBar._pct   = safe;
        this._panelBar._color = color;
        this._panelBar.queue_repaint();

        this._sessionLabel.set_text(fmt(session));
        this._sessionLabel.set_style(`font-size: 14px; color: ${color};`);

        const t = compactUntil(this._data.five_hour?.resets_at);
        this._timeLabel.set_text(t ? `· ${t} ·` : '·');
        this._timeLabel.set_style('font-size: 13px; color: #aaaaaa;');

        this._weeklyLabel.set_text(fmt(weekly));
        this._weeklyLabel.set_style(`font-size: 14px; color: ${barColor(weekly)};`);

        const tw = compactUntil(this._data.seven_day?.resets_at);
        this._weeklyTimeLabel.set_text(tw ? `· ${tw}` : '');
        this._weeklyTimeLabel.set_style('font-size: 13px; color: #aaaaaa;');
    }

    // ── popup ──────────────────────────────────────────────────────────────

    _buildPopup() {
        // Reuse the permanent menu item — only clear and refill its inner container
        this._menuRoot.destroy_all_children();
        const root = this._menuRoot;

        // ── Header ────────────────────────────────────────────────────────
        const header = hbox('margin-bottom: 24px; spacing: 10px;');
        header.add_child(label('Your usage limits',
            'font-size: 17px; font-weight: bold; color: #ffffff;'));
        header.add_child(label('Team',
            'font-size: 15px; color: #cccccc;'));
        root.add_child(header);

        const d = this._data;
        if (!d) {
            root.add_child(label('No data yet — waiting for fetch-usage.sh',
                'font-size: 13px; color: #aaaaaa;'));
        } else {
            // ── Current session ───────────────────────────────────────────
            root.add_child(progressRow(
                'Current session',
                humanUntil(d.five_hour?.resets_at),
                d.five_hour?.utilization ?? 0,
            ));

            // ── Weekly limits ─────────────────────────────────────────────
            root.add_child(label('Weekly limits',
                'font-size: 16px; font-weight: bold; color: #ffffff; margin-bottom: 18px; margin-top: 6px;'));

            root.add_child(progressRow(
                'All models',
                humanUntil(d.seven_day?.resets_at),
                d.seven_day?.utilization ?? 0,
            ));

            if (d.seven_day_sonnet) {
                root.add_child(progressRow(
                    'Sonnet only',
                    humanUntil(d.seven_day_sonnet?.resets_at),
                    d.seven_day_sonnet?.utilization ?? 0,
                ));
            }

            // ── Footer ────────────────────────────────────────────────────
            root.add_child(new St.Widget({
                style: 'height: 1px; background-color: #2a2a2a; margin-top: 4px; margin-bottom: 12px;',
                x_expand: true,
            }));

            const footer = hbox('spacing: 8px;');
            footer.add_child(label(
                `Last updated: ${timeAgo(this._fetchedAt)}`,
                'font-size: 13px; color: #bbbbbb;',
            ));
            const refreshBtn = label('↺', 'font-size: 16px; color: #aaaaaa;');
            refreshBtn.reactive    = true;
            refreshBtn.track_hover = true;
            refreshBtn.connect('notify::hover', () => {
                refreshBtn.set_style(
                    `font-size: 16px; color: ${refreshBtn.hover ? '#cccccc' : '#666666'};`
                );
            });
            refreshBtn.connect('button-press-event', () => {
                this._fetchNow();
                // Rebuild immediately so "Last updated" timestamp refreshes at once
                this._refresh();
                this._buildPopup();
                return Clutter.EVENT_STOP;
            });
            footer.add_child(refreshBtn);
            root.add_child(footer);

            // ── Additional features ───────────────────────────────────────
            if (d.daily_routines) {
                root.add_child(new St.Widget({
                    style: 'height: 1px; background-color: #2a2a2a; margin-top: 12px; margin-bottom: 16px;',
                    x_expand: true,
                }));
                root.add_child(label('Additional features',
                    'font-size: 15px; font-weight: bold; color: #eeeeee; margin-bottom: 18px;'));

                const used  = d.daily_routines.used  ?? 0;
                const limit = d.daily_routines.limit ?? 25;
                const pct   = limit > 0 ? (used / limit) * 100 : 0;
                root.add_child(progressRow(
                    'Daily included routine runs',
                    d.daily_routines.subtitle ?? '',
                    pct,
                    `${used} / ${limit}`,
                ));
            }
        }

    }

    _fetchNow() {
        try {
            const proc = Gio.Subprocess.new(['/bin/bash', FETCH_SCRIPT], Gio.SubprocessFlags.NONE);
            proc.wait_async(null, (source, result) => {
                try { source.wait_finish(result); } catch (_) {}
                this._refresh();
                if (this._tray?.menu?.isOpen) this._buildPopup();
            });
        } catch (_) {}
    }

    // ── cleanup ────────────────────────────────────────────────────────────

    disable() {
        if (this._timer !== null) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        this._tray?.destroy();
        this._tray          = null;
        this._menuItem      = null;
        this._menuRoot      = null;
        this._panelBar        = null;
        this._sessionLabel    = null;
        this._timeLabel       = null;
        this._weeklyLabel     = null;
        this._weeklyTimeLabel = null;
        this._data          = null;
        this._fetchedAt     = null;
    }
}
