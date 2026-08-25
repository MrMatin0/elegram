import assert from 'node:assert/strict';
import test from 'node:test';
import { LOG_LEVELS, currentLogLevel, errText, log, setLogLevel } from '../src/utils/logger.js';

test('log levels gate output', () => {
  const previous = currentLogLevel();
  try {
    setLogLevel('silent');
    assert.equal(currentLogLevel(), 'silent');
    assert.equal(log.enabled('error'), false);
    setLogLevel('warn');
    assert.equal(log.enabled('warn'), true);
    assert.equal(log.enabled('info'), false);
    setLogLevel('nonsense');
    assert.equal(currentLogLevel(), 'warn', 'an unknown level must be ignored');
  } finally {
    setLogLevel(previous);
  }
  assert.ok(LOG_LEVELS.includes('debug'));
});

test('errText prefers the raw server string and always returns one line', () => {
  assert.equal(errText(Object.assign(new Error('nice sentence'), { errorMessage: 'FLOOD_WAIT_3' })), 'FLOOD_WAIT_3');
  assert.equal(errText(new Error('line one\n  line two')), 'line one line two');
  assert.equal(errText('  boom '), 'boom');
  assert.equal(errText(null), 'خطای ناشناخته');
  assert.equal(errText(new Error('')), 'Error');
});
