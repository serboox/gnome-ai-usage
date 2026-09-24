import System from 'system';
import * as T from '../tokens.js';

let failures = 0;
function eq(actual, expected, name) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) { failures++; print(`FAIL ${name}: ${a} !== ${e}`); }
}

eq(T.formatTokens(0), '0', 'zero');
eq(T.formatTokens(842), '842', 'small');
eq(T.formatTokens(12345), '12.3k', 'k');
eq(T.formatTokens(999_700), '1M', 'rounds up to next unit');
eq(T.formatTokens(217_400_000), '217M', 'M');
eq(T.formatTokens(1_702_000_000), '1.7B', 'B');
eq(T.formatCount(1234567), '1,234,567', 'count');
eq(T.shortModelName('claude-opus-5-5'), 'opus 5.5', 'model');
eq(T.shortModelName('claude-haiku-4-5-20251001'), 'haiku 4.5', 'dated model');
eq(T.shortModelName('gpt-5.6-sol'), 'gpt-5.6-sol', 'foreign model');

eq(T.dayKey(T.startOfWeek(new Date(2026, 8, 24))), '2026-09-21', 'week starts monday');
eq(T.dayKey(T.startOfWeek(new Date(2026, 8, 27))), '2026-09-21', 'sunday belongs to prior week');
eq(T.daysInMonth(2028, 1), 29, 'leap');

const empty = new T.HeatScale([]);
eq(empty.level(0), 0, 'empty scale zero');
eq(empty.level(5), T.HEAT_LEVELS, 'empty scale positive');
const single = new T.HeatScale([100]);
eq(single.level(100), T.HEAT_LEVELS, 'single value is hottest');
const many = new T.HeatScale(Array.from({ length: 100 }, (_, i) => i + 1));
eq(many.level(1), 1, 'min is level 1');
eq(many.level(100), T.HEAT_LEVELS, 'max is hottest');
eq(many.level(50), 3, 'median in the middle');
eq([many.level(80), many.level(90), many.level(97)], [6, 7, 8], 'warm levels are the top quarter');
eq([many.rank(100), many.rank(1), many.rank(0), many.rank(50.5)], [1, 100, null, 51], 'rank');
eq(many.mean, 50.5, 'mean');
const small = new T.HeatScale([10, 1000]);
eq([small.level(10), small.level(1000)], [1, T.HEAT_LEVELS], 'log fallback ends');

const index = new T.TokenIndex({
    first_ts: 1, last_ts: 2, messages: 3,
    models: {
        'claude/a': { source: 'claude', model: 'a' },
        'codex/a': { source: 'codex', model: 'a' },
    },
    hours: {
        '2026-09-21T01': { 'claude/a': [1, 2, 3, 4, 1] },
        '2026-09-21T05': { 'claude/a': [10, 0, 0, 0, 1], 'codex/a': [0, 0, 0, 5, 1] },
        '2026-09-27T23': { 'codex/a': [100, 0, 0, 0, 2] },
    },
});
eq(index.get(T.GRAN_DAY, '2026-09-21').total, 25, 'day total');
eq(index.get(T.GRAN_BLOCK, '2026-09-21B0').total, 10, 'block 0');
eq(index.get(T.GRAN_BLOCK, '2026-09-21B1').total, 15, 'block 1');
eq(index.get(T.GRAN_WEEK, '2026-09-21').total, 125, 'week groups sunday');
eq(index.get(T.GRAN_MONTH, '2026-09').messages, 5, 'month messages');
eq(index.all.total, 125, 'all total');
eq(index.get(T.GRAN_DAY, '2026-09-21').topModels(T.METRICS[0]), [['claude/a', 20], ['codex/a', 5]], 'same model name stays split by source');
eq([index.sourceOf('codex/a'), index.modelName('codex/a')], ['codex', 'a'], 'model key lookup');
eq(index.get(T.GRAN_DAY, '2026-09-21').metric(T.METRICS[2]), 9, 'output metric');
eq(index.range(new Date(2026, 8, 21), 7).total, 125, 'range');
eq(index.get(T.GRAN_DAY, '1999-01-01').total, 0, 'missing key');
eq(index.years(), [2026], 'years');

print(failures ? `${failures} failure(s)` : 'all tests passed');
if (failures) System.exit(1);
