export const KIND_INPUT       = 0;
export const KIND_CACHE_WRITE = 1;
export const KIND_CACHE_READ  = 2;
export const KIND_OUTPUT      = 3;
export const FIELD_MESSAGES   = 4;
export const KIND_COUNT       = 4;

export const KINDS = [
    { index: KIND_INPUT,       key: 'input',       label: 'INPUT' },
    { index: KIND_CACHE_WRITE, key: 'cache_write', label: 'CACHE WRITE' },
    { index: KIND_CACHE_READ,  key: 'cache_read',  label: 'CACHE READ' },
    { index: KIND_OUTPUT,      key: 'output',      label: 'OUTPUT' },
];

export const METRICS = [
    { key: 'all',    label: 'ALL',    kinds: [KIND_INPUT, KIND_CACHE_WRITE, KIND_CACHE_READ, KIND_OUTPUT] },
    { key: 'input',  label: 'IN',     kinds: [KIND_INPUT, KIND_CACHE_WRITE, KIND_CACHE_READ] },
    { key: 'output', label: 'OUT',    kinds: [KIND_OUTPUT] },
    { key: 'fresh',  label: 'NO CACHE', kinds: [KIND_INPUT, KIND_OUTPUT] },
];

export const GRAN_HOUR  = 'hour';
export const GRAN_BLOCK = 'block';
export const GRAN_DAY   = 'day';
export const GRAN_WEEK  = 'week';
export const GRAN_MONTH = 'month';
export const GRAN_YEAR  = 'year';

export const BLOCK_HOURS = 4;
export const HEAT_LEVELS = 8;

// Warm colours (levels 6..8) are kept for the top quarter of periods so a
// hot tile still means "unusually heavy", not "slightly above median".
const HEAT_QUANTILES = [0.15, 0.33, 0.5, 0.62, 0.75, 0.87, 0.95];
// Below this many samples quantiles are meaningless, so the scale falls back
// to even steps on a log axis between the smallest and largest value.
const MIN_QUANTILE_SAMPLES = 12;

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const pad2 = (n) => String(n).padStart(2, '0');

export function dayKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function hourKey(date, hour = date.getHours()) {
    return `${dayKey(date)}T${pad2(hour)}`;
}

export function monthKey(year, month) {
    return `${year}-${pad2(month + 1)}`;
}

export function blockKey(date, block) {
    return `${dayKey(date)}B${block}`;
}

// Monday of the week that contains `date`, at local midnight.
export function startOfWeek(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
}

export function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

function parseDayKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

// 842 · 12k · 3.4M · 217M · 1.70B — three significant digits at most.
export function formatTokens(value) {
    if (!Number.isFinite(value) || value <= 0) return '0';
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
    for (const [size, suffix] of units) {
        if (value >= size * 0.9995) {
            const scaled = value / size;
            const digits = scaled >= 100 ? 0 : (scaled >= 10 ? 1 : 2);
            return `${Number(scaled.toFixed(digits))}${suffix}`;
        }
    }
    return String(Math.round(value));
}

export function formatCount(value) {
    return Math.round(value ?? 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export class Aggregate {
    constructor() {
        this.values = new Array(KIND_COUNT + 1).fill(0);
        this.models = new Map();
    }

    add(values, model = null) {
        for (let i = 0; i <= KIND_COUNT; i++) this.values[i] += values[i] ?? 0;
        if (model === null) return;
        let bucket = this.models.get(model);
        if (!bucket) {
            bucket = new Array(KIND_COUNT + 1).fill(0);
            this.models.set(model, bucket);
        }
        for (let i = 0; i <= KIND_COUNT; i++) bucket[i] += values[i] ?? 0;
    }

    merge(other) {
        if (!other) return this;
        for (const [model, values] of other.models) this.add(values, model);
        return this;
    }

    get messages() {
        return this.values[FIELD_MESSAGES];
    }

    metric(metric) {
        return metric.kinds.reduce((sum, kind) => sum + this.values[kind], 0);
    }

    get total() {
        return this.metric(METRICS[0]);
    }

    // [[model, total], ...] sorted by the chosen metric, largest first.
    topModels(metric) {
        return [...this.models.entries()]
            .map(([model, values]) => [model, metric.kinds.reduce((s, k) => s + values[k], 0)])
            .filter(([, value]) => value > 0)
            .sort((a, b) => b[1] - a[1]);
    }
}

export const EMPTY_AGGREGATE = new Aggregate();

// Maps a value onto 0..HEAT_LEVELS; level 0 is reserved for "no usage at all".
export class HeatScale {
    constructor(values) {
        const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
        this.max = sorted.length ? sorted[sorted.length - 1] : 0;
        this.min = sorted.length ? sorted[0] : 0;
        this.thresholds = HeatScale._thresholds(sorted);
        this.count = sorted.length;
        this.mean = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
        this._sorted = sorted;
    }

    // 1-based position among active periods, largest first; null for no usage.
    rank(value) {
        if (!(value > 0)) return null;
        let lo = 0;
        let hi = this._sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this._sorted[mid] <= value) lo = mid + 1;
            else hi = mid;
        }
        return this._sorted.length - lo + 1;
    }

    static _thresholds(sorted) {
        if (sorted.length === 0) return [];
        if (sorted.length >= MIN_QUANTILE_SAMPLES) {
            return HEAT_QUANTILES.map((q) => {
                const pos = q * (sorted.length - 1);
                const lo = Math.floor(pos);
                const hi = Math.ceil(pos);
                return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
            });
        }
        const lo = Math.log(sorted[0]);
        const hi = Math.log(sorted[sorted.length - 1]);
        if (hi === lo) return [];
        const steps = HEAT_LEVELS - 1;
        return Array.from({ length: steps }, (_, i) => Math.exp(lo + (hi - lo) * (i + 1) / (steps + 1)));
    }

    level(value) {
        if (!(value > 0)) return 0;
        if (this.thresholds.length === 0) return HEAT_LEVELS;
        let level = 1;
        for (const threshold of this.thresholds) {
            if (value > threshold) level++;
        }
        return Math.min(level, HEAT_LEVELS);
    }

    // The value above which a cell reaches the hottest level.
    get hotThreshold() {
        return this.thresholds[this.thresholds.length - 1] ?? this.max;
    }
}

export class TokenIndex {
    constructor(payload) {
        this.generatedAt = Number.isFinite(payload?.generated_at) ? new Date(payload.generated_at * 1000) : null;
        this.firstDate   = Number.isFinite(payload?.first_ts) ? new Date(payload.first_ts * 1000) : null;
        this.lastDate    = Number.isFinite(payload?.last_ts) ? new Date(payload.last_ts * 1000) : null;
        this.messageCount = payload?.messages ?? 0;
        this._models = new Map(Object.entries(payload?.models ?? {}));

        this._maps = new Map([
            [GRAN_HOUR, new Map()], [GRAN_BLOCK, new Map()], [GRAN_DAY, new Map()],
            [GRAN_WEEK, new Map()], [GRAN_MONTH, new Map()], [GRAN_YEAR, new Map()],
        ]);
        this._scales = new Map();
        this.all = new Aggregate();

        for (const [key, models] of Object.entries(payload?.hours ?? {})) {
            const day = key.slice(0, 10);
            const hour = Number(key.slice(11, 13));
            const date = parseDayKey(day);
            const keys = [
                [GRAN_HOUR, key],
                [GRAN_BLOCK, `${day}B${Math.floor(hour / BLOCK_HOURS)}`],
                [GRAN_DAY, day],
                [GRAN_WEEK, dayKey(startOfWeek(date))],
                [GRAN_MONTH, day.slice(0, 7)],
                [GRAN_YEAR, day.slice(0, 4)],
            ];
            for (const [model, values] of Object.entries(models ?? {})) {
                if (!Array.isArray(values)) continue;
                for (const [gran, k] of keys) this._bucket(gran, k).add(values, model);
                this.all.add(values, model);
            }
        }
    }

    _bucket(gran, key) {
        const map = this._maps.get(gran);
        let agg = map.get(key);
        if (!agg) {
            agg = new Aggregate();
            map.set(key, agg);
        }
        return agg;
    }

    get(gran, key) {
        return this._maps.get(gran)?.get(key) ?? EMPTY_AGGREGATE;
    }

    years() {
        return [...this._maps.get(GRAN_YEAR).keys()].map(Number).sort((a, b) => a - b);
    }

    scale(gran, metric) {
        const cacheKey = `${gran}:${metric.key}`;
        let scale = this._scales.get(cacheKey);
        if (!scale) {
            const values = [...this._maps.get(gran).values()].map((agg) => agg.metric(metric));
            scale = new HeatScale(values);
            this._scales.set(cacheKey, scale);
        }
        return scale;
    }

    // Sum over [start, end) in whole local days.
    range(start, days) {
        const agg = new Aggregate();
        for (let i = 0; i < days; i++) agg.merge(this.get(GRAN_DAY, dayKey(addDays(start, i))));
        return agg;
    }

    sourceOf(key) {
        return this._models.get(key)?.source ?? 'unknown';
    }

    modelName(key) {
        return this._models.get(key)?.model ?? key;
    }
}

// Short display name: "claude-opus-5-5" → "opus 5.5", "claude-haiku-4-5-20251001" → "haiku 4.5".
export function shortModelName(model) {
    const name = String(model ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const match = name.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/);
    if (match) return `${match[1]} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
    return name;
}
