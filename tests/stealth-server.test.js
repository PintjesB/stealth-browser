'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.CONTEXTS_DIR = path.join(os.tmpdir(), 'stealth-browser-unit-tests');

const {
  clampTimeout,
  domainOf,
  normalizeActions,
  normalizeDomain,
  normalizeScrapeUrl,
  normalizeSelector,
  parseBody,
} = require('../stealth-server');

test('normalizeDomain canonicalizes hostnames', () => {
  assert.equal(normalizeDomain(' WWW.Example.COM '), 'example.com');
});

test('normalizeDomain rejects malformed domains', () => {
  assert.throws(() => normalizeDomain('bad..example.com'), /invalid domain/);
  assert.throws(() => normalizeDomain(''), /invalid domain/);
});

test('domainOf extracts normalized host and tolerates invalid input', () => {
  assert.equal(domainOf('https://www.Example.com/path'), 'example.com');
  assert.equal(domainOf('not a url'), 'unknown');
});

test('parseBody accepts empty and object JSON bodies', () => {
  assert.deepEqual(parseBody([]), {});
  assert.deepEqual(parseBody([Buffer.from('{"url":"https://example.com"}')]), {
    url: 'https://example.com',
  });
});

test('parseBody rejects non-object JSON', () => {
  assert.throws(() => parseBody([Buffer.from('[]')]), /JSON object/);
});

test('clampTimeout applies defaults and bounds', () => {
  assert.equal(clampTimeout('invalid'), 30000);
  assert.equal(clampTimeout(1), 1000);
  assert.equal(clampTimeout(5000.4), 5000);
  assert.equal(clampTimeout(999999), 120000);
});

test('normalizeSelector trims and validates selectors', () => {
  assert.equal(normalizeSelector('  #login  '), '#login');
  assert.throws(() => normalizeSelector(''), /required/);
  assert.throws(() => normalizeSelector('x'.repeat(301)), /too long/);
});

test('normalizeActions normalizes supported actions', () => {
  assert.deepEqual(
    normalizeActions([
      { type: 'wait', ms: 250 },
      { type: 'click', selector: ' #go ', timeout: 200 },
      { type: 'type', selector: '#name', value: 42 },
      { type: 'scroll' },
    ]),
    [
      { type: 'wait', ms: 1000 },
      { type: 'click', selector: '#go', timeout: 1000 },
      { type: 'type', selector: '#name', value: '42' },
      { type: 'scroll' },
    ],
  );
});

test('normalizeActions bounds work and rejects unsupported types', () => {
  const actions = Array.from({ length: 30 }, () => ({ type: 'scroll' }));
  assert.equal(normalizeActions(actions).length, 25);
  assert.throws(() => normalizeActions([{ type: 'execute_script' }]), /unsupported action/);
  assert.throws(() => normalizeActions(null), /must be an array/);
});

test('normalizeScrapeUrl accepts only HTTP(S)', () => {
  assert.equal(normalizeScrapeUrl('https://example.com/a'), 'https://example.com/a');
  assert.throws(() => normalizeScrapeUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => normalizeScrapeUrl('not a url'), /invalid url/);
});
