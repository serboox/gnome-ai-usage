import System from 'system';
import * as C from '../colors.js';

let failures = 0;
function eq(actual, expected, name) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) { failures++; print(`FAIL ${name}: ${a} !== ${e}`); }
}
function ok(condition, name) {
    if (!condition) { failures++; print(`FAIL ${name}`); }
}
const luma = (hex) => {
    const [r, g, b] = C.hexToRgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const between = (v, a, b, tolerance = 0.03) =>
    v >= Math.min(a, b) - tolerance && v <= Math.max(a, b) + tolerance;

eq(C.hexToRgb('#000000'), [0, 0, 0], 'black');
eq(C.hexToRgb('#ffffff'), [1, 1, 1], 'white');
eq(C.hexToRgb('#ff0000'), [1, 0, 0], 'red channel');

eq(C.severityColor(0), '#7ed99f', 'empty is green');
eq(C.severityColor(9), '#7ed99f', 'low usage stays on the green plateau');
eq(C.severityColor(25), '#7ed99f', 'plateau ends at 25');
eq(C.severityColor(55), '#e6b24a', 'yellow at 55');
eq(C.severityColor(90), '#e08a9a', 'red at 90');
eq(C.severityColor(100), '#e08a9a', 'full is red');

eq(C.severityColor(-5), C.severityColor(0), 'below zero clamps');
eq(C.severityColor(140), C.severityColor(100), 'above 100 clamps');
eq(C.severityColor(NaN), C.severityColor(0), 'NaN falls back to empty');
eq(C.severityColor(null), C.severityColor(0), 'null falls back to empty');

const samples = [30, 40, 50, 60, 70, 80];
const colors = samples.map(C.severityColor);
ok(new Set(colors).size === samples.length, 'every step in the ramp has its own colour');
ok(colors.every((c) => /^#[0-9a-f]{6}$/.test(c)), 'output is #rrggbb');

const [green, yellow, red] = ['#7ed99f', '#e6b24a', '#e08a9a'].map(C.hexToRgb);
const mid1 = C.hexToRgb(C.severityColor(40));
const mid2 = C.hexToRgb(C.severityColor(72));
ok([0, 1, 2].every((i) => between(mid1[i], green[i], yellow[i])), 'green → yellow midpoint stays between its stops');
ok([0, 1, 2].every((i) => between(mid2[i], yellow[i], red[i])), 'yellow → red midpoint stays between its stops');
ok(mid1[1] > mid1[2], 'green → yellow midpoint keeps a green lean');

const darkestStop = Math.min(...['#7ed99f', '#e6b24a', '#e08a9a'].map(luma));
const ramp = Array.from({ length: 21 }, (_, i) => C.severityColor(i * 5));
ok(ramp.every((c) => luma(c) >= darkestStop - 0.03), 'no step is darker than the darkest stop');

if (failures > 0) {
    print(`${failures} failure(s)`);
    System.exit(1);
}
print('colors: all passed');
