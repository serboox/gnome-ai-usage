import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { TokenCalendar } from './calendar.js';
import { TokenIndex, GRAN_DAY, dayKey, formatTokens, formatCount, MONTH_NAMES } from './tokens.js';

const HOME        = GLib.get_home_dir();
const USAGE_PATH  = GLib.build_filenamev([HOME, '.claude', 'usage.json']);
const BOOSTS_PATH = GLib.build_filenamev([HOME, '.claude', 'usage-boosts.json']);
const FETCH_SCRIPT = GLib.build_filenamev([HOME, '.claude', 'fetch-usage.sh']);
const TOKEN_STATS_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ai-usage', 'token-stats.json']);
const TOKEN_SCRIPT_NAME = 'token-stats.py';

const POLL_INTERVAL = 10;     // seconds between file re-reads
const STALE_AFTER   = 150;    // seconds before the data is flagged as stale
const TOKEN_SCAN_INTERVAL = 300; // seconds between background transcript scans
const TOKEN_SCAN_ON_OPEN_AFTER = 60; // opening the tokens tab rescans older stats
const BAR_WIDTH     = 320;   // px, popup progress bar
const BAR_SEGMENTS  = 32;
const PANEL_BAR_SEGMENTS = 8;
const CLAUDE_COLOR  = '#D4875F';
const NEON_CYAN     = '#00F0FF';
const NEON_YELLOW   = '#FCEE0A';
const NEON_MAGENTA  = '#FF2A6D';
const BAR_TRACK     = '#151D2B';
// Green on purpose: severity runs cyan → yellow → magenta, so a boost can
// never be misread as a warning.
const BOOST_COLOR   = '#7CFF4F';

const TAB_LIMITS = 'limits';
const TAB_TOKENS = 'tokens';

// ── helpers ──────────────────────────────────────────────────────────────────

function readJson(path) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
        if (ok) return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {}
    return null;
}

// The fetcher writes the file; its mtime is when the data actually came from
// the API. Wall-clock read time would hide a dead fetcher behind a fresh label.
function fileMtime(path) {
    try {
        const info = Gio.File.new_for_path(path)
            .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const secs = info.get_attribute_uint64('time::modified');
        if (secs) return new Date(secs * 1000);
    } catch (_) {}
    return null;
}

function barColor(pct) {
    if (pct >= 80) return NEON_MAGENTA;
    if (pct >= 50) return NEON_YELLOW;
    return NEON_CYAN;
}

function fmt(val) {
    return (val === null || val === undefined) ? '—' : `${Math.round(val)}%`;
}

function titleCase(s) {
    return String(s ?? '')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
}

function limitLabel(item) {
    const model = item?.scope?.model?.display_name;
    if (item?.group === 'session') return 'Current session';
    if (item?.kind === 'weekly_all' || (item?.group === 'weekly' && !item?.scope))
        return 'All models';
    if (model) return `${model} only`;
    if (item?.kind) return titleCase(item.kind);
    return item?.scope ? 'Scoped' : 'Usage';
}

// Section heading for a limit group. Known groups keep their curated labels;
// any future group falls back to a title-cased "<Group> limits".
function sectionHeading(group) {
    if (group === 'session') return 'Current session';
    if (group === 'weekly')  return 'Weekly limits';
    const t = titleCase(group);
    return /limits?$/i.test(t) ? t : `${t} limits`;
}

// Normalize any usage payload into a flat list of limit descriptors.
// Prefers the server-driven `limits[]` array so new/removed models need no
// code change; falls back to the legacy named keys for older files.
function normalizeLimits(data) {
    if (!data) return [];

    if (Array.isArray(data.limits) && data.limits.length > 0) {
        return data.limits.map((item) => ({
            group:     item?.group ?? 'other',
            kind:      item?.kind ?? null,
            label:     limitLabel(item),
            percent:   Number.isFinite(item?.percent) ? item.percent : null,
            resets_at: item?.resets_at ?? null,
            severity:  item?.severity ?? 'normal',
            scoped:    Boolean(item?.scope),
        }));
    }

    const out = [];
    const push = (obj, group, kind, labelText, scoped) => {
        if (!obj) return;
        out.push({
            group,
            kind,
            label:     labelText,
            percent:   Number.isFinite(obj.utilization) ? obj.utilization : null,
            resets_at: obj.resets_at ?? null,
            severity:  'normal',
            scoped,
        });
    };
    push(data.five_hour,        'session', 'five_hour',        'Current session', false);
    push(data.seven_day,        'weekly',  'seven_day',        'All models',       false);
    push(data.seven_day_sonnet, 'weekly',  'seven_day_sonnet', 'Sonnet only',      true);
    push(data.seven_day_opus,   'weekly',  'seven_day_opus',   'Opus only',        true);
    return out;
}

// "2mo5d" / "1d6h" / "3h54m" / "42m" / "↺" for panel chip
function compactUntil(iso) {
    if (!iso) return '';
    const ms = new Date(iso) - new Date();
    if (!Number.isFinite(ms)) return '';
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

// "2 mo 5 d" / "1 d 6 hr" / "3 hr 54 min" / "42 min"
function formatDurationMin(totalMin) {
    const safeMin = Math.max(0, totalMin);
    const totalH  = Math.floor(safeMin / 60);
    const totalD  = Math.floor(totalH / 24);
    if (totalD >= 30) {
        const mo = Math.floor(totalD / 30);
        const rd = totalD % 30;
        return rd > 0 ? `${mo} mo ${rd} d` : `${mo} mo`;
    }
    if (totalD >= 1) {
        const rh = totalH % 24;
        return rh > 0 ? `${totalD} d ${rh} hr` : `${totalD} d`;
    }
    const h = totalH;
    const m = safeMin % 60;
    return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}

// "Resets in 2 mo 5 d" / "Resets in 1 d 6 hr" / "Resets in 3 hr 54 min" / "Resets in 42 min"
function humanUntil(iso) {
    if (!iso) return '';
    const ms = new Date(iso) - new Date();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'resetting soon';
    const totalMin = Math.floor(ms / 60_000);
    return `Resets in ${formatDurationMin(totalMin)}`;
}

// ── burn-rate projection ─────────────────────────────────────────────────────

const HISTORY_WINDOW_MIN  = 20;   // recent-rate lookback
const HISTORY_MAX_SAMPLES = 2000; // per-limit cap
const HISTORY_MAX_AGE_MS  = 8 * 24 * 60 * 60 * 1000;
const ROLLOVER_DROP_PCT   = 15;   // a drop this large means a new period started

// Stable id for a descriptor so its samples accumulate across polls.
function historyKey(item) {
    if (item.group === 'session') return 'session';
    if (item.group === 'weekly')
        return item.scoped ? `weekly:scoped:${item.label}` : 'weekly:all';
    return `${item.group}:${item.kind ?? item.label}`;
}

// Append a sample for `key`, starting a fresh bucket whenever the period
// clearly rolled over (percent dropped sharply, or resets_at moved).
function recordSample(history, key, percent, resetsAt, now) {
    let bucket = history.get(key);
    if (!bucket) {
        bucket = [];
        history.set(key, bucket);
    }

    const last = bucket[bucket.length - 1];
    const rolledOver = last && (
        percent < last.percent - ROLLOVER_DROP_PCT ||
        (resetsAt != null && last.resets_at != null && resetsAt !== last.resets_at)
    );
    if (rolledOver) bucket.length = 0;

    bucket.push({ t: now, percent, resets_at: resetsAt });

    const cutoff = now - HISTORY_MAX_AGE_MS;
    while (bucket.length && bucket[0].t < cutoff) bucket.shift();
    while (bucket.length > HISTORY_MAX_SAMPLES) bucket.shift();
}

// Percentage-points-per-minute over the whole recorded period, and over just
// the last HISTORY_WINDOW_MIN minutes (the more responsive of the two).
function computeRates(history) {
    if (!Array.isArray(history) || history.length < 2)
        return { recentRatePerMin: null, periodRatePerMin: null };

    const first = history[0];
    const last  = history[history.length - 1];
    const periodSpanMin = (last.t - first.t) / 60_000;
    const periodRatePerMin = periodSpanMin > 0
        ? (last.percent - first.percent) / periodSpanMin
        : null;

    const windowStart   = last.t - HISTORY_WINDOW_MIN * 60_000;
    const windowSamples = history.filter((s) => s.t >= windowStart);
    let recentRatePerMin = null;
    if (windowSamples.length >= 2) {
        const spanMin = (last.t - windowSamples[0].t) / 60_000;
        if (spanMin >= 2)
            recentRatePerMin = (last.percent - windowSamples[0].percent) / spanMin;
    }

    return { recentRatePerMin, periodRatePerMin };
}

function projectMinutesToExhaustion(percent, ratePerMin) {
    if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) return Infinity;
    return Math.max(0, (100 - percent) / ratePerMin);
}

// "Will run out in 55 min (speeding up)" / "On pace — lasts until reset" /
// "Steady — should last until reset" / "Gathering usage data…"
function burnRateMessage(item, history) {
    if (!Number.isFinite(item?.percent)) return 'Gathering usage data…';

    const { recentRatePerMin, periodRatePerMin } = computeRates(history);
    const effectiveRate = recentRatePerMin ?? periodRatePerMin ?? null;
    if (effectiveRate === null) return 'Gathering usage data…';

    const minsToExhaust = projectMinutesToExhaustion(item.percent, effectiveRate);

    let minsToReset = null;
    if (item.resets_at) {
        const ms = new Date(item.resets_at) - new Date();
        if (Number.isFinite(ms)) minsToReset = ms / 60_000;
    }

    let message;
    if (minsToExhaust === Infinity) {
        message = minsToReset !== null ? 'Steady — should last until reset' : 'Steady pace';
    } else if (minsToReset !== null && minsToExhaust >= minsToReset) {
        message = 'On pace — lasts until reset';
    } else {
        message = `Will run out in ${formatDurationMin(Math.round(minsToExhaust))}`;
    }

    if (recentRatePerMin != null && periodRatePerMin != null && periodRatePerMin > 0) {
        const ratio = recentRatePerMin / periodRatePerMin;
        if (ratio > 1.25) message += ' (speeding up)';
        else if (ratio < 0.75) message += ' (slowing down)';
    }

    return message;
}

// Convert a minor-unit integer amount (cents) into a "$708.71"-style string.
function formatMoney(amountMinor, exponent, currency) {
    if (!Number.isFinite(amountMinor)) return null;
    const exp    = Number.isFinite(exponent) ? exponent : 2;
    const amount = amountMinor / Math.pow(10, exp);
    const symbol = (currency ?? 'USD') === 'USD' ? '$' : `${currency ?? ''} `;
    return `${symbol}${amount.toFixed(exp)}`;
}

// Prefer the structured `spend.used` block; fall back to the legacy
// `extra_usage.used_credits` field (both are minor-unit amounts, e.g. cents).
function spentAmountText(d) {
    const spendUsed = d?.spend?.used;
    if (spendUsed && Number.isFinite(spendUsed.amount_minor))
        return formatMoney(spendUsed.amount_minor, spendUsed.exponent, spendUsed.currency);

    const extra = d?.extra_usage;
    if (extra && Number.isFinite(extra.used_credits))
        return formatMoney(extra.used_credits, extra.decimal_places, extra.currency);

    return null;
}

// ── promotional boosts ───────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Temporary limit promotions are absent from every usage API — neither the
// Claude Code OAuth endpoint nor claude.ai's own returns them, so they are
// declared by hand in usage-boosts.json instead.
// Accepts a bare array or {"boosts": [...]}; entries whose `ends_at` has
// passed are dropped, so a finished promotion disappears on its own.
// An entry with no parsable `ends_at` is treated as open-ended.
function readBoosts() {
    const raw  = readJson(BOOSTS_PATH);
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.boosts) ? raw.boosts : []);
    const now  = Date.now();

    return list
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => ({
            label:   String(entry.label ?? 'Usage'),
            percent: Number.isFinite(entry.boost_percent) ? entry.boost_percent : null,
            ends_at: entry.ends_at ?? null,
            note:    entry.note ? String(entry.note) : '',
        }))
        .filter((boost) => {
            const end = boost.ends_at ? new Date(boost.ends_at).getTime() : NaN;
            return Number.isFinite(end) ? end > now : true;
        });
}

function boostPercentText(boost) {
    return Number.isFinite(boost?.percent) ? `+${Math.round(boost.percent)}%` : '';
}

// "19 Aug"
function formatEndDate(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || !Number.isFinite(date.getTime())) return '';
    return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// "Ends in 16 d · 19 Aug" (plus the entry's own note, when present)
function boostSubtitle(boost) {
    const parts = [];
    const ms    = boost?.ends_at ? new Date(boost.ends_at) - new Date() : NaN;
    if (Number.isFinite(ms)) {
        parts.push(ms <= 0
            ? 'ending now'
            : `Ends in ${formatDurationMin(Math.floor(ms / 60_000))}`);
        const day = formatEndDate(boost.ends_at);
        if (day) parts.push(day);
    }
    if (boost?.note) parts.push(boost.note);
    return parts.join(' · ');
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

// ── boost bolt icon ───────────────────────────────────────────────────────────

// Bolt outline in a unit square, scaled to the requested size.
const BOLT_PATH = [
    [0.60, 0.00], [0.17, 0.57], [0.45, 0.57],
    [0.37, 1.00], [0.83, 0.41], [0.53, 0.41],
];

function makeBoltIcon(size, color = BOOST_COLOR) {
    const area = new St.DrawingArea({
        width: size,
        height: size,
        y_align: Clutter.ActorAlign.CENTER,
    });
    area.connect('repaint', (widget) => {
        const cr = widget.get_context();
        const [r, g, b] = hexToRgb(color);
        cr.setSourceRGBA(r, g, b, 1.0);

        cr.newPath();
        BOLT_PATH.forEach(([x, y], i) => {
            if (i === 0) cr.moveTo(x * size, y * size);
            else cr.lineTo(x * size, y * size);
        });
        cr.closePath();
        cr.fill();

        cr.$dispose();
    });
    return area;
}

// ── horizontal progress bar (Cairo) ──────────────────────────────────────────

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// Segmented "power cell" bar: whole segments light up, the partial one is
// drawn proportionally so small changes stay visible.
function makePanelBar(w, h, segments) {
    const area = new St.DrawingArea({
        width: w,
        height: h,
        y_align: Clutter.ActorAlign.CENTER,
    });
    area._pct   = 0;
    area._color = NEON_CYAN;

    area.connect('repaint', (widget) => {
        const cr   = widget.get_context();
        const gap  = segments >= 16 ? 3 : 1.5;
        const segW = (w - gap * (segments - 1)) / segments;
        const lit  = Math.max(0, Math.min(1, widget._pct / 100)) * segments;
        const [tr, tg, tb] = hexToRgb(BAR_TRACK);
        const [rr, gg, bb] = hexToRgb(widget._color);

        for (let i = 0; i < segments; i++) {
            const x = i * (segW + gap);
            cr.setSourceRGBA(tr, tg, tb, 1.0);
            cr.rectangle(x, 0, segW, h);
            cr.fill();

            const fraction = Math.max(0, Math.min(1, lit - i));
            if (fraction > 0) {
                cr.setSourceRGBA(rr, gg, bb, 1.0);
                cr.rectangle(x, 0, segW * fraction, h);
                cr.fill();
            }
        }

        cr.$dispose();
    });

    return area;
}

// ── popup helpers ─────────────────────────────────────────────────────────────

function label(text, styleClass, props = {}) {
    return new St.Label({ text, style_class: styleClass, ...props });
}

function hbox(styleClass = '', props = {}) {
    return new St.BoxLayout({ style_class: styleClass, ...props });
}

function vbox(styleClass = '', props = {}) {
    return new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: styleClass,
        ...props,
    });
}

function divider() {
    return new St.Widget({ style_class: 'aiu-divider', x_expand: true });
}

//   [Title            ]  [▮▮▮▮▮▮▯▯▯▯▯▯]  X% used
//   [Subtitle         ]
function progressRow(title, subtitle, pct, rightText) {
    const hasPct      = Number.isFinite(pct);
    const safe        = hasPct ? Math.min(100, Math.max(0, pct)) : 0;
    const color       = barColor(safe);
    const displayText = rightText !== undefined
        ? rightText
        : (hasPct ? `${Math.round(pct)}% used` : '—');

    const root = hbox('aiu-row');

    const left = vbox('', { x_expand: true });
    left.add_child(label(title, 'aiu-row-title'));
    if (subtitle)
        left.add_child(label(subtitle, 'aiu-row-sub'));
    root.add_child(left);

    const barArea = makePanelBar(BAR_WIDTH, 8, BAR_SEGMENTS);
    barArea._pct   = safe;
    barArea._color = color;

    const right = hbox('', { style: 'spacing: 12px;', y_align: Clutter.ActorAlign.CENTER });
    right.add_child(barArea);
    const value = label(displayText, 'aiu-row-value');
    value.style = `color: ${hasPct ? color : '#5b6b82'};`;
    right.add_child(value);
    root.add_child(right);

    return root;
}

// ── extension ─────────────────────────────────────────────────────────────────

// "8 Jul 2026"
function formatDay(date) {
    return `${date.getDate()} ${MONTH_NAMES[date.getMonth()].slice(0, 3)} ${date.getFullYear()}`;
}

function panelLabel(styleClass, text = '') {
    return new St.Label({
        text,
        style_class: `aiu-panel-mono ${styleClass}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export default class AiUsageExtension extends Extension {
    enable() {
        this._timer        = null;
        this._tokenTimer   = null;
        this._monitor      = null;
        this._monitorId    = null;
        this._data         = null;
        this._fetchedAt    = null;
        this._history      = new Map();
        this._tab          = TAB_LIMITS;
        this._tokenIndex   = null;
        this._tokenScanning = false;
        this._tokenError   = null;
        this._cancellable  = new Gio.Cancellable();
        this._tokenProcs   = new Set();
        this._calendar     = new TokenCalendar({
            onExport: (gran) => this._exportTokens(gran),
            onRescan: () => this._scanTokens(),
        });

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

        box.add_child(makeClaudeIcon(22));

        this._panelBar = makePanelBar(48, 6, PANEL_BAR_SEGMENTS);
        box.add_child(this._panelBar);

        this._sessionLabel    = panelLabel('', '…');
        this._timeLabel       = panelLabel('');
        this._weeklyLabel     = panelLabel('');
        this._weeklyTimeLabel = panelLabel('');
        for (const actor of [this._sessionLabel, this._timeLabel, this._weeklyLabel, this._weeklyTimeLabel])
            box.add_child(actor);

        // Promotional boost chip — stays hidden while no boost is active
        this._boostBox = new St.BoxLayout({ style: 'spacing: 4px; margin-left: 5px;', y_align: Clutter.ActorAlign.CENTER });
        this._boostBox.add_child(makeBoltIcon(13));
        // Countdown stays grey like the other two, so only the bolt carries
        // the accent colour
        this._boostTimeLabel = panelLabel('');
        this._boostTimeLabel.style = 'font-size: 13px; color: #aaaaaa;';
        this._boostBox.add_child(this._boostTimeLabel);
        this._boostBox.visible = false;
        box.add_child(this._boostBox);

        // Today's token count — hidden until the first transcript scan lands
        this._tokenLabel = panelLabel('aiu-panel-tokens');
        this._tokenLabel.visible = false;
        box.add_child(this._tokenLabel);

        this._tray.menu.actor.add_style_class_name('aiu-boxpointer');
        this._tray.menu.box.add_style_class_name('aiu-menu-box');

        // Create the menu item once; rebuild its content on each open
        this._menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._menuRoot = vbox('aiu-root');
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

        this._loadTokenStats();
        this._scanTokens();
        this._tokenTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TOKEN_SCAN_INTERVAL, () => {
            this._scanTokens();
            return GLib.SOURCE_CONTINUE;
        });

        // The poll only bounds how stale the display can get; the monitor makes
        // a new fetch show up at once, which is what matters at a reset.
        this._monitor = Gio.File.new_for_path(USAGE_PATH)
            .monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorId = this._monitor.connect('changed', (_m, _f, _o, event) => {
            if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                event === Gio.FileMonitorEvent.CREATED ||
                event === Gio.FileMonitorEvent.RENAMED) {
                this._refresh();
                this._rebuildLimitsIfOpen();
            }
        });
    }

    // Rebuilding the tokens tab on every usage.json write would reset the
    // hovered cell, so only the limits tab follows the fetcher live.
    _rebuildLimitsIfOpen() {
        if (this._tray?.menu?.isOpen && this._tab === TAB_LIMITS) this._buildPopup();
    }

    // ── data refresh ───────────────────────────────────────────────────────

    // Boosts live in their own file, so the chip updates even when usage data
    // is missing.
    _updateBoostChip() {
        if (!this._boostBox) return;

        const primary = readBoosts()[0] ?? null;
        this._boostBox.visible = primary !== null;

        const left = primary ? compactUntil(primary.ends_at) : '';
        this._boostTimeLabel.set_text(left);
    }

    _updateTokenChip() {
        if (!this._tokenLabel) return;
        const index = this._tokenIndex;
        this._tokenLabel.visible = index !== null;
        if (index)
            this._tokenLabel.set_text(`Σ${formatTokens(index.get(GRAN_DAY, dayKey(new Date())).total)}`);
    }

    _refresh() {
        this._updateBoostChip();
        this._updateTokenChip();

        const d = readJson(USAGE_PATH);
        if (d) {
            this._data      = d;
            this._fetchedAt = fileMtime(USAGE_PATH) ?? new Date();
        }

        if (!this._data) {
            this._panelBar._pct = 0;
            this._panelBar._color = BAR_TRACK;
            this._panelBar.queue_repaint();
            this._sessionLabel.set_text('—');
            this._sessionLabel.set_style('font-size: 14px; color: #444444;');
            this._timeLabel.set_text('');
            this._weeklyLabel.set_text('');
            this._weeklyTimeLabel.set_text('');
            return;
        }

        const limits = normalizeLimits(this._data);
        const now    = Date.now();
        for (const item of limits) {
            if (Number.isFinite(item.percent))
                recordSample(this._history, historyKey(item), item.percent, item.resets_at, now);
        }

        const sessionItem  = limits.find((l) => l.group === 'session');
        const allModels    = limits.find((l) => l.group === 'weekly' && !l.scoped);

        const session = sessionItem?.percent ?? null;
        const weekly  = allModels?.percent ?? null;
        const safe    = Math.min(100, Math.max(0, session ?? 0));
        const color   = barColor(session ?? 0);

        this._panelBar._pct   = safe;
        this._panelBar._color = color;
        this._panelBar.queue_repaint();

        this._sessionLabel.set_text(fmt(session));
        this._sessionLabel.set_style(`font-size: 14px; font-weight: bold; color: ${color};`);

        const t = compactUntil(sessionItem?.resets_at);
        this._timeLabel.set_text(t ? `· ${t} ·` : '·');
        this._timeLabel.set_style('font-size: 13px; color: #8a97ab;');

        this._weeklyLabel.set_text(allModels ? fmt(weekly) : '');
        this._weeklyLabel.set_style(`font-size: 14px; font-weight: bold; color: ${barColor(weekly ?? 0)};`);

        const tw = compactUntil(allModels?.resets_at);
        this._weeklyTimeLabel.set_text(tw ? `· ${tw}` : '');
        this._weeklyTimeLabel.set_style('font-size: 13px; color: #8a97ab;');
    }

    // ── token statistics ───────────────────────────────────────────────────

    // Parsing gigabytes of transcripts must never block the compositor, so it
    // runs in a niced child process that writes a small pre-aggregated JSON.
    _runTokenScript(args, onDone) {
        const python = GLib.find_program_in_path('python3');
        if (!python) {
            onDone(false, 'python3 not found');
            return;
        }
        const script = GLib.build_filenamev([this.path, TOKEN_SCRIPT_NAME]);
        // Bound to this enable() cycle: after disable() the callback must not
        // touch the state of a later enable().
        const cancellable = this._cancellable;
        let proc;
        try {
            proc = Gio.Subprocess.new(['nice', '-n', '15', python, script, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            onDone(false, e.message);
            return;
        }
        this._tokenProcs.add(proc);
        proc.communicate_utf8_async(null, cancellable, (source, result) => {
            this._tokenProcs?.delete(source);
            let ok = false;
            let output = '';
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                ok = source.get_successful();
                output = ok ? (stdout ?? '') : (stderr ?? '');
            } catch (e) {
                output = e.message;
            }
            if (cancellable.is_cancelled()) return;
            onDone(ok, output.trim().split('\n').pop() ?? '');
        });
    }

    _loadTokenStats(onLoaded = null) {
        const cancellable = this._cancellable;
        Gio.File.new_for_path(TOKEN_STATS_PATH).load_contents_async(cancellable, (file, result) => {
            if (cancellable.is_cancelled()) return;
            try {
                const [, bytes] = file.load_contents_finish(result);
                const raw = JSON.parse(new TextDecoder().decode(bytes));
                if (raw?.hours) this._tokenIndex = new TokenIndex(raw);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    this._tokenError = `bad stats file: ${e.message}`;
            }
            this._applyTokenStats();
            onLoaded?.();
        });
    }

    _applyTokenStats() {
        this._updateTokenChip();
        this._updateTokenStatus();
        if (this._tray?.menu?.isOpen && this._tab === TAB_TOKENS)
            this._calendar.setIndex(this._tokenIndex);
    }

    _updateTokenStatus() {
        const index = this._tokenIndex;
        if (this._tokenScanning) {
            this._calendar.setStatus('SCANNING TRANSCRIPTS…');
        } else if (this._tokenError) {
            this._calendar.setStatus(`SCAN FAILED · ${this._tokenError}`, true);
        } else if (index) {
            const since = index.firstDate ? ` since ${formatDay(index.firstDate)}` : '';
            this._calendar.setStatus(
                `${formatCount(index.messageCount)} responses${since} · synced ${timeAgo(index.generatedAt)}`);
        }
    }

    _scanTokens() {
        if (this._tokenScanning) return;
        this._tokenScanning = true;
        this._updateTokenStatus();
        this._runTokenScript([], (ok, message) => {
            this._tokenScanning = false;
            this._tokenError = ok ? null : (message || 'unknown error');
            this._loadTokenStats();
        });
    }

    _exportTokens(granularity) {
        const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? HOME;
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        const path = GLib.build_filenamev([dir, `ai-tokens-${granularity}-${stamp}.csv`]);
        const shown = path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;

        this._calendar.setStatus(`EXPORTING ${granularity.toUpperCase()}…`);
        this._runTokenScript(['--csv', path, '--granularity', granularity], (ok, message) => {
            if (ok) {
                this._calendar.setStatus(`SAVED → ${shown}`);
                Main.notify('AI Usage Limits', `Token usage (${granularity}) exported to ${shown}`);
                this._loadTokenStats(() => this._calendar.setStatus(`SAVED → ${shown}`));
            } else {
                this._calendar.setStatus(`EXPORT FAILED · ${message}`, true);
            }
        });
    }

    // ── popup ──────────────────────────────────────────────────────────────

    _buildHeader() {
        const header = hbox('aiu-header');
        const icon = makeClaudeIcon(20);
        header.add_child(icon);

        const title = hbox('', { style: 'spacing: 0;', y_align: Clutter.ActorAlign.CENTER });
        title.add_child(label('AI', 'aiu-title'));
        title.add_child(label('//', 'aiu-title-slash'));
        title.add_child(label('USAGE', 'aiu-title'));
        header.add_child(title);
        header.add_child(label('TEAM', 'aiu-tag', { y_align: Clutter.ActorAlign.CENTER }));

        header.add_child(new St.Widget({ x_expand: true }));

        const tabs = hbox('aiu-tabs', { y_align: Clutter.ActorAlign.CENTER });
        for (const [key, text] of [[TAB_LIMITS, 'LIMITS'], [TAB_TOKENS, 'TOKENS']]) {
            const tab = new St.Button({
                label: text,
                style_class: `aiu-tab${this._tab === key ? ' aiu-tab-active' : ''}`,
                can_focus: true,
                track_hover: true,
            });
            tab.connect('clicked', () => {
                if (this._tab === key) return;
                this._tab = key;
                this._buildPopup();
            });
            tabs.add_child(tab);
        }
        header.add_child(tabs);
        return header;
    }

    _buildPopup() {
        const calendarActor = this._calendar?.actor;
        calendarActor?.get_parent()?.remove_child(calendarActor);
        // Reuse the permanent menu item — only clear and refill its inner container
        this._menuRoot.destroy_all_children();
        const root = this._menuRoot;

        root.add_child(this._buildHeader());
        root.add_child(new St.Widget({ style_class: 'aiu-scanline', x_expand: true }));

        if (this._tab === TAB_TOKENS) {
            root.add_child(calendarActor);
            this._calendar.setIndex(this._tokenIndex);
            this._updateTokenStatus();
            const ageSec = this._tokenIndex?.generatedAt
                ? (Date.now() - this._tokenIndex.generatedAt.getTime()) / 1000 : Infinity;
            if (ageSec > TOKEN_SCAN_ON_OPEN_AFTER) this._scanTokens();
            return;
        }

        this._buildLimits(root);
    }

    _buildLimits(root) {
        // ── Temporary boosts ──────────────────────────────────────────────
        const boosts = readBoosts();
        if (boosts.length > 0) {
            const boostHeading = hbox('', { style: 'spacing: 8px;' });
            boostHeading.add_child(makeBoltIcon(14));
            boostHeading.add_child(label('TEMPORARY BOOSTS', 'aiu-section',
                { style: `color: ${BOOST_COLOR};`, x_expand: true }));
            root.add_child(boostHeading);

            for (const boost of boosts) {
                const row = hbox('aiu-row');

                const left = vbox('', { x_expand: true });
                left.add_child(label(boost.label, 'aiu-row-title'));
                const subtitle = boostSubtitle(boost);
                if (subtitle)
                    left.add_child(label(subtitle, 'aiu-row-sub'));
                row.add_child(left);

                const pct = boostPercentText(boost);
                if (pct)
                    row.add_child(label(pct, 'aiu-boost-value', { y_align: Clutter.ActorAlign.CENTER }));

                root.add_child(row);
            }

            root.add_child(label(
                "When each promotion ends, limits return to your plan's standard amounts.",
                'aiu-muted', { style: 'margin-bottom: 14px;' }));
            root.add_child(divider());
        }

        const d = this._data;
        if (!d) {
            root.add_child(label('NO SIGNAL — waiting for fetch-usage.sh', 'aiu-muted'));
            return;
        }

        const limits = normalizeLimits(d);

        // ── Extra usage spend ────────────────────────────────────────────
        const spentText = spentAmountText(d);
        if (spentText) {
            const spendRow = hbox('aiu-row');
            const spendLeft = vbox('', { x_expand: true });
            spendLeft.add_child(label('Extra usage spend', 'aiu-row-title'));
            spendLeft.add_child(label('Charged beyond your plan limits this cycle', 'aiu-row-sub'));
            spendRow.add_child(spendLeft);
            spendRow.add_child(label(spentText, 'aiu-money', { y_align: Clutter.ActorAlign.CENTER }));
            root.add_child(spendRow);
            root.add_child(divider());
        }

        // Group descriptors by `group`, preserving first-seen order,
        // then float the session group to the top.
        const byGroup = new Map();
        for (const item of limits) {
            const g = item.group ?? 'other';
            if (!byGroup.has(g)) byGroup.set(g, []);
            byGroup.get(g).push(item);
        }
        const seen = [...byGroup.keys()];
        const orderedGroups = [
            ...seen.filter((g) => g === 'session'),
            ...seen.filter((g) => g !== 'session'),
        ];

        for (const g of orderedGroups) {
            const items = byGroup.get(g);
            if (!items || items.length === 0) continue;

            root.add_child(label(sectionHeading(g).toUpperCase(), 'aiu-section'));

            for (const item of items) {
                const history = this._history.get(historyKey(item)) ?? [];
                root.add_child(progressRow(
                    item.label,
                    burnRateMessage(item, history),
                    item.percent,
                ));
            }
        }

        // ── Additional features ───────────────────────────────────────────
        if (d.daily_routines) {
            root.add_child(label('ADDITIONAL FEATURES', 'aiu-section aiu-section-magenta'));

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

        // ── Footer ────────────────────────────────────────────────────────
        root.add_child(divider());

        const footer = hbox('aiu-footer');
        const ageSec = this._fetchedAt
            ? (Date.now() - this._fetchedAt.getTime()) / 1000 : Infinity;
        const stale  = ageSec > STALE_AFTER;
        footer.add_child(label(
            `LAST SYNC ${timeAgo(this._fetchedAt).toUpperCase()}${stale ? ' · FETCHER STALLED' : ''}`,
            stale ? 'aiu-alert' : 'aiu-muted', { y_align: Clutter.ActorAlign.CENTER }));
        footer.add_child(new St.Widget({ x_expand: true }));
        const refreshBtn = new St.Button({
            label: '↻',
            style_class: 'aiu-icon-button',
            can_focus: true,
            track_hover: true,
        });
        refreshBtn.connect('clicked', () => {
            this._fetchNow();
            // Rebuild immediately so "Last updated" timestamp refreshes at once
            this._refresh();
            this._buildPopup();
        });
        footer.add_child(refreshBtn);
        root.add_child(footer);
    }

    _fetchNow() {
        try {
            const cancellable = this._cancellable;
            const proc = Gio.Subprocess.new(['/bin/bash', FETCH_SCRIPT], Gio.SubprocessFlags.NONE);
            proc.wait_async(cancellable, (source, result) => {
                try { source.wait_finish(result); } catch (_) {}
                if (cancellable.is_cancelled()) return;
                this._refresh();
                this._rebuildLimitsIfOpen();
            });
        } catch (_) {}
    }

    // ── cleanup ────────────────────────────────────────────────────────────

    disable() {
        for (const id of [this._timer, this._tokenTimer]) {
            if (id !== null) GLib.source_remove(id);
        }
        this._timer      = null;
        this._tokenTimer = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        // A scan left running would keep writing the shared index after disable().
        for (const proc of this._tokenProcs ?? []) proc.force_exit();
        this._tokenProcs = null;
        if (this._monitor) {
            if (this._monitorId) this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor   = null;
            this._monitorId = null;
        }
        this._calendar?.destroy();
        this._calendar      = null;
        this._tray?.destroy();
        this._tray          = null;
        this._menuItem      = null;
        this._menuRoot      = null;
        this._panelBar        = null;
        this._sessionLabel    = null;
        this._timeLabel       = null;
        this._weeklyLabel     = null;
        this._weeklyTimeLabel = null;
        this._boostBox        = null;
        this._boostTimeLabel  = null;
        this._tokenLabel      = null;
        this._tokenIndex      = null;
        this._data          = null;
        this._fetchedAt     = null;
        this._history       = null;
    }
}
