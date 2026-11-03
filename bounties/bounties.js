/* Pushy Bounty board: read bounty issues from the public GitHub API and normalise them.
   Pure functions plus one fetch helper. Works in the browser (window.PushyBounties) and in node (module.exports) for tests.
   No backend, no wallet logic beyond validating an address the maintainers publish in app.js. */
(function (root) {
  'use strict';
  var VERSION = '1.0.0';
  var REPO = 'forcepushcoin/pushy';
  var LABEL = 'bounty';
  var STATUS_LABELS = { accepted: 'bounty-accepted', claimed: 'bounty-claimed', paid: 'bounty-paid' };
  var MAX = 100, CLOSED_DAYS = 90;

  function clean(s, max) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /* A reward is an amount plus an optional unit ("500 USDC", "$200", "1,000 $FORCEPUSH") or "TBD". Anything else is ignored,
     so a stray sentence can never show up as a reward. Returns null or { text, amount, unit, tbd }. */
  function parseRewardText(raw) {
    var s = clean(String(raw == null ? '' : raw).replace(/[*_`~]/g, ''), 80).replace(/[.,;]+$/, '');
    if (!s) return null;
    if (/^(tbd|to be (?:announced|decided|determined)|n\/a|none|-)$/i.test(s)) return { text: 'TBD', amount: null, unit: null, tbd: true };
    var m = /^([$€£]?)\s?(\d{1,3}(?:[,_]\d{3})+|\d+)(\.\d{1,2})?\s?([kK]?)\s*(\$?[A-Za-z][A-Za-z0-9$]{0,14})?(?:\s*\([^)]{0,24}\))?$/.exec(s);
    if (!m) return null;
    var n = parseFloat(m[2].replace(/[,_]/g, '') + (m[3] || ''));
    if (m[4]) n *= 1000;
    if (!isFinite(n) || n <= 0 || n > 1e12) return null;
    var unit = m[5] || null;
    if (!unit && !m[1]) return null; // a bare number says nothing
    return { text: s, amount: n, unit: unit || (m[1] === '$' ? 'USD' : m[1] === '€' ? 'EUR' : 'GBP'), tbd: false };
  }

  /* Reward sources, strongest first:
     1. a label "reward: <amount>" (only maintainers can set labels) -> confirmed
     2. a "Reward: <amount>" line or "### Reward" section in the body, or "Reward: <amount>" in the title -> as written by the issue author */
  function parseReward(issue) {
    var labels = labelNames(issue), i, m, r;
    for (i = 0; i < labels.length; i++) {
      m = /^reward\s*[:=]\s*(.+)$/i.exec(labels[i]);
      if (m && (r = parseRewardText(m[1]))) { r.source = 'label'; r.confirmed = true; return r; }
    }
    var body = String((issue && issue.body) || '').slice(0, 20000), title = String((issue && issue.title) || '');
    m = /^[ \t>*_#-]*\**reward\**[ \t]*:[ \t]*(.+)$/im.exec(body);
    if (m && (r = parseRewardText(m[1]))) { r.source = 'body'; r.confirmed = false; return r; }
    m = /^#{1,4}[ \t]*reward[ \t]*\r?\n+[ \t]*([^\r\n]+)/im.exec(body);
    if (m && (r = parseRewardText(m[1]))) { r.source = 'body'; r.confirmed = false; return r; }
    m = /\breward\s*:\s*([^\]\)|]+)/i.exec(title);
    if (m && (r = parseRewardText(m[1]))) { r.source = 'title'; r.confirmed = false; return r; }
    return null;
  }

  function labelNames(issue) {
    return ((issue && issue.labels) || []).map(function (l) { return clean(typeof l === 'string' ? l : l && l.name, 50); }).filter(Boolean);
  }
  /* proposed (submitted, not reviewed) -> open (bounty-accepted) -> claimed -> paid; closed issues without bounty-paid are "closed" */
  function statusOf(issue) {
    var ls = labelNames(issue).map(function (x) { return x.toLowerCase(); });
    var has = function (k) { return ls.indexOf(STATUS_LABELS[k]) >= 0; };
    if (has('paid')) return 'paid';
    if (issue.state === 'closed') return 'closed';
    if (has('claimed')) return 'claimed';
    if (has('accepted')) return 'open';
    return 'proposed';
  }
  function safeIssueUrl(u, n) {
    var want = 'https://github.com/' + REPO + '/issues/' + n;
    return u === want ? u : want;
  }
  function normalize(issue) {
    var n = issue.number, title = clean(issue.title, 140).replace(/^bounty\s*:\s*/i, '');
    var known = {}; Object.keys(STATUS_LABELS).forEach(function (k) { known[STATUS_LABELS[k]] = 1; });
    known[LABEL] = 1;
    return {
      number: n, title: title || '(untitled)', url: safeIssueUrl(issue.html_url, n), state: issue.state === 'closed' ? 'closed' : 'open',
      status: statusOf(issue), reward: parseReward(issue),
      author: clean(issue.user && issue.user.login, 40), createdAt: issue.created_at || null, updatedAt: issue.updated_at || null, closedAt: issue.closed_at || null,
      labels: labelNames(issue).filter(function (l) { return !known[l.toLowerCase()] && !/^reward\s*[:=]/i.test(l); }).slice(0, 4),
      comments: issue.comments | 0
    };
  }

  /* open ones first (accepted > claimed > proposed), then recently closed (last CLOSED_DAYS days) */
  var ORDER = { open: 0, claimed: 1, proposed: 2, paid: 3, closed: 4 };
  function organise(items, now) {
    var cutoff = (now || Date.now()) - CLOSED_DAYS * 86400000;
    var live = items.filter(function (x) { return x.state === 'open'; });
    var done = items.filter(function (x) { return x.state === 'closed' && (!x.closedAt || Date.parse(x.closedAt) >= cutoff); });
    live.sort(function (a, b) { return ORDER[a.status] - ORDER[b.status] || b.number - a.number; });
    done.sort(function (a, b) { return Date.parse(b.closedAt || 0) - Date.parse(a.closedAt || 0) || b.number - a.number; });
    return { open: live, closed: done, hiddenOld: items.length - live.length - done.length };
  }

  function PushyError(code, message, extra) { var e = new Error(message); e.code = code; if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; }); return e; }

  async function fetchBounties(opts) {
    opts = opts || {};
    var f = opts.fetch || root.fetch.bind(root), now = opts.now || Date.now();
    var url = 'https://api.github.com/repos/' + REPO + '/issues?labels=' + LABEL + '&state=all&sort=updated&direction=desc&per_page=' + MAX;
    var headers = { Accept: 'application/vnd.github+json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    var res;
    try { res = await f(url, { headers: headers }); }
    catch (e) { throw PushyError('NETWORK', 'Could not reach api.github.com. An ad-blocker or an offline network can cause this.'); }
    var rate = { remaining: numHeader(res, 'x-ratelimit-remaining'), limit: numHeader(res, 'x-ratelimit-limit'), reset: numHeader(res, 'x-ratelimit-reset') };
    if (res.status === 403 || res.status === 429) {
      if (rate.remaining === 0 || res.status === 429) throw PushyError('RATE_LIMIT', 'GitHub\'s anonymous API limit (60 requests per hour per IP) is used up.', { reset: rate.reset ? rate.reset * 1000 : null });
      throw PushyError('HTTP', 'GitHub refused the request (HTTP 403).');
    }
    if (res.status === 404) throw PushyError('NOT_FOUND', 'The ' + REPO + ' repository was not found.');
    if (!res.ok) throw PushyError('HTTP', 'GitHub returned HTTP ' + res.status + '.');
    var data = await res.json();
    if (!Array.isArray(data)) throw PushyError('HTTP', 'Unexpected answer from GitHub.');
    var issues = data.filter(function (x) { return x && !x.pull_request && typeof x.number === 'number'; }).map(normalize);
    var org = organise(issues, now);
    return { repo: REPO, fetchedAt: now, open: org.open, closed: org.closed, hiddenOld: org.hiddenOld, capped: data.length >= MAX, rate: rate };
  }
  function numHeader(res, k) { try { var v = res.headers && res.headers.get && res.headers.get(k); return v == null ? null : +v; } catch (e) { return null; } }

  /* a Solana address is 32 to 44 base58 characters; this only checks the shape, it does not prove anyone owns it */
  function validWallet(a) { return typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a); }
  function solscanUrl(a) { return validWallet(a) ? 'https://solscan.io/account/' + a : null; }

  var api = { VERSION: VERSION, REPO: REPO, LABEL: LABEL, STATUS_LABELS: STATUS_LABELS, CLOSED_DAYS: CLOSED_DAYS, parseRewardText: parseRewardText, parseReward: parseReward, statusOf: statusOf, normalize: normalize, organise: organise, fetchBounties: fetchBounties, validWallet: validWallet, solscanUrl: solscanUrl, clean: clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PushyBounties = api;
})(typeof window !== 'undefined' ? window : globalThis);
