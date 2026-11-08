import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortId } from '../src/text.ts';

test('tight creation does not reuse identifiers when the clock and weak RNG repeat', () => {
  const now = Date.now; const random = Math.random;
  try {
    Date.now = () => 12345;
    Math.random = () => 0.1;
    const ids = Array.from({ length: 10_000 }, () => shortId('t'));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => /^t-[a-z0-9]+$/.test(id)));
  } finally { Date.now = now; Math.random = random; }
});
