import assert from 'node:assert/strict';
import test from 'node:test';
import {
  esc,
  faDate,
  humanBytes,
  humanDuration,
  joinWithin,
  percent,
  progressBar,
  truncate,
} from '../src/utils/format.js';

test('humanBytes scales and guards junk input', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(-5), '0 B');
  assert.equal(humanBytes(NaN), '0 B');
  assert.equal(humanBytes(512), '512 B');
  assert.equal(humanBytes(1024), '1.0 KB');
  assert.equal(humanBytes(1024 ** 3 * 2), '2.0 GB');
});

test('humanDuration always returns something readable', () => {
  assert.equal(humanDuration(0), '0 ثانیه');
  assert.equal(humanDuration(45_000), '45 ثانیه');
  assert.equal(humanDuration(3_600_000), '1 ساعت');
  assert.equal(humanDuration(90_061_000), '1 روز و 1 ساعت و 1 دقیقه');
});

test('percent clamps and never divides by zero', () => {
  assert.equal(percent(5, 0), 0);
  assert.equal(percent(50, 100), 50);
  assert.equal(percent(200, 100), 100);
  assert.equal(percent(-1, 100), 0);
  assert.equal(percent('x', 'y'), 0);
});

test('progressBar has a stable width', () => {
  assert.equal(progressBar(0).length, 14);
  assert.equal(progressBar(100).length, 14);
  assert.equal(progressBar(999).length, 14);
  assert.equal(progressBar(100), '\u2588'.repeat(14));
});

test('esc neutralizes Telegram HTML', () => {
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(esc(null), '');
});

test('truncate cuts raw text before escaping happens', () => {
  assert.equal(truncate('abcdef', 3), 'ab\u2026');
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abc', 0), '');
});

test('joinWithin drops whole lines instead of slicing markup', () => {
  const lines = ['<b>one</b>', '<b>two</b>', '<b>three</b>'];
  const out = joinWithin(lines, 22);
  assert.equal(out, '<b>one</b>\n<b>two</b>');
  assert.ok(!out.endsWith('<b'));
  assert.equal(joinWithin(lines, 0), '');
});

test('faDate survives a bogus timezone', () => {
  const date = new Date('2024-01-01T00:00:00Z');
  assert.notEqual(faDate(date, 'Definitely/NotAZone'), '');
  assert.equal(faDate(new Date('nope')), '');
});
