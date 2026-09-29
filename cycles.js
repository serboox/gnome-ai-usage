import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as T from './tokens.js';
import { severityColor } from './colors.js';

const METER_WIDTH = 170;
const LIST_MAX_HEIGHT = 250;
const SHORT_MONTHS = T.MONTH_NAMES.map((m) => m.slice(0, 3));

const COLUMNS = [
    { title: 'WK',           width: 40 },
    { title: 'PERIOD',       width: 150 },
    { title: 'WEEKLY LIMIT', width: METER_WIDTH + 60 },
    { title: 'TOKENS',       width: 80, right: true },
    { title: 'PER 1%',       width: 80, right: true },
    { title: 'STATE',        width: 130 },
];

function label(text, styleClass, props = {}) {
    return new St.Label({ text, style_class: styleClass, ...props });
}

function hbox(styleClass = '', props = {}) {
    return new St.BoxLayout({ style_class: styleClass, ...props });
}

function vbox(styleClass = '', props = {}) {
    return new St.BoxLayout({ style_class: styleClass, orientation: Clutter.Orientation.VERTICAL, ...props });
}

function shortDay(date) {
    return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`.toUpperCase();
}

function percentText(cycle, current) {
    if (!Number.isFinite(cycle.percent)) return '?';
    // A finished cycle whose last sample came well before the reset may have ended higher.
    const lowerBound = !current && !cycle.final;
    return `${lowerBound ? '≥' : ''}${Math.round(cycle.percent)}%`;
}

function cycleState(cycle, current) {
    if (!Number.isFinite(cycle.percent)) return 'NO READING';
    if (current) return 'IN PROGRESS';
    if (cycle.final) return 'FINAL';
    return `SEEN ${shortDay(new Date(cycle.last_sample * 1000))}`;
}

function cell(text, styleClass, column) {
    const props = { width: column.width, y_align: Clutter.ActorAlign.CENTER };
    if (column.right) props.style = 'text-align: right;';
    return label(text, styleClass, props);
}

// Weekly limit history as a scrollable list, newest cycle first, one page per year.
export class CycleCalendar {
    constructor() {
        this._year = new Date().getFullYear();
    }

    build(index) {
        this._index = index;
        const cycles = index?.cycles(T.LIMIT_WEEKLY_ALL) ?? [];
        const root = vbox('aiu-cycles');
        if (cycles.length === 0) return root;

        const byYear = new Map();
        for (const cycle of cycles) {
            const year = T.gridYear(new Date(cycle.start * 1000));
            if (!byYear.has(year)) byYear.set(year, []);
            byYear.get(year).push(cycle);
        }
        const years = [...byYear.keys(), new Date().getFullYear()].filter((y, i, a) => a.indexOf(y) === i).sort();
        if (!years.includes(this._year)) this._year = years[years.length - 1];

        const nowSec = Date.now() / 1000;
        const yearCycles = byYear.get(this._year) ?? [];
        this._root = root;
        this._default = yearCycles.find((c) => c.start <= nowSec && nowSec < c.end) ?? yearCycles[yearCycles.length - 1] ?? null;

        root.add_child(this._buildNav(years, yearCycles));
        root.add_child(this._buildList(yearCycles, nowSec));
        this._detail = vbox('aiu-cycle-detail');
        root.add_child(this._detail);
        this._showDetail(this._default, nowSec);
        return root;
    }

    _showYear(year) {
        this._year = year;
        // build() replaces this._root, so the attached actor is captured first.
        const oldRoot = this._root;
        const parent = oldRoot.get_parent();
        const fresh = this.build(this._index);
        if (parent) parent.replace_child(oldRoot, fresh);
    }

    _buildNav(years, yearCycles) {
        const nav = vbox('aiu-cycles-nav');
        const row = hbox('aiu-nav');
        const position = years.indexOf(this._year);
        const arrow = (text, delta) => {
            const btn = new St.Button({ label: text, style_class: 'aiu-nav-arrow', track_hover: true });
            const target = position + delta;
            btn.reactive = target >= 0 && target < years.length;
            btn.connect('clicked', () => this._showYear(years[target]));
            return btn;
        };
        // Expanding keeps the tracked heading from being ellipsized.
        row.add_child(label('WEEKLY CYCLES', 'aiu-section aiu-section-magenta',
            { x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        const known = yearCycles.filter((c) => Number.isFinite(c.percent));
        const average = known.length ? known.reduce((sum, c) => sum + c.percent, 0) / known.length : null;
        const total = yearCycles.reduce((sum, c) => sum + T.sumTokens(c.tokens), 0);
        const cycleWord = yearCycles.length === 1 ? 'cycle' : 'cycles';
        const summary = `${yearCycles.length} ${cycleWord}${average === null ? '' : ` · avg ${Math.round(average)}%`} · ${T.formatTokens(total)}`;
        // The summary sits left of the arrows, so paging never moves the arrows.
        row.add_child(label(summary, 'aiu-nav-total', { y_align: Clutter.ActorAlign.CENTER, style: 'margin-right: 12px;' }));
        row.add_child(arrow('‹', -1));
        row.add_child(label(`${this._year}`, 'aiu-nav-title', { y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(arrow('›', 1));
        nav.add_child(row);

        if (years.length > 1) {
            const picker = hbox('aiu-toolbar');
            picker.add_child(label('YEAR', 'aiu-card-label', { y_align: Clutter.ActorAlign.CENTER, style: 'margin-right: 4px;' }));
            for (const year of years) {
                const chip = new St.Button({
                    label: `${year}`,
                    style_class: `aiu-chip${year === this._year ? ' aiu-chip-active' : ''}`,
                    track_hover: true,
                });
                chip.connect('clicked', () => {
                    if (year !== this._year) this._showYear(year);
                });
                picker.add_child(chip);
            }
            nav.add_child(picker);
        }
        return nav;
    }

    _buildList(yearCycles, nowSec) {
        const wrap = vbox('aiu-cycle-table');
        const head = hbox('aiu-cycle-row aiu-cycle-head');
        for (const column of COLUMNS) head.add_child(cell(column.title, 'aiu-cycle-colhead', column));
        wrap.add_child(head);

        const list = vbox('aiu-cycle-list');
        if (yearCycles.length === 0)
            list.add_child(label('No weekly cycles recorded in this year.', 'aiu-muted', { style: 'padding: 8px 10px;' }));
        const base = T.yearSlots(this._year).base;
        for (const cycle of [...yearCycles].reverse())
            list.add_child(this._row(cycle, base, nowSec));

        const scroll = new St.ScrollView({
            style_class: 'aiu-cycle-scroll',
            style: `max-height: ${LIST_MAX_HEIGHT}px;`,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false,
            x_expand: true,
        });
        scroll.set_child(list);
        wrap.add_child(scroll);
        return wrap;
    }

    _row(cycle, base, nowSec) {
        const current = cycle.start <= nowSec && nowSec < cycle.end;
        const start = new Date(cycle.start * 1000);
        const end = new Date(cycle.end * 1000);
        const total = T.sumTokens(cycle.tokens);
        const rate = T.tokensPerPercent(total, cycle.percent);
        const known = Number.isFinite(cycle.percent);
        const [week, period, limit, tokens, perPercent, state] = COLUMNS;

        const row = hbox('aiu-cycle-row', { x_expand: true });
        row.add_child(cell(`W${String(T.slotOf(start, base) + 1).padStart(2, '0')}`, 'aiu-cycle-week', week));
        row.add_child(cell(`${shortDay(start)} – ${shortDay(end)}`, 'aiu-cycle-period', period));

        const meterBox = hbox('aiu-cycle-meter-box', { width: limit.width, y_align: Clutter.ActorAlign.CENTER });
        const track = new St.Widget({ style_class: 'aiu-cycle-meter', width: METER_WIDTH, y_align: Clutter.ActorAlign.CENTER });
        if (known) {
            const fill = Math.round(METER_WIDTH * Math.min(100, Math.max(0, cycle.percent)) / 100);
            if (fill > 0)
                track.add_child(new St.Widget({
                    style_class: 'aiu-cycle-fill',
                    style: `background-color: ${severityColor(cycle.percent)};`,
                    width: fill,
                }));
        }
        meterBox.add_child(track);
        meterBox.add_child(label(percentText(cycle, current), 'aiu-cycle-pct', {
            ...(known && { style: `color: ${severityColor(cycle.percent)};` }),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(meterBox);

        row.add_child(cell(T.formatTokens(total), 'aiu-cycle-num', tokens));
        row.add_child(cell(rate === null ? '—' : T.formatTokens(rate), 'aiu-cycle-num aiu-cycle-dim', perPercent));
        row.add_child(cell(cycleState(cycle, current), `aiu-cycle-state${current ? ' aiu-cycle-state-live' : ''}`, state));

        const button = new St.Button({
            style_class: `aiu-cycle-item${current ? ' aiu-cycle-item-current' : ''}`,
            child: row,
            x_expand: true,
            track_hover: true,
        });
        button.connect('notify::hover', () => this._showDetail(button.hover ? cycle : this._default, nowSec));
        return button;
    }

    _showDetail(cycle, nowSec) {
        const panel = this._detail;
        if (!panel) return;
        panel.destroy_all_children();
        if (!cycle) return;

        const start = new Date(cycle.start * 1000);
        const end = new Date(cycle.end * 1000);
        const current = cycle.start <= nowSec && nowSec < cycle.end;
        const total = T.sumTokens(cycle.tokens);
        const pct = Number.isFinite(cycle.percent) ? `${percentText(cycle, current)} OF THE WEEKLY LIMIT · ` : '';
        panel.add_child(label(
            `${shortDay(start)} – ${shortDay(end)} ${end.getFullYear()} · ${pct}${cycleState(cycle, current)}`,
            'aiu-detail-period'));

        const [input, cacheWrite, cacheRead, output, messages] = cycle.tokens ?? [0, 0, 0, 0, 0];
        const parts = [
            `in ${T.formatTokens(input)}`,
            `cache write ${T.formatTokens(cacheWrite)}`,
            `cache read ${T.formatTokens(cacheRead)}`,
            `out ${T.formatTokens(output)}`,
            `${T.formatCount(messages)} responses`,
        ];
        panel.add_child(label(parts.join(' · '), 'aiu-detail-note'));
    }
}
