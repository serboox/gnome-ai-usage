import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as T from './tokens.js';

export const VIEW_DAY   = 'day';
export const VIEW_WEEK  = 'week';
export const VIEW_MONTH = 'month';
export const VIEW_YEAR  = 'year';
export const VIEW_ALL   = 'all';

const VIEWS = [
    { key: VIEW_DAY,   label: 'DAY' },
    { key: VIEW_WEEK,  label: 'WEEK' },
    { key: VIEW_MONTH, label: 'MONTH' },
    { key: VIEW_YEAR,  label: 'YEAR' },
    { key: VIEW_ALL,   label: 'YEARS' },
];

// Clicking the title climbs one level up.
const PARENT_VIEW = {
    [VIEW_DAY]: VIEW_MONTH,
    [VIEW_WEEK]: VIEW_MONTH,
    [VIEW_MONTH]: VIEW_YEAR,
    [VIEW_YEAR]: VIEW_ALL,
};

export const EXPORT_GRANULARITIES = ['hour', 'day', 'week', 'month', 'year'];

const SHORT_MONTHS = T.MONTH_NAMES.map((m) => m.slice(0, 3).toUpperCase());
const SHORT_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const CELL = {
    hour:  { width: 88, height: 62, style: '' },
    month: { width: 64, height: 56, style: '' },
    week:  { width: 64, height: 56, style: 'aiu-cell-small' },
    wday:  { width: 64, height: 52, style: '' },
    block: { width: 64, height: 40, style: 'aiu-cell-small' },
    mon:   { width: 133, height: 74, style: 'aiu-cell-large' },
    year:  { width: 133, height: 74, style: 'aiu-cell-large' },
    ymon:  { width: 37, height: 38, style: 'aiu-cell-small' },
};
const ROW_HEAD_WIDTH = 52;
// Every view fits this width, so switching views never resizes the popup.
const GRID_WIDTH = 560;
const DETAIL_METER_WIDTH = 222;
const DETAIL_MODELS = 5;

const pad2 = (n) => String(n).padStart(2, '0');

function label(text, styleClass, props = {}) {
    return new St.Label({ text, style_class: styleClass, ...props });
}

function hbox(styleClass = '', props = {}) {
    return new St.BoxLayout({ style_class: styleClass, ...props });
}

function vbox(styleClass = '', props = {}) {
    return new St.BoxLayout({
        style_class: styleClass,
        orientation: Clutter.Orientation.VERTICAL,
        ...props,
    });
}

function button(text, styleClass, onClick) {
    const btn = new St.Button({
        label: text,
        style_class: styleClass,
        can_focus: true,
        track_hover: true,
        reactive: true,
    });
    btn.connect('clicked', () => onClick());
    return btn;
}

function spacer() {
    return new St.Widget({ x_expand: true });
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function percentText(part, whole) {
    if (!(whole > 0)) return '';
    const pct = (part / whole) * 100;
    if (pct > 0 && pct < 0.1) return '<0.1%';
    return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

export class TokenCalendar {
    constructor({ onExport, onRescan }) {
        this._onExport = onExport;
        this._onRescan = onRescan;
        this._index = null;
        this._view = VIEW_MONTH;
        this._metric = T.METRICS[0];
        this._anchor = startOfDay(new Date());
        this._status = '';
        this._statusAlert = false;

        this.actor = vbox('aiu-tokens');
        this.actor.connect('destroy', () => {
            this.actor = null;
        });
    }

    setIndex(index) {
        this._index = index;
        this.render();
    }

    setStatus(text, alert = false) {
        this._status = text;
        this._statusAlert = alert;
        if (this._statusLabel) {
            this._statusLabel.text = text;
            this._statusLabel.style_class = alert ? 'aiu-alert' : 'aiu-muted';
        }
    }

    resetToToday() {
        this._anchor = startOfDay(new Date());
        this.render();
    }

    render() {
        if (!this.actor) return;
        this.actor.destroy_all_children();
        this._detail = null;

        if (!this._index) {
            this.actor.add_child(label('INDEXING TRANSCRIPTS…', 'aiu-section'));
            this.actor.add_child(label(
                'Token history is built from local Claude Code and Codex transcripts.',
                'aiu-muted'));
            this.actor.add_child(this._buildFooter());
            return;
        }

        this.actor.add_child(this._buildCards());
        this.actor.add_child(this._buildToolbar());
        this.actor.add_child(this._buildNav());

        const body = hbox('aiu-body');
        const gridColumn = vbox('aiu-grid', { width: GRID_WIDTH });
        gridColumn.add_child(this._buildGrid());
        gridColumn.add_child(this._buildLegend());
        body.add_child(gridColumn);

        this._detail = vbox('aiu-detail');
        body.add_child(this._detail);
        this.actor.add_child(body);

        gridColumn.reactive = true;
        gridColumn.connect('scroll-event', (_actor, event) => {
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP) this._shift(-1);
            else if (direction === Clutter.ScrollDirection.DOWN) this._shift(1);
            else return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        });

        this._showPeriodDetail();
        this.actor.add_child(this._buildFooter());
    }

    // ── summary cards ────────────────────────────────────────────────────

    _buildCards() {
        const index = this._index;
        const today = startOfDay(new Date());
        const cards = [
            ['TODAY', index.get(T.GRAN_DAY, T.dayKey(today)), ''],
            ['LAST 7 DAYS', index.range(T.addDays(today, -6), 7), 'aiu-accent-magenta'],
            ['LAST 30 DAYS', index.range(T.addDays(today, -29), 30), 'aiu-accent-yellow'],
            ['ALL TIME', index.all, 'aiu-accent-violet'],
        ];

        const row = hbox('aiu-cards');
        for (const [title, agg, accent] of cards) {
            const card = hbox('aiu-card', { x_expand: true });
            card.add_child(new St.Widget({ style_class: `aiu-accent ${accent}`, y_expand: true }));
            const text = vbox('aiu-card-text', { x_expand: true });
            text.add_child(label(title, 'aiu-card-label'));
            text.add_child(label(T.formatTokens(agg.metric(this._metric)), 'aiu-card-value'));
            text.add_child(label(`${T.formatCount(agg.messages)} responses`, 'aiu-card-sub'));
            card.add_child(text);
            row.add_child(card);
        }
        return row;
    }

    _buildToolbar() {
        const row = hbox('aiu-toolbar');
        for (const view of VIEWS) {
            const active = view.key === this._view ? ' aiu-chip-active' : '';
            row.add_child(button(view.label, `aiu-chip${active}`, () => {
                this._view = view.key;
                this.render();
            }));
        }
        row.add_child(spacer());
        for (const metric of T.METRICS) {
            const active = metric.key === this._metric.key ? ' aiu-chip-active' : '';
            row.add_child(button(metric.label, `aiu-chip aiu-chip-metric${active}`, () => {
                this._metric = metric;
                this.render();
            }));
        }
        return row;
    }

    // ── navigation ───────────────────────────────────────────────────────

    _periodBounds(view = this._view, anchor = this._anchor) {
        const a = startOfDay(anchor);
        switch (view) {
        case VIEW_DAY:
            return [a, T.addDays(a, 1)];
        case VIEW_WEEK: {
            const start = T.startOfWeek(a);
            return [start, T.addDays(start, 7)];
        }
        case VIEW_MONTH:
            return [new Date(a.getFullYear(), a.getMonth(), 1),
                new Date(a.getFullYear(), a.getMonth() + 1, 1)];
        case VIEW_YEAR:
            return [new Date(a.getFullYear(), 0, 1), new Date(a.getFullYear() + 1, 0, 1)];
        default: {
            const years = this._index?.years() ?? [];
            const first = years[0] ?? a.getFullYear();
            return [new Date(first, 0, 1), new Date(new Date().getFullYear() + 1, 0, 1)];
        }
        }
    }

    _shifted(direction) {
        const a = this._anchor;
        switch (this._view) {
        case VIEW_DAY:   return T.addDays(a, direction);
        case VIEW_WEEK:  return T.addDays(a, 7 * direction);
        case VIEW_MONTH: return new Date(a.getFullYear(), a.getMonth() + direction, 1);
        case VIEW_YEAR:  return new Date(a.getFullYear() + direction, 0, 1);
        default:         return null;
        }
    }

    _canShift(direction) {
        const next = this._shifted(direction);
        if (!next) return false;
        const [start, end] = this._periodBounds(this._view, next);
        if (direction > 0) return start <= new Date();
        const first = this._index?.firstDate;
        return first ? end > first : false;
    }

    _shift(direction) {
        if (!this._canShift(direction)) return;
        this._anchor = this._shifted(direction);
        this.render();
    }

    _title() {
        const a = this._anchor;
        switch (this._view) {
        case VIEW_DAY:
            return `${SHORT_DAYS[a.getDay()]} ${a.getDate()} ${SHORT_MONTHS[a.getMonth()]} ${a.getFullYear()}`;
        case VIEW_WEEK: {
            const [start] = this._periodBounds();
            const end = T.addDays(start, 6);
            const left = start.getMonth() === end.getMonth()
                ? `${start.getDate()}` : `${start.getDate()} ${SHORT_MONTHS[start.getMonth()]}`;
            return `${left} — ${end.getDate()} ${SHORT_MONTHS[end.getMonth()]} ${end.getFullYear()}`;
        }
        case VIEW_MONTH:
            return `${T.MONTH_NAMES[a.getMonth()].toUpperCase()} ${a.getFullYear()}`;
        case VIEW_YEAR:
            return `${a.getFullYear()}`;
        default: {
            const years = this._index.years();
            if (years.length === 0) return 'ALL TIME';
            const first = years[0];
            const last = years[years.length - 1];
            return first === last ? `${first}` : `${first} — ${last}`;
        }
        }
    }

    _buildNav() {
        const row = hbox('aiu-nav');

        const prev = button('‹', 'aiu-nav-arrow', () => this._shift(-1));
        prev.reactive = this._canShift(-1);
        prev.visible = this._view !== VIEW_ALL;
        row.add_child(prev);

        const parent = PARENT_VIEW[this._view];
        const title = button(parent ? `${this._title()}  ▴` : this._title(), 'aiu-nav-title', () => {
            if (!parent) return;
            this._view = parent;
            this.render();
        });
        title.reactive = Boolean(parent);
        row.add_child(title);

        const next = button('›', 'aiu-nav-arrow', () => this._shift(1));
        next.reactive = this._canShift(1);
        next.visible = this._view !== VIEW_ALL;
        row.add_child(next);

        row.add_child(spacer());

        const [start, end] = this._periodBounds();
        const total = this._rangeAggregate(start, end).metric(this._metric);
        const totalLabel = label(`Σ ${T.formatTokens(total)}`, 'aiu-nav-total');
        totalLabel.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(totalLabel);

        row.add_child(button('NOW', 'aiu-chip', () => this.resetToToday()));
        return row;
    }

    _rangeAggregate(start, end) {
        const days = Math.round((end - start) / 86_400_000);
        if (this._view === VIEW_YEAR) return this._index.get(T.GRAN_YEAR, `${start.getFullYear()}`);
        if (this._view === VIEW_ALL) return this._index.all;
        return this._index.range(start, days);
    }

    // ── grid views ───────────────────────────────────────────────────────

    _buildGrid() {
        switch (this._view) {
        case VIEW_DAY:   return this._buildDayGrid();
        case VIEW_WEEK:  return this._buildWeekGrid();
        case VIEW_YEAR:  return this._buildYearGrid();
        case VIEW_ALL:   return this._buildAllGrid();
        default:         return this._buildMonthGrid();
        }
    }

    // A cell is "void" when no data can exist for it: it lies in the future,
    // or before the oldest transcript that survived local cleanup.
    _isVoid(start, end) {
        const first = this._index.firstDate;
        return start > new Date() || (first !== null && end <= first);
    }

    _cell(spec) {
        const size = CELL[spec.size];
        const agg = spec.agg ?? T.EMPTY_AGGREGATE;
        const value = agg.metric(this._metric);
        const isVoid = spec.outside ? false : (spec.skipped || this._isVoid(spec.start, spec.end));

        const classes = ['aiu-cell'];
        if (size.style) classes.push(size.style);
        if (spec.outside) classes.push('aiu-cell-outside');
        else if (isVoid) classes.push('aiu-cell-void');
        else classes.push(`aiu-heat-${this._index.scale(spec.gran, this._metric).level(value)}`);
        if (spec.current) classes.push('aiu-cell-today');

        const content = vbox('', { y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        const centered = { x_align: Clutter.ActorAlign.CENTER };
        if (spec.top) content.add_child(label(spec.top, 'aiu-cell-top', centered));
        if (!spec.outside)
            content.add_child(label(isVoid ? '·' : T.formatTokens(value), 'aiu-cell-value', centered));

        const cell = new St.Button({
            style_class: classes.join(' '),
            child: content,
            width: size.width,
            height: size.height,
            track_hover: !spec.outside,
            reactive: !spec.outside,
            can_focus: !spec.outside,
        });
        if (!spec.outside) {
            cell.connect('notify::hover', () => {
                if (cell.hover) this._showCellDetail(spec, agg, isVoid);
                else this._showPeriodDetail();
            });
            cell.connect('key-focus-in', () => this._showCellDetail(spec, agg, isVoid));
            if (spec.drill) cell.connect('clicked', () => spec.drill());
        }
        return cell;
    }

    _drill(view, date) {
        return () => {
            this._view = view;
            this._anchor = startOfDay(date);
            this.render();
        };
    }

    _columnHeads(heads, withRowHead = true) {
        const row = hbox('aiu-grid-row');
        if (withRowHead) row.add_child(label('', 'aiu-rowhead', { width: ROW_HEAD_WIDTH }));
        for (const [text, width] of heads) {
            row.add_child(label(text, 'aiu-colhead', { width }));
        }
        return row;
    }

    _buildDayGrid() {
        const grid = vbox('aiu-grid');
        const day = startOfDay(this._anchor);
        const now = new Date();
        const columns = 6;
        for (let r = 0; r < 24 / columns; r++) {
            const row = hbox('aiu-grid-row');
            for (let c = 0; c < columns; c++) {
                const hour = r * columns + c;
                const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
                const end = new Date(start.getTime() + 3_600_000);
                // A spring-forward DST hour does not exist; Date rolls it into the next one.
                const skipped = start.getHours() !== hour;
                row.add_child(this._cell({
                    size: 'hour',
                    skipped,
                    gran: T.GRAN_HOUR,
                    agg: this._index.get(T.GRAN_HOUR, T.hourKey(day, hour)),
                    top: `${pad2(hour)}:00`,
                    start, end,
                    current: !skipped && start <= now && now < end,
                    title: `${this._title()} · ${pad2(hour)}:00–${pad2((hour + 1) % 24)}:00`,
                }));
            }
            grid.add_child(row);
        }
        return grid;
    }

    _buildWeekGrid() {
        const grid = vbox('aiu-grid');
        const [monday] = this._periodBounds();
        const today = startOfDay(new Date());
        const now = new Date();
        const days = Array.from({ length: 7 }, (_, i) => T.addDays(monday, i));

        grid.add_child(this._columnHeads(days.map((d, i) =>
            [`${T.WEEKDAYS[i]} ${d.getDate()}`, CELL.wday.width])));

        const dayRow = hbox('aiu-grid-row');
        dayRow.add_child(label('DAY', 'aiu-rowhead', { width: ROW_HEAD_WIDTH, y_align: Clutter.ActorAlign.CENTER }));
        for (const d of days) {
            dayRow.add_child(this._cell({
                size: 'wday',
                gran: T.GRAN_DAY,
                agg: this._index.get(T.GRAN_DAY, T.dayKey(d)),
                top: `${d.getDate()}`,
                start: d, end: T.addDays(d, 1),
                current: sameDay(d, today),
                title: `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`,
                drill: this._drill(VIEW_DAY, d),
            }));
        }
        grid.add_child(dayRow);

        for (let block = 0; block < 24 / T.BLOCK_HOURS; block++) {
            const from = block * T.BLOCK_HOURS;
            const to = from + T.BLOCK_HOURS;
            const row = hbox('aiu-grid-row');
            row.add_child(label(`${pad2(from)}–${pad2(to % 24)}`, 'aiu-rowhead',
                { width: ROW_HEAD_WIDTH, y_align: Clutter.ActorAlign.CENTER }));
            for (const d of days) {
                const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), from);
                const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), to);
                row.add_child(this._cell({
                    size: 'block',
                    gran: T.GRAN_BLOCK,
                    agg: this._index.get(T.GRAN_BLOCK, T.blockKey(d, block)),
                    start, end,
                    current: start <= now && now < end,
                    title: `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} · ${pad2(from)}:00–${pad2(to % 24)}:00`,
                    drill: this._drill(VIEW_DAY, d),
                }));
            }
            grid.add_child(row);
        }
        return grid;
    }

    _buildMonthGrid() {
        const grid = vbox('aiu-grid');
        const year = this._anchor.getFullYear();
        const month = this._anchor.getMonth();
        const today = startOfDay(new Date());

        const heads = T.WEEKDAYS.map((d) => [d, CELL.month.width]);
        heads.push(['WEEK', CELL.week.width]);
        grid.add_child(this._columnHeads(heads, false));

        let monday = T.startOfWeek(new Date(year, month, 1));
        const monthEnd = new Date(year, month + 1, 1);
        while (monday < monthEnd) {
            const row = hbox('aiu-grid-row');
            for (let i = 0; i < 7; i++) {
                const d = T.addDays(monday, i);
                const outside = d.getMonth() !== month;
                row.add_child(this._cell({
                    size: 'month',
                    gran: T.GRAN_DAY,
                    agg: this._index.get(T.GRAN_DAY, T.dayKey(d)),
                    top: `${d.getDate()}`,
                    start: d, end: T.addDays(d, 1),
                    outside,
                    current: !outside && sameDay(d, today),
                    title: `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`,
                    drill: this._drill(VIEW_DAY, d),
                }));
            }
            const weekStart = monday;
            row.add_child(this._cell({
                size: 'week',
                gran: T.GRAN_WEEK,
                agg: this._index.get(T.GRAN_WEEK, T.dayKey(weekStart)),
                top: `W${isoWeek(weekStart)}`,
                start: weekStart, end: T.addDays(weekStart, 7),
                title: `WEEK ${isoWeek(weekStart)} · ${weekStart.getDate()} ${SHORT_MONTHS[weekStart.getMonth()]}`,
                drill: this._drill(VIEW_WEEK, weekStart),
            }));
            grid.add_child(row);
            monday = T.addDays(monday, 7);
        }
        return grid;
    }

    _buildYearGrid() {
        const grid = vbox('aiu-grid');
        const year = this._anchor.getFullYear();
        const now = new Date();
        const columns = 4;
        for (let r = 0; r < 12 / columns; r++) {
            const row = hbox('aiu-grid-row');
            for (let c = 0; c < columns; c++) {
                const month = r * columns + c;
                const start = new Date(year, month, 1);
                const end = new Date(year, month + 1, 1);
                row.add_child(this._cell({
                    size: 'mon',
                    gran: T.GRAN_MONTH,
                    agg: this._index.get(T.GRAN_MONTH, T.monthKey(year, month)),
                    top: SHORT_MONTHS[month],
                    start, end,
                    current: start <= now && now < end,
                    title: `${T.MONTH_NAMES[month].toUpperCase()} ${year}`,
                    drill: this._drill(VIEW_MONTH, start),
                }));
            }
            grid.add_child(row);
        }

        grid.add_child(label('DAILY PULSE', 'aiu-detail-heading'));
        grid.add_child(this._buildPulse(year));
        return grid;
    }

    // GitHub-style strip: one column per week, one dot per day.
    _buildPulse(year) {
        const strip = hbox('aiu-pulse');
        const scale = this._index.scale(T.GRAN_DAY, this._metric);
        const yearEnd = new Date(year + 1, 0, 1);
        // A leap year starting on Sunday spans 54 week columns, so loop by date.
        for (let monday = T.startOfWeek(new Date(year, 0, 1)); monday < yearEnd; monday = T.addDays(monday, 7)) {
            const column = vbox('aiu-pulse-col');
            for (let i = 0; i < 7; i++) {
                const d = T.addDays(monday, i);
                const dot = new St.Widget({ style_class: 'aiu-dot', reactive: true, track_hover: true });
                if (d.getFullYear() !== year) {
                    dot.opacity = 0;
                    dot.reactive = false;
                } else {
                    const agg = this._index.get(T.GRAN_DAY, T.dayKey(d));
                    const isVoid = this._isVoid(d, T.addDays(d, 1));
                    dot.add_style_class_name(isVoid ? 'aiu-dot-void' : `aiu-heat-${scale.level(agg.metric(this._metric))}`);
                    const spec = {
                        gran: T.GRAN_DAY,
                        title: `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${year}`,
                    };
                    dot.connect('notify::hover', () => {
                        if (dot.hover) this._showCellDetail(spec, agg, isVoid);
                        else this._showPeriodDetail();
                    });
                    dot.connect('button-release-event', () => {
                        this._drill(VIEW_DAY, d)();
                        return Clutter.EVENT_STOP;
                    });
                }
                column.add_child(dot);
            }
            strip.add_child(column);
        }
        return strip;
    }

    _buildAllGrid() {
        const grid = vbox('aiu-grid');
        const years = this._index.years();
        const thisYear = new Date().getFullYear();
        if (years.length === 0 || years[years.length - 1] < thisYear) years.push(thisYear);
        const now = new Date();

        const yearRow = hbox('aiu-grid-row');
        for (const year of years) {
            const start = new Date(year, 0, 1);
            const end = new Date(year + 1, 0, 1);
            yearRow.add_child(this._cell({
                size: 'year',
                gran: T.GRAN_YEAR,
                agg: this._index.get(T.GRAN_YEAR, `${year}`),
                top: `${year}`,
                start, end,
                current: year === thisYear,
                title: `YEAR ${year}`,
                drill: this._drill(VIEW_YEAR, start),
            }));
        }
        grid.add_child(yearRow);

        grid.add_child(label('MONTH MATRIX', 'aiu-detail-heading'));
        grid.add_child(this._columnHeads(SHORT_MONTHS.map((m) => [m[0] + m.slice(1).toLowerCase(), CELL.ymon.width])));
        for (const year of years) {
            const row = hbox('aiu-grid-row');
            row.add_child(label(`${year}`, 'aiu-rowhead', { width: ROW_HEAD_WIDTH, y_align: Clutter.ActorAlign.CENTER }));
            for (let month = 0; month < 12; month++) {
                const start = new Date(year, month, 1);
                const end = new Date(year, month + 1, 1);
                row.add_child(this._cell({
                    size: 'ymon',
                    gran: T.GRAN_MONTH,
                    agg: this._index.get(T.GRAN_MONTH, T.monthKey(year, month)),
                    start, end,
                    current: start <= now && now < end,
                    title: `${T.MONTH_NAMES[month].toUpperCase()} ${year}`,
                    drill: this._drill(VIEW_MONTH, start),
                }));
            }
            grid.add_child(row);
        }
        return grid;
    }

    // ── legend ───────────────────────────────────────────────────────────

    _legendGranularity() {
        switch (this._view) {
        case VIEW_DAY:  return T.GRAN_HOUR;
        case VIEW_WEEK: return T.GRAN_BLOCK;
        case VIEW_YEAR: return T.GRAN_MONTH;
        case VIEW_ALL:  return T.GRAN_MONTH;
        default:        return T.GRAN_DAY;
        }
    }

    _buildLegend() {
        const gran = this._legendGranularity();
        const scale = this._index.scale(gran, this._metric);
        const row = hbox('aiu-legend');
        row.add_child(label('LESS', 'aiu-legend-label', { y_align: Clutter.ActorAlign.CENTER }));
        for (let level = 0; level <= T.HEAT_LEVELS; level++)
            row.add_child(new St.Widget({ style_class: `aiu-legend-swatch aiu-heat-${level}` }));
        const hot = scale.hotThreshold > 0 ? `${T.formatTokens(scale.hotThreshold)}+` : 'MORE';
        row.add_child(label(hot, 'aiu-legend-label', { y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(spacer());
        const unit = { hour: 'PER HOUR', block: 'PER 4 HOURS', day: 'PER DAY', month: 'PER MONTH' }[gran];
        row.add_child(label(`SCALE ${unit} · ${this._metric.label}`, 'aiu-legend-label',
            { y_align: Clutter.ActorAlign.CENTER }));
        return row;
    }

    // ── detail panel ─────────────────────────────────────────────────────

    _showPeriodDetail() {
        const [start, end] = this._periodBounds();
        const agg = this._rangeAggregate(start, end);
        this._fillDetail(`${this._title()} · TOTAL`, agg, null, false);
    }

    _showCellDetail(spec, agg, isVoid) {
        this._fillDetail(spec.title ?? spec.top ?? '', agg, spec.gran, isVoid);
    }

    _fillDetail(title, agg, gran, isVoid) {
        const panel = this._detail;
        if (!panel) return;
        panel.destroy_all_children();

        panel.add_child(new St.Widget({ style_class: 'aiu-detail-bar', x_expand: true }));
        panel.add_child(label(title, 'aiu-detail-period'));
        if (isVoid) {
            panel.add_child(label('NO SIGNAL', 'aiu-detail-total'));
            panel.add_child(label('No transcripts exist for this period.', 'aiu-detail-sub'));
            return;
        }

        const metric = this._metric;
        const total = agg.metric(metric);
        panel.add_child(label(T.formatTokens(total), 'aiu-detail-total'));
        const sub = label(
            `${T.formatCount(total)} tokens\n${T.formatCount(agg.messages)} responses`,
            'aiu-detail-sub');
        sub.clutter_text.line_wrap = true;
        panel.add_child(sub);

        panel.add_child(label('BREAKDOWN', 'aiu-detail-heading'));
        const grand = agg.total;
        for (const kind of T.KINDS) {
            const value = agg.values[kind.index];
            const dimmed = !metric.kinds.includes(kind.index);
            this._detailRow(panel, kind.label, value, grand, `aiu-fill-${kind.key}`, dimmed);
        }

        const models = agg.topModels(metric);
        if (models.length > 0) {
            panel.add_child(label('MODELS', 'aiu-detail-heading'));
            for (const [model, value] of models.slice(0, DETAIL_MODELS)) {
                const source = this._index.sourceOf(model);
                const short = T.shortModelName(this._index.modelName(model));
                const name = source === 'codex' ? `codex · ${short}` : short;
                this._detailRow(panel, name, value, total, 'aiu-fill-model', false);
            }
        }

        if (gran && total > 0) {
            const scale = this._index.scale(gran, metric);
            const rank = scale.rank(total);
            const unit = { hour: 'hour', block: '4-hour block', day: 'day', week: 'week', month: 'month', year: 'year' }[gran];
            panel.add_child(label('RANK', 'aiu-detail-heading'));
            panel.add_child(label(`#${rank} of ${scale.count} active ${unit}s`, 'aiu-detail-note'));
            if (scale.mean > 0) {
                const delta = (total / scale.mean - 1) * 100;
                const sign = delta >= 0 ? '+' : '−';
                panel.add_child(label(`${sign}${Math.abs(Math.round(delta))}% vs average ${unit}`,
                    `aiu-detail-note ${delta >= 0 ? 'aiu-detail-bad' : 'aiu-detail-good'}`));
            }
        }
    }

    _detailRow(panel, name, value, whole, fillClass, dimmed) {
        const row = hbox('aiu-detail-row');
        row.add_child(label(name, 'aiu-detail-key', { x_expand: true }));
        row.add_child(label(T.formatTokens(value), 'aiu-detail-val'));
        row.add_child(label(percentText(value, whole), 'aiu-detail-pct'));
        if (dimmed) row.opacity = 110;
        panel.add_child(row);

        const meter = new St.Widget({ style_class: 'aiu-meter', width: DETAIL_METER_WIDTH });
        const share = whole > 0 ? Math.min(1, value / whole) : 0;
        // A non-zero share stays visible even when it rounds to zero pixels.
        const width = value > 0 ? Math.max(2, Math.round(share * DETAIL_METER_WIDTH)) : 0;
        meter.add_child(new St.Widget({ style_class: `aiu-meter-fill ${fillClass}`, width }));
        if (dimmed) meter.opacity = 110;
        panel.add_child(meter);
    }

    // ── footer ───────────────────────────────────────────────────────────

    _buildFooter() {
        const row = hbox('aiu-footer');
        const exportLabel = label('EXPORT CSV', 'aiu-footer-label');
        exportLabel.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(exportLabel);
        for (const gran of EXPORT_GRANULARITIES)
            row.add_child(button(gran.toUpperCase(), 'aiu-chip', () => this._onExport(gran)));

        row.add_child(spacer());
        this._statusLabel = label(this._status, this._statusAlert ? 'aiu-alert' : 'aiu-muted');
        this._statusLabel.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(this._statusLabel);
        row.add_child(button('↻', 'aiu-icon-button', () => this._onRescan()));
        return row;
    }

    destroy() {
        this.actor?.destroy();
    }
}

export function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
}
