'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../bounties/bounties.js');

const NOW = Date.UTC(2026, 10, 3, 12);
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const issue = (o) => Object.assign({ number: 1, title: 'bounty: a rule', state: 'open', html_url: 'https://github.com/forcepushcoin/pushy/issues/1', labels: [{ name: 'bounty' }], body: '', user: { login: 'alice' }, created_at: day(3), updated_at: day(1), closed_at: null, comments: 0 }, o);

test('parseRewardText: amounts with units, currency symbols, thousands and k; rejects prose and bare numbers', () => {
  assert.deepEqual(B.parseRewardText('500 USDC'), { text: '500 USDC', amount: 500, unit: 'USDC', tbd: false });
  assert.equal(B.parseRewardText('$200').unit, 'USD');
  assert.equal(B.parseRewardText('1,000 $FORCEPUSH').amount, 1000);
  assert.equal(B.parseRewardText('2k USDC').amount, 2000);
  assert.equal(B.parseRewardText('**250 USDC**.').text, '250 USDC');
  assert.equal(B.parseRewardText('TBD').tbd, true);
  for (const bad of ['500', 'a million dollars', '', null, '0 USDC', 'click http://x.example 500 USDC', '9'.repeat(30) + ' USDC']) assert.equal(B.parseRewardText(bad), null, String(bad));
});

test('parseReward: a maintainer label is confirmed and wins over the body', () => {
  const r = B.parseReward(issue({ labels: [{ name: 'bounty' }, { name: 'reward: 300 USDC' }], body: 'Reward: 9999 USDC' }));
  assert.equal(r.text, '300 USDC'); assert.equal(r.confirmed, true); assert.equal(r.source, 'label');
});
test('parseReward: body line, form heading and title are "as written by the author" and never confirmed', () => {
  let r = B.parseReward(issue({ body: 'Some text\n**Reward:** 100 USDC\nmore' }));
  assert.equal(r.text, '100 USDC'); assert.equal(r.confirmed, false); assert.equal(r.source, 'body');
  r = B.parseReward(issue({ body: '### Reward\n\n50 USDC\n\n### Other' })); assert.equal(r.text, '50 USDC');
  r = B.parseReward(issue({ title: 'bounty: new rule [Reward: 75 USDC]' })); assert.equal(r.text, '75 USDC'); assert.equal(r.source, 'title');
  assert.equal(B.parseReward(issue({ body: 'The reward would be nice' })), null);
  assert.equal(B.parseReward(issue({ body: 'Reward: lots of money' })), null);
  assert.equal(B.parseReward(issue({ body: null, labels: [] })), null);
});

test('statusOf: proposed -> open -> claimed -> paid, closed without paid is closed', () => {
  const L = (...n) => n.map((name) => ({ name }));
  assert.equal(B.statusOf(issue({ labels: L('bounty') })), 'proposed');
  assert.equal(B.statusOf(issue({ labels: L('bounty', 'bounty-accepted') })), 'open');
  assert.equal(B.statusOf(issue({ labels: L('bounty', 'bounty-accepted', 'bounty-claimed') })), 'claimed');
  assert.equal(B.statusOf(issue({ labels: L('bounty', 'Bounty-Paid'), state: 'closed' })), 'paid');
  assert.equal(B.statusOf(issue({ labels: L('bounty', 'bounty-accepted'), state: 'closed' })), 'closed');
});

test('normalize: strips the title prefix, forces a canonical issue URL, hides plumbing labels, cleans text', () => {
  const n = B.normalize(issue({ number: 7, title: 'bounty:  Fix\u202e  FP\n', html_url: 'https://evil.example/x', labels: [{ name: 'bounty' }, { name: 'bounty-accepted' }, { name: 'reward: 5 USDC' }, { name: 'rules' }], user: { login: 'bo<b>' } }));
  assert.equal(n.title, 'Fix FP');
  assert.equal(n.url, 'https://github.com/forcepushcoin/pushy/issues/7');
  assert.deepEqual(n.labels, ['rules']);
  assert.equal(n.status, 'open');
});

test('organise: open first (accepted, claimed, proposed), closed newest first and only the last 90 days', () => {
  const items = [
    issue({ number: 1, labels: [{ name: 'bounty' }] }),
    issue({ number: 2, labels: [{ name: 'bounty' }, { name: 'bounty-accepted' }] }),
    issue({ number: 3, labels: [{ name: 'bounty' }, { name: 'bounty-claimed' }] }),
    issue({ number: 4, state: 'closed', closed_at: day(10), labels: [{ name: 'bounty' }, { name: 'bounty-paid' }] }),
    issue({ number: 5, state: 'closed', closed_at: day(2) }),
    issue({ number: 6, state: 'closed', closed_at: day(200) })
  ].map(B.normalize);
  const o = B.organise(items, NOW);
  assert.deepEqual(o.open.map((x) => x.number), [2, 3, 1]);
  assert.deepEqual(o.closed.map((x) => x.number), [5, 4]);
  assert.equal(o.hiddenOld, 1);
});

function mockFetch(status, body, headers) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (headers || {})[k.toLowerCase()] ?? null }, json: async () => body }; };
  f.calls = calls; return f;
}

test('fetchBounties: one request, pull requests are skipped, empty list is fine', async () => {
  const f = mockFetch(200, [issue({ number: 3 }), issue({ number: 4, pull_request: {} })], { 'x-ratelimit-remaining': '58', 'x-ratelimit-limit': '60' });
  const d = await B.fetchBounties({ fetch: f, now: NOW });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /^https:\/\/api\.github\.com\/repos\/forcepushcoin\/pushy\/issues\?labels=bounty&state=all/);
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(d.open.map((x) => x.number), [3]);
  assert.equal(d.rate.remaining, 58);
  const e = await B.fetchBounties({ fetch: mockFetch(200, []), now: NOW });
  assert.deepEqual([e.open.length, e.closed.length, e.capped], [0, 0, false]);
});

test('fetchBounties: token goes in the Authorization header only when given', async () => {
  const f = mockFetch(200, []); await B.fetchBounties({ fetch: f, token: 'tok123' });
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok123');
});

test('fetchBounties: rate limit, 404, 500 and network failures give clear error codes', async () => {
  await assert.rejects(B.fetchBounties({ fetch: mockFetch(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }) }), (e) => e.code === 'RATE_LIMIT' && e.reset === 1800000000000);
  await assert.rejects(B.fetchBounties({ fetch: mockFetch(404, {}) }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(B.fetchBounties({ fetch: mockFetch(500, {}) }), (e) => e.code === 'HTTP');
  await assert.rejects(B.fetchBounties({ fetch: mockFetch(403, {}, { 'x-ratelimit-remaining': '10' }) }), (e) => e.code === 'HTTP');
  await assert.rejects(B.fetchBounties({ fetch: async () => { throw new Error('offline'); } }), (e) => e.code === 'NETWORK');
  await assert.rejects(B.fetchBounties({ fetch: mockFetch(200, { message: 'x' }) }), (e) => e.code === 'HTTP');
});

test('validWallet: only base58 of 32-44 characters; solscanUrl follows', () => {
  const ok = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  assert.equal(B.validWallet(ok), true);
  assert.equal(B.solscanUrl(ok), 'https://solscan.io/account/' + ok);
  for (const bad of ['', 'short', ok + 'x'.repeat(5), '0'.repeat(40), 'O'.repeat(40), null, undefined, ok + '/../x']) { assert.equal(B.validWallet(bad), false, String(bad)); assert.equal(B.solscanUrl(bad), null); }
});
