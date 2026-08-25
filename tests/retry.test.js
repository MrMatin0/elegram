import assert from 'node:assert/strict';
import test from 'node:test';
import { floodWaitSeconds, isNotModified, isPermanent, isTransient, withRetry } from '../src/utils/retry.js';

class FloodWaitError extends Error {
  constructor(seconds) {
    super(`A wait of ${seconds} seconds is required`);
    this.seconds = seconds;
    this.errorMessage = `FLOOD_WAIT_${seconds}`;
  }
}
class BadRequestError extends Error {}

test('floodWaitSeconds reads the typed error attribute', () => {
  assert.equal(floodWaitSeconds(new FloodWaitError(42)), 42);
  assert.equal(floodWaitSeconds(null), null);
  assert.equal(floodWaitSeconds(new Error('nothing to see')), null);
});

test('floodWaitSeconds falls back to parsing the server string', () => {
  const error = new Error('x');
  error.errorMessage = 'FLOOD_PREMIUM_WAIT_7';
  assert.equal(floodWaitSeconds(error), 7);
});

test('error classification', () => {
  assert.equal(isNotModified(Object.assign(new Error('x'), { errorMessage: 'MESSAGE_NOT_MODIFIED' })), true);
  assert.equal(isTransient(new Error('socket hang up')), true);
  assert.equal(isTransient(new Error('CHAT_WRITE_FORBIDDEN')), false);
  assert.equal(isPermanent(new BadRequestError('bad')), true);
  assert.equal(isPermanent(new Error('bad')), false);
});

test('withRetry retries transient failures then succeeds', async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls < 2) throw new Error('ECONNRESET');
    return 'ok';
  }, { retries: 2 });
  assert.equal(value, 'ok');
  assert.equal(calls, 2);
});

test('withRetry sleeps a short flood wait and retries', async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw new FloodWaitError(0);
    return 'done';
  }, { retries: 1 });
  assert.equal(value, 'done');
  assert.equal(calls, 2);
});

test('withRetry rethrows a long flood wait instead of parking a slot', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new FloodWaitError(999);
    }, { retries: 3, maxWaitSeconds: 10 }),
    /999 seconds/,
  );
  assert.equal(calls, 1);
});

test('withRetry never retries a malformed request', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new BadRequestError('socket MESSAGE_ID_INVALID');
    }, { retries: 3 }),
    /MESSAGE_ID_INVALID/,
  );
  assert.equal(calls, 1);
});
