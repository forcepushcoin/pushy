/* Pushy Ship Log — what a public GitHub repo shipped in the last 7/30/90 days.
   Pure client-side, unauthenticated GitHub API, no LLM. Works in the browser (window.PushyShiplog) and in node (module.exports) for tests.
   Calls (typical 5, max ~7): repo, releases, search (merged PRs, 1-2 pages), commits (latest 100 in window), commit count (only if >100), tags (only if the repo has no releases). */
(function (root) {
  'use strict';
  var VERSION = '1.0.0';
  var WINDOWS = [7, 30, 90];
  var LIMITS = { prPages: 2, perPage: 100 };
  var TYPES = ['feat', 'fix', 'docs', 'chore', 'other'];
  var TYPE_NAMES = { feat: 'Features', fix: 'Fixes', docs: 'Docs', chore: 'Chores & maintenance', other: 'Other' };

  /* ------------------------------------------------------------ input */
  function parseInput(str) {
    if (!str) return null;
    var s = String(str).trim().replace(/^<|>$/g, '');
    s = s.replace(/^git@github\.com:/i, 'github.com/').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
    s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    var parts = s.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    var owner = parts[0], repo = parts[1];
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
    return { owner: owner, repo: repo };
  }

  /* ------------------------------------------------------------ text safety */
  function clean(s, max) { // strip control / bidi chars, collapse whitespace, cap length
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function mdText(s) { return clean(s).replace(/[<>]/g, function (c) { return c === '<' ? '&lt;' : '&gt;'; }).replace(/\[/g, '\\[').replace(/\]/g, '\\]'); }
  function ghUrl(u) { u = String(u || ''); return /^https:\/\/github\.com\/[^\s)<>]*$/.test(u) ? u : null; }
  function safeLogin(s) { s = String(s == null ? '' : s); return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(s) ? s : clean(s, 40).replace(/[^A-Za-z0-9._\- \[\]]/g, '') || '?'; }

  /* ------------------------------------------------------------ classification */
  var CONV = /^\s*(?:\[?([A-Za-z]+)\]?)(?:\s*\(([^)]*)\))?(!)?\s*:\s*(.+)$/;
  var TYPE_MAP = { feat: 'feat', feature: 'feat', features: 'feat', fix: 'fix', fixes: 'fix', bugfix: 'fix', hotfix: 'fix', docs: 'docs', doc: 'docs', documentation: 'docs',
    chore: 'chore', ci: 'chore', build: 'chore', test: 'chore', tests: 'chore', refactor: 'chore', style: 'chore', perf: 'chore', deps: 'chore', dep: 'chore', revert: 'chore', release: 'chore', bump: 'chore', lint: 'chore', cleanup: 'chore', infra: 'chore', example: 'docs', examples: 'docs', typo: 'docs' };
  var LABEL_MAP = [[/^(bug|bugfix|fix|regression)/i, 'fix'], [/^(documentation|docs?)$/i, 'docs'], [/^(enhancement|feature|feat|new feature)/i, 'feat'], [/^(dependencies|chore|maintenance|ci|refactor|tests?)$/i, 'chore']];
  /* classify(title, labels?, author?) -> { type, scope, title, how }  how = 'prefix' | 'label' | 'keyword' | 'none' */
  function classify(title, labels, author) {
    var t = clean(title), m = CONV.exec(t), type = null, scope = '', how = 'none', shown = t;
    if (m && TYPE_MAP[m[1].toLowerCase()]) { type = TYPE_MAP[m[1].toLowerCase()]; scope = clean(m[2] || '', 40); shown = m[4].trim(); how = 'prefix'; }
    if (!type && Array.isArray(labels)) {
      outer: for (var i = 0; i < labels.length; i++) { var n = labels[i] && (labels[i].name || labels[i]) || ''; for (var j = 0; j < LABEL_MAP.length; j++) if (LABEL_MAP[j][0].test(String(n))) { type = LABEL_MAP[j][1]; how = 'label'; break outer; } }
    }
    if (!type) {
      var low = t.toLowerCase();
      if (/^(bump|update|upgrade|chore|merge)\b/.test(low) || /^(deps?|dependabot|renovate)/i.test(String(author || '')) || /\[bot\]$/i.test(String(author || '')) && /^(bump|update|chore|build|ci|pin|lock)/.test(low)) { type = 'chore'; how = 'keyword'; }
      else if (/^(fix(es|ed)?|bugfix|resolve[sd]?|patch)\b/.test(low)) { type = 'fix'; how = 'keyword'; }
      else if (/^(docs?|documentation|readme|typo)\b/.test(low)) { type = 'docs'; how = 'keyword'; }
      else if (/^(add(s|ed)?|implement(s|ed)?|introduce[sd]?|support|new)\b/.test(low)) { type = 'feat'; how = 'keyword'; }
    }
    return { type: type || 'other', scope: scope, title: shown, how: how };
  }

  /* ------------------------------------------------------------ errors + API */
  function ShipError(code, message, extra) { var e = new Error(message); e.code = code; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
  function makeApi(opts) {
    var f = opts.fetch || root.fetch.bind(root), token = opts.token;
    var rate = { limit: null, remaining: null, reset: null, used: 0, lastPage: null };
    async function gh(path, soft) {
      var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var res;
      try { res = await f('https://api.github.com' + path, { headers: headers }); }
      catch (e) { throw ShipError('NETWORK', 'Could not reach api.github.com. Check your connection (or an ad-blocker) and try again.'); }
      var lim = res.headers.get('x-ratelimit-limit'), rem = res.headers.get('x-ratelimit-remaining'), rst = res.headers.get('x-ratelimit-reset'), res_ = res.headers.get('x-ratelimit-resource');
      if (res_ !== 'search') { if (lim) rate.limit = +lim; if (rem) rate.remaining = +rem; if (rst) rate.reset = +rst; }
      rate.used++;
      var lk = res.headers.get('link'), lm = lk && /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(lk);
      var out = { lastPage: lm ? +lm[1] : null };
      if (res.ok) { out.data = await res.json(); return out; }
      var body = {}; try { body = await res.json(); } catch (e) {}
      var msg = (body && body.message) || '';
      if ((res.status === 403 || res.status === 429) && (rem === '0' || /rate limit|abuse|secondary/i.test(msg)))
        throw ShipError('RATE_LIMIT', res_ === 'search' ? 'GitHub\'s search limit (10 requests/minute) was hit. Wait a minute and try again.' : 'GitHub\'s anonymous API limit (60 requests/hour per IP) is used up.', { reset: rst ? +rst * 1000 : null });
      if (soft) return null;
      if (res.status === 404) throw ShipError('NOT_FOUND', 'No public repository found there. It may be private, renamed, or misspelled.');
      if (res.status === 409) throw ShipError('EMPTY', 'That repository is empty, so there is nothing to summarize.');
      if (res.status === 451) throw ShipError('UNAVAILABLE', 'GitHub says this repository is unavailable for legal reasons.');
      if (res.status === 401) throw ShipError('BAD_TOKEN', 'GitHub rejected that token. Clear it or paste a fresh one.');
      throw ShipError('HTTP', 'GitHub returned ' + res.status + (msg ? ' (' + clean(msg, 120) + ')' : '') + '.');
    }
    return { gh: gh, rate: rate };
  }

  function dayStart(daysAgo, now) { var d = new Date(now); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - daysAgo); return d; }
  function ymd(d) { return d.toISOString().slice(0, 10); }

  /* fetchShipData: raw-ish, slimmed data for one window. */
  async function fetchShipData(parsed, days, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), since = dayStart(days, now), sinceIso = since.toISOString();
    var api = makeApi(opts), say = opts.onProgress || function () {};
    var o = encodeURIComponent(parsed.owner), r = encodeURIComponent(parsed.repo), base = '/repos/' + o + '/' + r;
    say('Looking up ' + parsed.owner + '/' + parsed.repo + '…');
    var repoRes = await api.gh(base), repo = repoRes.data;
    var full = repo.full_name || (parsed.owner + '/' + parsed.repo);
    if (repo.size === 0 && !repo.pushed_at) throw ShipError('EMPTY', 'That repository is empty, so there is nothing to summarize.');
    say('Reading releases, merged PRs and commits…');
    var q = encodeURIComponent('repo:' + full + ' is:pr is:merged merged:>=' + ymd(since));
    var relP = api.gh(base + '/releases?per_page=30', true).catch(rethrowRate);
    var prP = api.gh('/search/issues?q=' + q + '&sort=updated&order=desc&per_page=100&page=1', true).catch(rethrowRate);
    var comP = api.gh(base + '/commits?since=' + encodeURIComponent(sinceIso) + '&per_page=100', true).catch(rethrowRate);
    var rel = await relP, pr = await prP, com = await comP;
    if (!com && !rel && !pr) throw ShipError('HTTP', 'GitHub did not return any data for this repository.');
    if (rel === undefined) rel = null;
    // PRs: search gives total_count + up to 100 items per page
    var prItems = [], prTotal = null, prErr = !pr;
    if (pr && pr.data) { prItems = pr.data.items || []; prTotal = pr.data.total_count || 0; if (pr.data.incomplete_results) prErr = false; }
    if (pr && prItems.length === 100 && prTotal > 100 && LIMITS.prPages > 1) {
      say('Fetching more merged PRs…');
      var pr2 = await api.gh('/search/issues?q=' + q + '&sort=updated&order=desc&per_page=100&page=2', true).catch(rethrowRate);
      if (pr2 && pr2.data && pr2.data.items) prItems = prItems.concat(pr2.data.items);
    }
    // commits: latest 100 since the window start; exact total needs one more call (per_page=1 + Link header) only when 100 came back
    var commits = (com && Array.isArray(com.data)) ? com.data : [], commitTotal = commits.length, commitsExact = true;
    if (commits.length >= 100) {
      var cnt = await api.gh(base + '/commits?since=' + encodeURIComponent(sinceIso) + '&per_page=1', true).catch(rethrowRate);
      if (cnt && cnt.lastPage) commitTotal = cnt.lastPage; else if (cnt && Array.isArray(cnt.data)) commitTotal = Math.max(commits.length, cnt.data.length);
      else commitsExact = false;
    }
    if (!com) commitsExact = false;
    var releases = (rel && Array.isArray(rel.data) ? rel.data : []).filter(function (x) { return !x.draft; }).map(function (x) {
      return { tag: clean(x.tag_name, 80), name: clean(x.name || x.tag_name, 120), date: x.published_at || x.created_at || null, pre: !!x.prerelease, url: ghUrl(x.html_url) };
    });
    var tags = null;
    if (rel && Array.isArray(rel.data) && rel.data.length === 0) {
      var tg = await api.gh(base + '/tags?per_page=8', true).catch(rethrowRate);
      if (tg && Array.isArray(tg.data)) tags = tg.data.map(function (x) { return clean(x.name, 80); });
    }
    return {
      v: 1, t: now, days: days, since: sinceIso, apiCalls: api.rate.used, rate: { remaining: api.rate.remaining, limit: api.rate.limit, reset: api.rate.reset },
      repo: { full_name: clean(full, 140), stars: repo.stargazers_count || 0, archived: !!repo.archived, fork: !!repo.fork, html_url: ghUrl(repo.html_url) || ('https://github.com/' + full.replace(/[^A-Za-z0-9._\/-]/g, '')), default_branch: repo.default_branch || 'main', pushed_at: repo.pushed_at || null },
      releases: releases, releasesRaw: rel && Array.isArray(rel.data) ? rel.data.length : 0, tags: tags,
      prs: prItems.filter(function (x) { return x && x.pull_request; }).map(function (x) {
        return { n: x.number, title: clean(x.title, 200), user: safeLogin(x.user && x.user.login), bot: !!(x.user && x.user.type === 'Bot'), at: x.pull_request && x.pull_request.merged_at || x.closed_at || null, url: ghUrl(x.html_url), labels: (x.labels || []).map(function (l) { return clean(l && l.name, 40); }).slice(0, 8) };
      }),
      prTotal: prTotal, prFailed: prErr,
      commits: commits.map(function (c) {
        var cm = c.commit || {}, msg = String(cm.message || ''), nl = msg.indexOf('\n');
        return { sha: String(c.sha || '').slice(0, 7), s: clean(nl < 0 ? msg : msg.slice(0, nl), 200), d: (cm.author && cm.author.date) || (cm.committer && cm.committer.date) || null,
          u: safeLogin((c.author && c.author.login) || (cm.author && cm.author.name) || '?'), bot: !!(c.author && c.author.type === 'Bot') || /\[bot\]$/i.test((c.author && c.author.login) || ''), p: (c.parents && c.parents.length) || 0, url: ghUrl(c.html_url) };
      }),
      commitTotal: commitTotal, commitsExact: commitsExact
    };
  }
  function rethrowRate(e) { if (e && e.code === 'RATE_LIMIT') throw e; return null; }

  /* ------------------------------------------------------------ summarize */
  function isMergeNoise(s) { return /^merge (pull request|branch|remote-tracking)/i.test(s); }
  /* summarize(data) -> counts, grouped items, contributors */
  function summarize(d) {
    var groups = {}; TYPES.forEach(function (t) { groups[t] = []; });
    var source, items = [];
    if (d.prs.length) {
      source = 'prs';
      d.prs.forEach(function (p) { var c = classify(p.title, p.labels, p.user); items.push({ type: c.type, scope: c.scope, title: c.title, user: p.user, bot: p.bot, n: p.n, url: p.url, at: p.at, how: c.how }); });
    } else {
      source = 'commits';
      d.commits.forEach(function (c) { if (c.p > 1 || isMergeNoise(c.s)) return; var k = classify(c.s, null, c.u); items.push({ type: k.type, scope: k.scope, title: k.title, user: c.u, bot: c.bot, sha: c.sha, url: c.url, at: c.d, how: k.how }); });
    }
    items.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    items.forEach(function (it) { groups[it.type].push(it); });
    var counts = {}; TYPES.forEach(function (t) { counts[t] = groups[t].length; });
    // Contributors: PR authors when we have merged PRs (merge-commit repos credit the merger, not the author); else non-merge commit authors
    var byUser = {}, contribBasis = d.prs.length ? 'prs' : 'commits';
    if (contribBasis === 'prs') d.prs.forEach(function (p) { byUser[p.user] = byUser[p.user] || { user: p.user, n: 0, bot: p.bot }; byUser[p.user].n++; });
    else d.commits.forEach(function (c) { if (c.p > 1) return; byUser[c.u] = byUser[c.u] || { user: c.u, n: 0, bot: c.bot }; byUser[c.u].n++; });
    var contributors = Object.keys(byUser).map(function (k) { return byUser[k]; }).sort(function (a, b) { return (b.n - a.n) || (a.user < b.user ? -1 : 1); });
    var humans = contributors.filter(function (c) { return !c.bot; });
    var rels = d.releases.filter(function (r) { return r.date && new Date(r.date) >= new Date(d.since); });
    var relCapped = d.releasesRaw >= 30 && d.releases.length >= 30 && rels.length === d.releases.length;
    var prCount = d.prTotal != null ? d.prTotal : d.prs.length;
    var empty = !items.length && !rels.length && !d.commitTotal;
    var kinds = d.prs.length ? 'merged PRs' : 'commits';
    return {
      repo: d.repo.full_name, days: d.days, since: d.since.slice(0, 10), until: new Date(d.t).toISOString().slice(0, 10), source: source, kinds: kinds,
      counts: counts, total: items.length, groups: groups, prCount: prCount, prShown: d.prs.length, prCapped: d.prTotal != null && d.prTotal > d.prs.length,
      commitTotal: d.commitTotal, commitsExact: d.commitsExact, commitsSampled: d.commits.length, commitsCapped: d.commitTotal > d.commits.length,
      releases: rels, releasesCapped: relCapped, tags: d.tags, contributors: contributors, humans: humans, contribBasis: contribBasis, contribCapped: contribBasis === 'prs' ? (d.prTotal != null && d.prTotal > d.prs.length) : d.commitTotal > d.commits.length, empty: empty,
      stars: d.repo.stars, archived: d.repo.archived, html_url: d.repo.html_url, prFailed: d.prFailed
    };
  }

  /* ------------------------------------------------------------ markdown */
  function toMarkdown(s, opts) {
    opts = opts || {};
    var L = [], url = s.html_url;
    L.push('# ' + mdText(s.repo) + ': shipped in the last ' + s.days + ' days');
    L.push(''); L.push('_' + s.since + ' → ' + s.until + ' · ' + (s.prCount ? s.prCount + ' merged PRs · ' : '') + (s.commitTotal ? s.commitTotal + (s.commitsExact ? '' : '+') + ' commits · ' : '') + s.releases.length + (s.releasesCapped ? '+' : '') + ' releases_');
    if (s.empty) { L.push(''); L.push('Nothing shipped in this window.'); }
    if (s.releases.length) {
      L.push(''); L.push('## Releases');
      s.releases.forEach(function (r) { L.push('- ' + (r.url ? '[' + mdText(r.name || r.tag) + '](' + r.url + ')' : mdText(r.name || r.tag)) + (r.date ? ' (' + r.date.slice(0, 10) + ')' : '') + (r.pre ? ' _pre-release_' : '')); });
    } else if (s.tags && s.tags.length) {
      L.push(''); L.push('## Latest tags (GitHub does not date them in the list)');
      s.tags.forEach(function (t) { L.push('- ' + mdText(t)); });
    }
    TYPES.forEach(function (t) {
      var g = s.groups[t]; if (!g.length) return;
      L.push(''); L.push('## ' + TYPE_NAMES[t] + ' (' + g.length + ')');
      g.forEach(function (it) {
        var ref = it.n && it.url ? ' ([#' + it.n + '](' + it.url + '))' : (it.sha && it.url ? ' ([`' + it.sha + '`](' + it.url + '))' : '');
        L.push('- ' + (it.scope ? '**' + mdText(it.scope) + ':** ' : '') + mdText(it.title) + ref + ' by [' + it.user + '](https://github.com/' + encodeURIComponent(it.user.replace(/\[bot\]$/, '')) + ')');
      });
    });
    if (s.contributors.length) {
      L.push(''); L.push('## Top contributors' + (s.contribCapped ? (s.contribBasis === 'prs' ? ' (latest ' + s.prShown + ' merged PRs)' : ' (latest ' + s.commitsSampled + ' commits)') : ''));
      s.contributors.slice(0, 10).forEach(function (c) { L.push('- [' + c.user + '](https://github.com/' + encodeURIComponent(c.user.replace(/\[bot\]$/, '')) + '): ' + c.n + (s.contribBasis === 'commits' ? ' commits' : ' PRs')); });
    }
    L.push(''); L.push('_Automated summary by [Pushy Ship Log](' + (opts.siteUrl || 'https://forcepushcoin.github.io/shiplog/') + '), not an audit._');
    return L.join('\n') + '\n';
  }

  var api = { VERSION: VERSION, WINDOWS: WINDOWS, TYPES: TYPES, TYPE_NAMES: TYPE_NAMES, parseInput: parseInput, classify: classify, fetchShipData: fetchShipData, summarize: summarize, toMarkdown: toMarkdown, clean: clean, mdText: mdText, ymd: ymd };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PushyShiplog = api;
})(typeof window !== 'undefined' ? window : globalThis);
