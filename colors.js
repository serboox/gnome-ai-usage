// Muted tones: the top bar is in view all day, so the ramp must not shout.
const SEVERITY_GREEN  = '#7ED99F';
const SEVERITY_YELLOW = '#E6B24A';
const SEVERITY_RED    = '#E08A9A';

// Low usage stays calm: the colour only starts to move at CALM_UNTIL_PERCENT.
const CALM_UNTIL_PERCENT = 25;
const YELLOW_AT_PERCENT  = 55;
const RED_AT_PERCENT     = 90;

const SEVERITY_STOPS = [
    [0,                   SEVERITY_GREEN],
    [CALM_UNTIL_PERCENT,  SEVERITY_GREEN],
    [YELLOW_AT_PERCENT,   SEVERITY_YELLOW],
    [RED_AT_PERCENT,      SEVERITY_RED],
    [100,                 SEVERITY_RED],
];

export function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function rgbToHex([r, g, b]) {
    const byte = (c) => Math.round(Math.min(1, Math.max(0, c)) * 255);
    return `#${[r, g, b].map((c) => byte(c).toString(16).padStart(2, '0')).join('')}`;
}

const toLinear   = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

// Mixing in OKLab keeps the midpoints bright (green → yellow-green → yellow → orange → red);
// plain RGB mixing turns green → yellow into a muddy olive.
function rgbToOklab([r, g, b]) {
    const [lr, lg, lb] = [r, g, b].map(toLinear);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function oklabToRgb([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ].map((c) => fromLinear(Math.min(1, Math.max(0, c))));
}

function mixHex(fromHex, toHex, t) {
    const from = rgbToOklab(hexToRgb(fromHex));
    const to   = rgbToOklab(hexToRgb(toHex));
    return rgbToHex(oklabToRgb(from.map((v, i) => v + (to[i] - v) * t)));
}

// Continuous colour for a usage percentage: green, then yellow, then red.
export function severityColor(percent) {
    const pct = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
    for (let i = 1; i < SEVERITY_STOPS.length; i++) {
        const [toPct, toHex] = SEVERITY_STOPS[i];
        if (pct > toPct) continue;
        const [fromPct, fromHex] = SEVERITY_STOPS[i - 1];
        if (toPct === fromPct) return toHex;
        return mixHex(fromHex, toHex, (pct - fromPct) / (toPct - fromPct));
    }
    return SEVERITY_RED;
}
