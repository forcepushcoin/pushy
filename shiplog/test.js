// node test.js — offline tests with a mock GitHub API (no network)
const assert = require('assert');
const S = require('./shiplog.js');
let pass = 0; const t = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('ok  ' + name); }, e => { console.error('FAIL ' + name + '\n' + e.stack); process.exitCode = 1; });

const NOW = Date.UTC(2026, 10, 3, 12);
const hdr = (o = {}) => ({ get: k => ({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '1793678866', ...o }[k.toLowerCase()] || null) });
function mockFetch(routes, calls) {
  return async (url) => {
    calls.push(url); const u = new URL(url); const key = u.pathname;
    const r = routes(key, u);
    if (!r) return { ok: false, status: 404, headers: hdr(), json: async () => ({ message: 'Not Found' }) };
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, headers: hdr(r.headers || {}), json: async () => r.body };
  };
}
const commit = (i, msg, login = 'alice', parents = 1) => ({ sha: ('a' + i).padEnd(40, '0'), commit: { message: msg, author: { date: '2026-10-2' + (i % 9) + 'T10:00:00Z', name: login } }, author: { login, type: 'User' }, parents: Array(parents).fill({}), html_url: 'https://github.com/o/r/commit/a' + i });
const pr = (n, title, login = 'alice', labels = []) => ({ number: n, title, user: { login, type: 'User' }, html_url: 'https://github.com/o/r/pull/' + n, pull_request: { merged_at: '2026-10-2' + (n % 9) + 'T10:00:00Z' }, labels: labels.map(name => ({ name })) });

(async () => {
  await t('parseInput', () => {
    assert.deepStrictEqual(S.parseInput('https://github.com/vercel/next.js/tree/canary?x=1'), { owner: 'vercel', repo: 'next.js' });
    assert.deepStrictEqual(S.parseInput('git@github.com:a/b.git'), { owner: 'a', repo: 'b' });
    assert.strictEqual(S.parseInput('nope'), null); assert.strictEqual(S.parseInput('a/..'), null);
  });
  await t('classify: prefix / label / keyword / other', () => {
    assert.strictEqual(S.classify('feat(ui): add button').type, 'feat');
    assert.strictEqual(S.classify('feat(ui): add button').scope, 'ui');
    assert.strictEqual(S.classify('feat(ui): add button').title, 'add button');
    assert.strictEqual(S.classify('Fix!: crash').type, 'fix');
    assert.strictEqual(S.classify('docs: typo').type, 'docs');
    assert.strictEqual(S.classify('ci: pin actions').type, 'chore');
    assert.strictEqual(S.classify('refactor(core): split').type, 'chore');
    assert.strictEqual(S.classify('Something odd', [{ name: 'bug' }]).type, 'fix');
    assert.strictEqual(S.classify('Something odd', [{ name: 'documentation' }]).how, 'label');
    assert.strictEqual(S.classify('Fixes the flaky test').type, 'fix');
    assert.strictEqual(S.classify('Bump lodash from 1 to 2', null, 'dependabot[bot]').type, 'chore');
    assert.strictEqual(S.classify('Add new server').type, 'feat');
    assert.strictEqual(S.classify('Weekend vibes').type, 'other');
    assert.strictEqual(S.classify('Note: this is not a type').type, 'other');
  });
  await t('fetch: PRs + releases + commits (5 calls, count call when 100 commits)', async () => {
    const calls = [];
    const commits = Array.from({ length: 100 }, (_, i) => commit(i, i % 2 ? 'fix: x' + i : 'feat: y' + i, i < 60 ? 'alice' : 'bob'));
    const f = mockFetch((p, u) => {
      if (p === '/repos/o/r') return { body: { full_name: 'o/r', stargazers_count: 1234, pushed_at: '2026-11-01T00:00:00Z', size: 10, html_url: 'https://github.com/o/r' } };
      if (p === '/repos/o/r/releases') return { body: [{ tag_name: 'v2.0.0', name: 'Two', published_at: '2026-10-30T10:00:00Z', html_url: 'https://github.com/o/r/releases/tag/v2.0.0' }, { tag_name: 'v1.0.0', name: 'Old', published_at: '2025-01-01T00:00:00Z', html_url: 'x' }, { tag_name: 'draft', draft: true, published_at: '2026-10-30T10:00:00Z' }] };
      if (p === '/search/issues') return { headers: { 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '9' }, body: { total_count: 3, items: [pr(1, 'feat: one'), pr(2, 'fix: two', 'bob'), pr(3, 'Update README', 'bob', [{ name: 'documentation' }].map(x => x.name))] } };
      if (p === '/repos/o/r/commits') return u.searchParams.get('per_page') === '1' ? { headers: { link: '<https://api.github.com/repositories/1/commits?since=x&per_page=1&page=387>; rel="last"' }, body: [commit(1, 'x')] } : { body: commits };
    }, calls);
    const d = await S.fetchShipData({ owner: 'o', repo: 'r' }, 30, { fetch: f, now: NOW });
    assert.strictEqual(calls.length, 5);
    assert(calls.some(c => c.includes('merged%3A%3E%3D2026-10-04')), 'search window day = now-30d: ' + calls.join('\n'));
    assert(calls.some(c => c.includes('since=2026-10-04T00%3A00%3A00.000Z')));
    const s = S.summarize(d);
    assert.strictEqual(s.source, 'prs'); assert.strictEqual(s.prCount, 3); assert.strictEqual(s.commitTotal, 387);
    assert.deepStrictEqual(s.counts, { feat: 1, fix: 1, docs: 1, chore: 0, other: 0 });
    assert.strictEqual(s.releases.length, 1); assert.strictEqual(s.releases[0].tag, 'v2.0.0');
    assert.deepStrictEqual(s.contributors.map(c => [c.user, c.n]), [['bob', 2], ['alice', 1]]); assert.strictEqual(s.contribBasis, 'prs');
    assert(s.commitsCapped && s.commitsExact);
    const md = S.toMarkdown(s);
    assert(/^# o\/r: shipped in the last 30 days/.test(md)); assert(md.includes('## Features (1)')); assert(md.includes('([#1](https://github.com/o/r/pull/1))'));
    assert(md.includes('[alice](https://github.com/alice)') && !/(^|\s)@alice/.test(md), 'no @mention pings');
    assert(md.includes('not an audit'));
  });
  await t('fetch: no PRs -> commit subjects, merge commits skipped, tags listed when repo has no releases', async () => {
    const calls = [];
    const f = mockFetch((p) => {
      if (p === '/repos/o/r') return { body: { full_name: 'o/r', size: 5, pushed_at: 'x' } };
      if (p === '/repos/o/r/releases') return { body: [] };
      if (p === '/repos/o/r/tags') return { body: [{ name: 'v0.3' }, { name: 'v0.2' }] };
      if (p === '/search/issues') return { body: { total_count: 0, items: [] } };
      if (p === '/repos/o/r/commits') return { body: [commit(1, 'feat: a'), commit(2, "Merge pull request #5 from x/y", 'a', 2), commit(3, 'wip stuff')] };
    }, calls);
    const d = await S.fetchShipData({ owner: 'o', repo: 'r' }, 7, { fetch: f, now: NOW });
    assert.strictEqual(calls.length, 5); // repo, releases, search, commits, tags
    const s = S.summarize(d);
    assert.strictEqual(s.source, 'commits'); assert.strictEqual(s.total, 2); assert.strictEqual(s.commitTotal, 3); assert.deepStrictEqual(s.tags, ['v0.3', 'v0.2']);
    assert(S.toMarkdown(s).includes('Latest tags'));
  });
  await t('hostile repo text is neutralised', async () => {
    const evil = '<img src=x onerror=alert(1)> [click](javascript:alert(1)) \u202e\u0000';
    const f = mockFetch((p) => {
      if (p === '/repos/o/r') return { body: { full_name: 'o/r', size: 1, pushed_at: 'x' } };
      if (p === '/repos/o/r/releases') return { body: [{ tag_name: evil, name: evil, published_at: '2026-11-01T00:00:00Z', html_url: 'javascript:alert(1)' }] };
      if (p === '/search/issues') return { body: { total_count: 1, items: [pr(1, evil, '<b>x</b>')] } };
      if (p === '/repos/o/r/commits') return { body: [] };
    }, []);
    const s = S.summarize(await S.fetchShipData({ owner: 'o', repo: 'r' }, 30, { fetch: f, now: NOW }));
    const md = S.toMarkdown(s);
    assert(!md.includes('<img') && !/\u202e/.test(md) && !md.includes('\u0000'));
    assert(!md.includes('[click]('), 'link syntax escaped');
    assert(!/(^|[^\\])\]\(javascript:/.test(md), 'no live javascript: links');
    assert(s.contributors[0].user.indexOf('<') < 0);
  });
  await t('errors: 404, rate limit, search limit, empty window', async () => {
    await assert.rejects(S.fetchShipData({ owner: 'o', repo: 'zz' }, 30, { fetch: mockFetch(() => null, []), now: NOW }), e => e.code === 'NOT_FOUND');
    await assert.rejects(S.fetchShipData({ owner: 'o', repo: 'r' }, 30, { fetch: mockFetch(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: { message: 'API rate limit exceeded' } }), []), now: NOW }), e => e.code === 'RATE_LIMIT' && e.reset === 1793678866000);
    const f = mockFetch((p) => {
      if (p === '/repos/o/r') return { body: { full_name: 'o/r', size: 1, pushed_at: 'x' } };
      if (p === '/search/issues') return { status: 403, headers: { 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '0' }, body: { message: 'rate limit exceeded' } };
      return { body: [] };
    }, []);
    await assert.rejects(S.fetchShipData({ owner: 'o', repo: 'r' }, 30, { fetch: f, now: NOW }), e => e.code === 'RATE_LIMIT' && /10 requests\/minute/.test(e.message));
    const f2 = mockFetch((p) => p === '/repos/o/r' ? { body: { full_name: 'o/r', size: 1, pushed_at: 'x' } } : p === '/search/issues' ? { body: { total_count: 0, items: [] } } : { body: [] }, []);
    const s = S.summarize(await S.fetchShipData({ owner: 'o', repo: 'r' }, 7, { fetch: f2, now: NOW }));
    assert(s.empty); assert(S.toMarkdown(s).includes('Nothing shipped'));
    const net = async () => { throw new Error('x'); };
    await assert.rejects(S.fetchShipData({ owner: 'o', repo: 'r' }, 7, { fetch: net, now: NOW }), e => e.code === 'NETWORK');
  });
  console.log(pass + ' passed' + (process.exitCode ? ', FAILURES' : ''));
})();
