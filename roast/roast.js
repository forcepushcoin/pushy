/* Pushy Roast — stats + deterministic roast generator + GitHub fetch.
   Pure client-side. No LLM: every line is a hand-written template picked by the real numbers.
   Works in the browser (window.PushyRoast) and in node (module.exports) for tests. */
(function (root) {
  'use strict';
  var VERSION = '1.0.0';
  var LIMITS = { pages: 3, perPage: 100, maxCommits: 300 };

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

  /* ------------------------------------------------------------ errors + API */
  function RoastError(code, message, extra) { var e = new Error(message); e.code = code; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
  function makeApi(opts) {
    var f = opts.fetch || root.fetch.bind(root), token = opts.token;
    var rate = { limit: null, remaining: null, reset: null, used: 0, lastPage: null };
    async function gh(path, soft) {
      var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var res;
      try { res = await f('https://api.github.com' + path, { headers: headers }); }
      catch (e) { throw RoastError('NETWORK', 'Could not reach api.github.com. Check your connection (or an ad-blocker) and try again.'); }
      var lim = res.headers.get('x-ratelimit-limit'), rem = res.headers.get('x-ratelimit-remaining'), rst = res.headers.get('x-ratelimit-reset');
      if (lim) rate.limit = +lim; if (rem) rate.remaining = +rem; if (rst) rate.reset = +rst; rate.used++;
      if (res.status === 202) return null; // contributors stats still computing
      var lk = res.headers.get('link'), lm = lk && /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(lk); rate.lastPage = lm ? +lm[1] : null;
      if (res.ok) return res.json();
      var body = {}; try { body = await res.json(); } catch (e) {}
      var msg = (body && body.message) || '';
      if ((res.status === 403 || res.status === 429) && (rate.remaining === 0 || /rate limit|abuse|secondary/i.test(msg)))
        throw RoastError('RATE_LIMIT', 'GitHub\'s anonymous API limit (60 requests/hour per IP) is used up.', { reset: rate.reset ? rate.reset * 1000 : null });
      if (soft) return null;
      if (res.status === 404) throw RoastError('NOT_FOUND', 'No public repository found there. It may be private, renamed, or misspelled.');
      if (res.status === 409) throw RoastError('EMPTY', 'That repository is empty, so there is nothing to roast.');
      if (res.status === 451) throw RoastError('UNAVAILABLE', 'GitHub says this repository is unavailable for legal reasons.');
      if (res.status === 401) throw RoastError('BAD_TOKEN', 'GitHub rejected that token. Clear it or paste a fresh one.');
      throw RoastError('HTTP', 'GitHub returned ' + res.status + (msg ? ' (' + msg + ')' : '') + '.');
    }
    return { gh: gh, rate: rate };
  }

  function slimCommit(c) {
    var cm = c.commit || {}, a = cm.author || {}, msg = String(cm.message || '');
    var nl = msg.indexOf('\n');
    return {
      d: a.date || (cm.committer && cm.committer.date) || null,
      cd: (cm.committer && cm.committer.date) || a.date || null,
      s: (nl < 0 ? msg : msg.slice(0, nl)).slice(0, 240),
      b: nl < 0 ? 0 : Math.min(msg.length - nl, 5000),
      u: (c.author && c.author.login) || a.email || a.name || '?',
      bot: !!(c.author && c.author.type === 'Bot') || /\[bot\]$/i.test((c.author && c.author.login) || ''),
      p: (c.parents && c.parents.length) || 0
    };
  }

  /* Fetch: 1 repo call + 1-3 commit pages + 1 contributors call (soft). */
  async function fetchRepoData(parsed, opts) {
    opts = opts || {};
    var api = makeApi(opts), say = opts.onProgress || function () {};
    var o = encodeURIComponent(parsed.owner), r = encodeURIComponent(parsed.repo);
    say('Looking up ' + parsed.owner + '/' + parsed.repo + '…');
    var repo = await api.gh('/repos/' + o + '/' + r);
    var full = repo.full_name || (parsed.owner + '/' + parsed.repo);
    var base = '/repos/' + o + '/' + r;
    say('Reading the commit log…');
    var first = await api.gh(base + '/commits?per_page=100&page=1'), all = Array.isArray(first) ? first.slice() : [];
    var lastPage = api.rate.lastPage; // GitHub refuses the contributor list for huge histories (10k+ commits): skip the call, avoid a noisy 403
    var pc = (lastPage && lastPage > 100) ? Promise.resolve(null) : api.gh('/repos/' + o + '/' + r + '/contributors?per_page=100&anon=1', true).catch(function () { return null; });
    var maxPages = Math.min(LIMITS.pages, Math.ceil((opts.maxCommits || LIMITS.maxCommits) / LIMITS.perPage));
    if (all.length === 100 && maxPages > 1) {
      var rest = []; for (var p = 2; p <= maxPages; p++) rest.push(api.gh(base + '/commits?per_page=100&page=' + p));
      say('Fetching ' + (maxPages - 1) + ' more page' + (maxPages > 2 ? 's' : '') + ' of commits…');
      var pages = await Promise.all(rest);
      pages.forEach(function (pg) { if (Array.isArray(pg)) all = all.concat(pg); });
    }
    if (!all.length) throw RoastError('EMPTY', 'That repository has no commits, so there is nothing to roast.');
    var contrib = null; try { contrib = await pc; } catch (e) { if (e && e.code === 'RATE_LIMIT') contrib = null; }
    var commits = all.slice(0, opts.maxCommits || LIMITS.maxCommits).map(slimCommit).filter(function (c) { return c.d; });
    var top = null;
    if (Array.isArray(contrib) && contrib.length) {
      var sum = 0; contrib.forEach(function (c) { sum += c.contributions || 0; });
      if (sum > 0) top = { share: (contrib[0].contributions || 0) / sum, people: contrib.length, capped: contrib.length >= 100 };
    }
    return {
      v: 1, t: Date.now(), apiCalls: api.rate.used, rate: { remaining: api.rate.remaining, limit: api.rate.limit, reset: api.rate.reset },
      repo: { full_name: full, stars: repo.stargazers_count || 0, archived: !!repo.archived, fork: !!repo.fork, html_url: repo.html_url, pushed_at: repo.pushed_at, language: repo.language || null },
      commits: commits, contributors: top
    };
  }

  /* ------------------------------------------------------------ stats */
  var PROFANE = /\b(fuck\w*|shit\w*|bitch\w*|cunt|dick\w*|piss\w*|cock|slut|whore|bastard|asshole|arse\w*|damn\w*|crap\w*|nigg\w*|fag\w*|retard\w*|wank\w*|twat|porn\w*|cum)\b/gi;
  function clean(s) { return String(s || '').replace(PROFANE, function (m) { return m.charAt(0) + '***'; }); }
  function isProfane(w) { PROFANE.lastIndex = 0; var r = PROFANE.test(w); PROFANE.lastIndex = 0; return r; }

  var STOP = {}; ('the and for with from this that these those are was were been being have has had not but you your our out into onto per via its it\'s can will would should could also than then them they their there here when where which what who why how all any some more most just only very too off use used using get got set let make made new one two')
    .split(' ').forEach(function (w) { STOP[w] = 1; });
  var LAZY = /^(fix(es|ed)?|wip|update(s|d)?|test(s|ing)?|tmp|temp|stuff|things?|change(s|d)?|misc|\.+|x+|a+|s+|d+|asdf\w*|qwe\w*|\d+|oops|minor|cleanup|clean up|commit|initial commit|first commit|more|again|ok|okay|done|save|saved|bump|edit|edits|updates?|work|progress|commit\s*\d*|hm+|hmm+|idk|\?+|!+|\.\.\.|lol|final|fine|yes|no|nvm|stash|backup|try|trying|fix it|fixes?\s*\d*|update \w{1,12}\.\w{1,4})[.!]?$/i;
  var RE_FIX = /\b(fix(es|ed|ing)?|hotfix|bugfix)\b/i, RE_FIXWORD = /\bfix(es|ed)?\b/i;
  var RE_OOPS = /\b(oops|whoops|ooops|typo(s)?|my bad|forgot|forgotten|facepalm|d'?oh|silly|mistake)\b/i;
  var RE_REVERT = /\brevert(s|ed|ing)?\b/i;
  var RE_FORCE = /(\bforce[- ]?push(ed|ing)?\b|--force\b|\bforce\b.*\bpush\b|\brebase(d)?\b|\bamend(ed)?\b|\bsquash(ed)?\b|rewrit(e|ing) (the )?history)/i;
  var RE_WIP = /\bwip\b|work in progress/i;
  var RE_CONV = /^(feat|fix|chore|docs|refactor|test|tests|perf|build|ci|style|revert)(\([^)]*\))?!?:\s/i;
  var RE_MERGE = /^Merge (pull request|branch|remote-tracking|tag|commit)|^Merge [\w./-]+ (into|of)\b/i;
  var RE_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{2B50}\u{2B06}\u{2705}\u{274C}]/u;
  var RE_EMOJI_G = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{2B50}\u{2705}\u{274C}]\uFE0F?/gu;
  var RE_GITMOJI = /(^|\s):(sparkles|bug|fire|tada|art|memo|zap|white_check_mark|rocket|lipstick|recycle|wrench|hammer|construction|ambulance|bookmark|lock|arrow_up|arrow_down|pencil2|truck|boom|poop|see_no_evil|rotating_light|green_heart|package|alien|wastebasket|coffin|bulb|wheelchair|heavy_plus_sign|heavy_minus_sign)(:)/;
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MS_DAY = 86400000;

  function pct(a, b) { return b ? (100 * a) / b : 0; }
  function round1(x) { return Math.round(x * 10) / 10; }

  function analyze(data, opts) {
    opts = opts || {};
    var tz = +opts.tz || 0, now = opts.now || Date.now();
    var raw = data.commits || [], n = raw.length;
    var s = { version: VERSION, tz: tz, n: n, repo: data.repo ? data.repo.full_name : '' };
    var hours = new Array(24).fill(0), wd = new Array(7).fill(0), byDay = {}, authors = {}, words = {}, emo = {}, lazyMsgs = {}, lens = [];
    var c = { night: 0, weekend: 0, friday: 0, fix: 0, fixWord: 0, oops: 0, revert: 0, force: 0, wip: 0, conv: 0, merge: 0, emoji: 0, lazy: 0, tiny: 0, caps: 0, bang: 0, bots: 0, body: 0, empty: 0 };
    var human = 0, minT = Infinity, maxT = -Infinity, longest = '';
    raw.forEach(function (cm) {
      var t = Date.parse(cm.d); if (isNaN(t)) return;
      var sh = new Date(t + tz * 3600000), h = sh.getUTCHours(), w = sh.getUTCDay();
      hours[h]++; wd[w]++;
      if (h < 5) c.night++;
      if (w === 0 || w === 6) c.weekend++;
      if (w === 5) c.friday++;
      var ct = Date.parse(cm.cd || cm.d); if (isNaN(ct)) ct = t;
      if (ct < minT) minT = ct; if (ct > maxT) maxT = ct;
      var dk = Math.floor((ct + tz * 3600000) / MS_DAY); byDay[dk] = (byDay[dk] || 0) + 1;
      authors[cm.u] = (authors[cm.u] || 0) + 1;
      if (cm.bot) c.bots++;
      var m = String(cm.s || '').trim();
      var merge = RE_MERGE.test(m) || cm.p > 1;
      if (merge) { c.merge++; return; }
      human++;
      if (!m) { c.empty++; m = '(empty message)'; }
      lens.push(m.length); if (m.length > longest.length) longest = m;
      if (cm.b > 400) c.body++;
      if (RE_FIX.test(m)) c.fix++; if (RE_FIXWORD.test(m)) c.fixWord++;
      if (RE_OOPS.test(m)) c.oops++;
      if (RE_REVERT.test(m)) c.revert++;
      if (RE_FORCE.test(m)) c.force++;
      if (RE_WIP.test(m)) c.wip++;
      if (RE_CONV.test(m)) c.conv++;
      if (m.length <= 3) c.tiny++;
      if (RE_EMOJI.test(m) || RE_GITMOJI.test(m)) { c.emoji++; var mm = m.match(RE_EMOJI_G); if (mm) mm.forEach(function (e) { e = e.replace(/\uFE0F/g, ''); emo[e] = (emo[e] || 0) + 1; }); }
      if (m.length >= 6 && m === m.toUpperCase() && /[A-Z]{4}/.test(m)) c.caps++;
      if (/!\s*$/.test(m)) c.bang++;
      if (LAZY.test(m.replace(/^[\s\-:*]+/, ''))) { c.lazy++; var k = m.toLowerCase().slice(0, 40); lazyMsgs[k] = (lazyMsgs[k] || { text: m.slice(0, 40), n: 0 }); lazyMsgs[k].n++; }
      var toks = m.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/#\d+|\b[0-9a-f]{7,40}\b|`[^`]*`/g, ' ').match(/[a-z][a-z']{2,}/g) || [];
      var seen = {}; toks.forEach(function (wd) { if (STOP[wd] || seen[wd] || wd.length > 20) return; seen[wd] = 1; words[wd] = (words[wd] || 0) + 1; });
    });
    s.human = human; s.counts = c;
    var pHum = function (x) { return pct(x, human); };
    s.nightPct = pct(c.night, n); s.weekendPct = pct(c.weekend, n); s.fridayPct = pct(c.friday, n);
    s.fixPct = pHum(c.fix); s.oopsPct = pHum(c.oops); s.revertPct = pHum(c.revert); s.forcePct = pHum(c.force); s.wipPct = pHum(c.wip);
    s.convPct = pHum(c.conv); s.emojiPct = pHum(c.emoji); s.lazyPct = pHum(c.lazy); s.capsPct = pHum(c.caps); s.bangPct = pHum(c.bang);
    s.mergePct = pct(c.merge, n); s.botPct = pct(c.bots, n); s.bodyPct = pHum(c.body);
    s.avgLen = lens.length ? lens.reduce(function (a, b) { return a + b; }, 0) / lens.length : 0;
    s.longest = clean(longest.length > 110 ? longest.slice(0, 107) + '…' : longest);
    s.hours = hours; s.weekdays = wd;
    var bh = 0; hours.forEach(function (v, i) { if (v > hours[bh]) bh = i; }); s.busiestHour = bh;
    var bw = 0; wd.forEach(function (v, i) { if (v > wd[bw]) bw = i; }); s.busiestWeekday = bw; s.busiestWeekdayName = DAYS[bw];
    var days = Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; });
    var best = 0, run = 0, prev = null, bd = null, bdn = 0, gap = 0;
    days.forEach(function (d) { run = (prev !== null && d === prev + 1) ? run + 1 : 1; if (run > best) best = run; if (prev !== null && d - prev - 1 > gap) gap = d - prev - 1; prev = d; if (byDay[d] > bdn) { bdn = byDay[d]; bd = d; } });
    s.streak = best; s.activeDays = days.length; s.longestGap = gap;
    s.busiestDay = bd !== null ? new Date(bd * MS_DAY).toISOString().slice(0, 10) : null; s.busiestDayCount = bdn;
    s.spanDays = isFinite(minT) ? Math.max(1, Math.round((maxT - minT) / MS_DAY)) : 0;
    s.perDay = n && s.spanDays ? n / s.spanDays : 0;
    s.firstDate = isFinite(minT) ? new Date(minT).toISOString().slice(0, 10) : null;
    s.lastDate = isFinite(maxT) ? new Date(maxT).toISOString().slice(0, 10) : null;
    s.lastAgeDays = isFinite(maxT) ? Math.max(0, Math.round((now - maxT) / MS_DAY)) : 0;
    // words
    s.topWords = Object.keys(words).filter(function (w) { return !isProfane(w); }).sort(function (a, b) { return words[b] - words[a] || (a < b ? -1 : 1); }).slice(0, 8).map(function (w) { return { word: w, n: words[w] }; });
    s.topEmoji = Object.keys(emo).sort(function (a, b) { return emo[b] - emo[a]; }).slice(0, 5).map(function (e) { return { emoji: e, n: emo[e] }; });
    s.lazyTop = Object.keys(lazyMsgs).map(function (k) { return lazyMsgs[k]; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 6).map(function (x) { return { text: clean(x.text), n: x.n }; });
    var shortest = {}; raw.forEach(function (cm) { var m = String(cm.s || '').trim(); if (m && !RE_MERGE.test(m)) shortest[m] = (shortest[m] || 0) + 1; });
    s.shortest = Object.keys(shortest).sort(function (a, b) { return a.length - b.length || shortest[b] - shortest[a]; }).slice(0, 4).map(function (m) { return { text: clean(m.slice(0, 40)), n: shortest[m] }; });
    // authors / bus factor (from the sample)
    var names = Object.keys(authors).sort(function (a, b) { return authors[b] - authors[a]; });
    s.authors = names.length; s.topShare = n ? authors[names[0]] / n * 100 : 0;
    var acc = 0, bf = 0; for (var i = 0; i < names.length; i++) { acc += authors[names[i]]; bf++; if (acc >= n / 2) break; }
    s.busFactor = n ? bf : 0;
    s.topEff = (data.contributors && data.contributors.share !== undefined) ? data.contributors.share * 100 : s.topShare;
    s.allTime = data.contributors ? { share: data.contributors.share * 100, people: data.contributors.people, capped: data.contributors.capped } : null;
    s.stars = data.repo ? data.repo.stars : 0; s.archived = !!(data.repo && data.repo.archived); s.language = data.repo && data.repo.language;
    return s;
  }

  /* ------------------------------------------------------------ deterministic RNG */
  function hash(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { var a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }

  /* ------------------------------------------------------------ roast content */
  function fmtPct(x) { return x > 0 && x < 1 ? '<1' : String(Math.round(x)); }
  function hh(h) { return (h < 10 ? '0' : '') + h + ':00'; }
  function dd(n) { return n + ' day' + (n === 1 ? '' : 's'); }
  function fill(tpl, s) {
    var tzl = s.tz ? 'UTC' + (s.tz > 0 ? '+' : '−') + Math.abs(s.tz) : 'UTC';
    var tw = s.topWords[0] || { word: 'update', n: 0 };
    var map = {
      repo: s.repo.split('/').pop() || s.repo, full: s.repo, n: s.n, night: fmtPct(s.nightPct), weekend: fmtPct(s.weekendPct), friday: fmtPct(s.fridayPct),
      fix: s.counts.fix, fixpct: fmtPct(s.fixPct), oops: s.counts.oops, revert: s.counts.revert, revertpct: fmtPct(s.revertPct), force: s.counts.force,
      oopspct: fmtPct(s.oopsPct), wip: s.counts.wip, lazy: s.counts.lazy, lazypct: fmtPct(s.lazyPct), avg: Math.round(s.avgLen), streak: s.streak, busyhour: hh(s.busiestHour), busyday: s.busiestWeekdayName,
      bigday: s.busiestDay, bigdayn: s.busiestDayCount, top: fmtPct(s.topEff), authors: s.authors, bus: s.busFactor, emojipct: fmtPct(s.emojiPct), emoji: s.counts.emoji,
      perday: s.perDay >= 10 ? Math.round(s.perDay) : round1(s.perDay), span: s.spanDays, topword: tw.word, topwordn: tw.n, merge: fmtPct(s.mergePct), conv: fmtPct(s.convPct),
      spand: dd(s.spanDays), aged: dd(s.lastAgeDays), gapd: dd(s.longestGap), streakd: dd(s.streak), caps: s.counts.caps, bot: fmtPct(s.botPct), age: s.lastAgeDays, tz: tzl, wippct: fmtPct(s.wipPct), tiny: s.counts.tiny, gap: s.longestGap, stars: s.stars
    };
    return tpl.replace(/\{(\w+)\}/g, function (m, k) { return k in map ? map[k] : m; });
  }

  var ARCH = [
    { id: 'midnight', title: 'Midnight Force Pusher', prio: 1.15, score: function (s) { return s.n >= 10 ? s.nightPct / 30 : 0; },
      open: ['{night}% of these commits landed between 00:00 and 05:00 {tz}. Pushy respects the grind and fears for your sleep schedule.', 'This repo does its best work while the sane people are asleep. {night}% of commits are after midnight {tz}.', 'Nothing good ever happened at 3 a.m., and yet {night}% of {repo}\'s commits did.', '{n} commits sampled, {night}% of them in the small hours. Even Pushy\'s hamster wheel goes quiet before that.'],
      punch: ['{night}% of commits after midnight. The CI runs on caffeine.', 'Sleep is a merge conflict nobody resolved.', 'Pushing at 3 a.m. like the hotfix will remember it fondly.', '{night}% night commits. The bug fixes itself in the morning, right?'], stats: ['night', 'busyhour', 'n', 'weekend'] },
    { id: 'minimalist', title: 'Commit Message Minimalist', prio: 1.15, score: function (s) { return Math.max(s.lazyPct / 22, s.avgLen && s.avgLen < 30 ? (34 - s.avgLen) / 12 : 0); },
      openAlt: ['Average commit message: {avg} characters. Pushy has seen longer fortune cookies.', 'Commit messages here are short: {avg} characters on average. Every word has to earn its place, and most of them did not.', '{repo} writes commit messages like it pays per letter.'],
      open: ['Average commit message: {avg} characters. Poetry compared to the {lazy} that said just "fix" or "wip".', 'Why use a sentence when "{topword}" does the job? That is the philosophy here, {lazypct}% of the time.', '{lazy} of {n} commit messages are the written equivalent of a shrug.', '{repo} treats the commit message box like a tip jar: nobody wants to put anything in.'],
      punch: ['Average commit message: {avg} characters. Mysterious.', '{lazy} commits say almost nothing. Bold strategy.', 'git log reads like a ransom note with the words removed.', '"fix". "wip". "update". The holy trinity.'], stats: ['lazy', 'avg', 'tiny', 'fix'] },
    { id: 'revert', title: 'Revert Enjoyer', prio: 1.2, score: function (s) { return s.counts.revert >= 3 ? s.revertPct / 4.5 : 0; },
      open: ['{revert} reverts in {n} commits. This repo loves the feeling of going backwards, as long as it is fast.', 'Ctrl+Z, but make it git. {revert} reverts sampled ({revertpct}%).', '{revert} commits here simply undo earlier commits. Pushy admires the confidence of shipping first and thinking later.', '{revertpct}% of commits are reverts. The hamster wheel has a reverse gear and {repo} found it.'],
      punch: ['{revert} reverts. Forward, backward, forward.', 'Ship it. Un-ship it. Ship it again.', '{revertpct}% reverts. Confidence is a hell of a drug.', 'git revert: the "undo send" of deploys.'], stats: ['revert', 'force', 'n', 'night'] },
    { id: 'weekend', title: 'Weekend Warrior', prio: 1, score: function (s) { return s.n >= 10 ? Math.max(0, s.weekendPct - 12) / 28 : 0; },
      open: ['{weekend}% of commits happen on weekends. Pushy salutes the dedication and quietly asks about hobbies.', 'Saturday and Sunday are just two more sprint days at {repo} ({weekend}% of commits).', 'Weekends are for rest, but {weekend}% of this history disagrees.', '{weekend}% weekend commits. The calendar says "day off"; the repo says "deploy".'],
      punch: ['{weekend}% of commits on weekends. Touch some grass.', 'Weekends are just two extra sprint days.', 'The weekend called. It wants its Saturday back.', '{weekend}% weekend commits. Nobody told the repo about brunch.'], stats: ['weekend', 'night', 'streak', 'n'] },
    { id: 'fixer', title: 'Fix-It Fixer', prio: 1.05, score: function (s) { return s.fixPct / 28; },
      open: ['{fix} of {n} commits contain the word "fix". Pushy is not saying the code is broken, but the commits are saying it loudly.', '{fixpct}% of commit messages are fixes. That is a lot of things to have gotten wrong the first time.', 'Fix, fix, fix: {fix} times. At this point it is a lifestyle.', '{repo} ships features, then spends {fixpct}% of its history apologising for them in code.'],
      punch: ['{fix} commits say "fix". Plot twist: it was broken.', 'Fixing today what we shipped yesterday.', '{fixpct}% fixes. The bug count is the real roadmap.', 'Bugs: introduced and fixed in-house.'], stats: ['fix', 'oops', 'revert', 'n'] },
    { id: 'oops', title: 'Oops-Driven Developer', prio: 1.1, score: function (s) { return s.counts.oops >= 3 ? s.oopsPct / 5 : 0; },
      open: ['{oops} commits admit a typo, an "oops" or a "forgot". Honesty in git history is rare. Pushy approves.', 'The word "oops" (and its friends) shows up {oops} times. The repo knows what it did.', '{oopspct}% of commits mention a typo, an "oops" or a forgotten something. Pushy relates.'],
      punch: ['{oops} oops-commits. Honest, at least.', 'Typo fixes: the cardio of software.', 'Oops, typo, forgot a file. Repeat.'], stats: ['oops', 'fix', 'revert', 'n'] },
    { id: 'lonewolf', title: 'Lone Wolf Maintainer', prio: 1.05, score: function (s) { return s.n >= 20 ? s.topEff / 80 : 0; },
      open: ['One contributor wrote {top}% of the sampled commits. The bus factor is {bus}, and the bus knows where you live.', '{authors} authors in the sample, but one of them is doing most of the pushing ({top}%). Pushy hopes they take vacations.', 'In theory this is open source. In practice it is one very busy person and a fan club.', '{top}% of commits come from the top contributor. The truck factor has a very short fuse.'],
      punch: ['Bus factor: {bus}. Please, everyone, stay away from buses.', '{top}% of commits from one person. Teamwork is a spectrum.', 'One main contributor, {authors} spectators.', 'If one laptop dies, the roadmap dies with it.'], stats: ['top', 'bus', 'authors', 'n'] },
    { id: 'emoji', title: 'Emoji Commit Enthusiast', prio: 1.15, score: function (s) { return s.emojiPct / 28; },
      open: ['{emojipct}% of commit messages carry emoji. The git log looks like a sticker sheet.', 'Pushy loves a rocket in a commit message. {repo} loves it {emoji} times.', '{emoji} emoji commits. Semantic versioning, meet semantic sparkles.'],
      punch: ['{emojipct}% of commits have emoji. Very sparkly, very mysterious.', 'The git log is a sticker sheet now.', 'Rocket. Sparkles. Bug. Repeat.'], stats: ['emoji', 'n', 'avg', 'fix'] },
    { id: 'novelist', title: 'Commit Message Novelist', prio: 1.1, score: function (s) { return s.avgLen > 50 ? (s.avgLen - 45) / 38 : 0; },
      open: ['Average subject line: {avg} characters. This repo is writing a novel one git commit at a time.', 'Commit messages here are so long that git log needs a table of contents ({avg} chars on average).', '{avg} characters per commit message. Pushy likes the detail and fears the scrollbar.'],
      punch: ['{avg}-character commit messages. Someone had a lot to say.', 'The subject line is a cover letter.', 'Plot, characters, a twist in the footer.'], stats: ['avg', 'n', 'conv', 'fix'] },
    { id: 'conventional', title: 'Conventional Commit Cultist', prio: 1.1, score: function (s) { return s.convPct / 65; },
      open: ['{conv}% of commits follow the Conventional Commits format. The ritual is strictly observed.', 'feat: discipline. fix: discipline. chore: more discipline. {conv}% of commits are in format.', 'Pushy spotted a prefix on {conv}% of commits. Someone, somewhere, has a linter and is not afraid to use it.'],
      punch: ['{conv}% conventional commits. A disciplined, slightly scary bunch.', 'feat: everything. fix: everything else.', 'The linter is happy. The hamster is impressed.'], stats: ['conv', 'avg', 'n', 'fix'] },
    { id: 'bot', title: 'Bot Farm Foreman', prio: 1.2, score: function (s) { return s.botPct / 40; },
      open: ['{bot}% of the commits come from bots. The robots are doing the pushing and the humans are doing the reviewing. Allegedly.', 'More automation than a hamster wheel factory: {bot}% of commits are bot-made.', 'Dependabot walked in, committed {bot}% of the history, and left without a hello.'],
      punch: ['{bot}% bot commits. The robots are winning.', 'Bots push, humans click "merge".', 'Automation: now with 100% fewer humans.'], stats: ['bot', 'merge', 'n', 'authors'] },
    { id: 'tumbleweed', title: 'Tumbleweed Maintainer', prio: 1.1, score: function (s) { return s.lastAgeDays > 120 ? s.lastAgeDays / 365 : 0; },
      open: ['The last sampled commit is {aged} old. This repo is in witness protection.', 'No pushes for {aged}. Pushy checks the repo like a hamster checks an empty food bowl.', '{repo} is not abandoned, it is just resting for a very long time ({aged}).'],
      punch: ['Last commit: {aged} ago. Is anyone home?', 'Not dead. Just resting. Aggressively.', '{aged} of silence. The tumbleweeds have commit access.'], stats: ['age', 'n', 'span', 'authors'] },
    { id: 'speed', title: 'Hyperactive Hamster Wheel', prio: 1.1, score: function (s) { return s.n >= 50 && s.spanDays >= 3 ? s.perDay / 20 : 0; },
      open: ['{perday} commits a day, sustained over {spand}. The wheel is running hot.', '{n} commits in just {spand}. Somebody is either a very productive team or very nervous.', 'At {perday} commits a day, {repo} commits faster than Pushy runs on a wheel.'],
      punch: ['{perday} commits a day. Is anyone reading these?', '{n} commits in {spand}. Please drink water.', 'Velocity: yes. Calm: not detected.'], stats: ['perday', 'n', 'streak', 'night'] },
    { id: 'friday', title: 'Friday Deploy Daredevil', prio: 1.1, score: function (s) { return s.n >= 20 ? Math.max(0, s.fridayPct - 14) / 11 : 0; },
      open: ['{friday}% of commits land on Fridays. The on-call phone has a dark premonition.', 'Everyone says "never deploy on Friday". {repo} replies with {friday}% of its commits on Fridays.', 'Friday is the busiest day of the week and nobody at {repo} is scared.'],
      punch: ['{friday}% of commits on Fridays. Brave. Or reckless.', 'Never push on Friday. {repo} pushes on Friday.', 'The weekend on-call rota fears this repo.'], stats: ['friday', 'weekend', 'night', 'n'] },
    { id: 'wip', title: 'WIP Hoarder', prio: 1.15, score: function (s) { return s.counts.wip >= 3 ? s.wipPct / 8 : 0; },
      open: ['{wip} commits are labelled "wip". Work in progress is the permanent state of {repo}.', '"WIP" appears {wip} times in the log. Pushy suspects some of them have been in progress for years.'],
      punch: ['{wip} "wip" commits. Work: in progress. Always.', 'Finished is a state of mind.', '{wip} WIPs and counting.'], stats: ['wip', 'lazy', 'avg', 'n'] },
    { id: 'shout', title: 'ALL-CAPS Announcer', prio: 1.2, score: function (s) { return s.counts.caps >= 3 ? s.capsPct / 6 : 0; },
      open: ['{caps} commit messages are in ALL CAPS. Pushy heard every one of them from three rooms away.', 'Some commits at {repo} are SHOUTING ({caps} of them). The git log has a volume knob and it is stuck.'],
      punch: ['{caps} commits in ALL CAPS. NO INDOOR VOICE.', 'THE COMMIT LOG IS YELLING AGAIN.', 'Caps lock: the only feature that is always shipped.'], stats: ['caps', 'avg', 'n', 'fix'] },
    { id: 'merge', title: 'Subway Map Architect', prio: 1.05, score: function (s) { return s.n >= 20 ? s.mergePct / 40 : 0; },
      open: ['{merge}% of the commits are merges. The history looks like a subway map designed by a committee.', '{merge}% merge commits. Somewhere there is a tidy rebase waiting to be loved.', '{repo}\'s git graph has more junctions than a hamster tunnel set.'],
      punch: ['{merge}% merge commits. The graph is a subway map.', 'Rebase is just a rumour here.', 'So many merges. So few straight lines.'], stats: ['merge', 'authors', 'n', 'force'] },
    { id: 'fresh', title: 'Barely Pushed Hamster', prio: 9, score: function (s) { return s.n < 8 ? 2 : 0; },
      open: ['Only {n} commit{s} in the whole history. There is not much to roast, just a tiny little history.', '{n} commit{s}. Pushy cannot roast a history this short. It is like roasting a sunflower seed.'],
      punch: ['Only {n} commit{s}. Come back when you have done more crimes.', 'Barely a history. Still adorable.'], stats: ['n', 'span', 'authors', 'avg'] },
    { id: 'saint', title: 'Suspiciously Well-Behaved', prio: 0, score: function () { return 0.55; },
      open: ['Pushy looked at {n} commits for crimes and found very little. Messages are decent, hours are civilised.', 'Nothing to roast here: tidy messages, reasonable hours, no panic reverts. Pushy is a little suspicious.', '{repo} is so well-behaved that Pushy checked twice for a hidden force push.'],
      punch: ['Tidy messages, sane hours. Pushy is suspicious.', 'No crimes found. Pushy will keep looking.', 'Boring in the best way. Respect.'], stats: ['n', 'night', 'avg', 'streak'] }
  ];
  ARCH.forEach(function (a) { a.id = a.id; });

  var STATS = {
    n: function (s) { return [String(s.n), 'commits sampled']; },
    night: function (s) { return [fmtPct(s.nightPct) + '%', 'after-midnight commits']; },
    weekend: function (s) { return [fmtPct(s.weekendPct) + '%', 'weekend commits']; },
    friday: function (s) { return [fmtPct(s.fridayPct) + '%', 'friday commits']; },
    lazy: function (s) { return [fmtPct(s.lazyPct) + '%', 'one-word messages']; },
    avg: function (s) { return [String(Math.round(s.avgLen)), 'avg message chars']; },
    tiny: function (s) { return [String(s.counts.tiny), 'messages ≤ 3 chars']; },
    fix: function (s) { return [String(s.counts.fix), '"fix" commits']; },
    oops: function (s) { return [String(s.counts.oops), 'oops / typo commits']; },
    revert: function (s) { return [String(s.counts.revert), 'reverts']; },
    force: function (s) { return [String(s.counts.force), 'rebase / amend / force']; },
    wip: function (s) { return [String(s.counts.wip), '"wip" commits']; },
    streak: function (s) { return [s.streak + 'd', 'longest streak']; },
    busyhour: function (s) { return [hh(s.busiestHour), 'busiest hour']; },
    top: function (s) { return [fmtPct(s.topEff) + '%', 'by top contributor']; },
    bus: function (s) { return [String(s.busFactor), 'bus factor']; },
    authors: function (s) { return [String(s.authors), 'authors in sample']; },
    emoji: function (s) { return [fmtPct(s.emojiPct) + '%', 'commits with emoji']; },
    conv: function (s) { return [fmtPct(s.convPct) + '%', 'conventional commits']; },
    caps: function (s) { return [String(s.counts.caps), 'ALL-CAPS commits']; },
    merge: function (s) { return [fmtPct(s.mergePct) + '%', 'merge commits']; },
    bot: function (s) { return [fmtPct(s.botPct) + '%', 'bot commits']; },
    age: function (s) { return [s.lastAgeDays + 'd', 'since last commit']; },
    span: function (s) { return [s.spanDays + 'd', 'history sampled']; },
    perday: function (s) { return [String(s.perDay >= 10 ? Math.round(s.perDay) : round1(s.perDay)), 'commits per day']; }
  };

  // Observations: extra receipts for the written roast. score() = how remarkable (0 = skip).
  var OBS = [
    { id: 'night', score: function (s) { return s.nightPct >= 15 ? s.nightPct / 30 : 0; }, lines: ['Peak panic hour is {busyhour} {tz}.', 'Night owl score: {night}% of commits between 00:00 and 05:00 {tz}.', 'Sleep schedule: {night}% of commits after midnight.'] },
    { id: 'weekend', score: function (s) { return s.weekendPct >= 30 ? s.weekendPct / 40 : 0; }, lines: ['{weekend}% of the work happens on weekends. Work-life balance is a rumour.', 'Weekend commits: {weekend}%. Calendars exist, apparently.', 'Saturday and Sunday are working days here ({weekend}% of commits).'] },
    { id: 'friday', score: function (s) { return s.n >= 20 && s.fridayPct >= 24 ? s.fridayPct / 26 : 0; }, lines: ['{friday}% of commits are Friday commits. Bold.', 'Fridays hold {friday}% of the history. The on-call phone is sweating.'] },
    { id: 'fix', score: function (s) { return s.fixPct >= 12 ? s.fixPct / 28 : 0; }, lines: ['{fix} commits start the sentence with "fix".', '"Fix" shows up in {fixpct}% of messages. Features arrive broken, with free shipping.', 'For every feature there is a fix. Sometimes two.'] },
    { id: 'oops', score: function (s) { return s.counts.oops >= 2 ? 0.45 + s.oopsPct / 10 : 0; }, lines: ['{oops} commits confess to a typo, an "oops" or a forgotten file.', 'Typos and oopses: {oops}. Honest, if nothing else.'] },
    { id: 'revert', score: function (s) { return s.counts.revert >= 2 ? 0.5 + s.revertPct / 8 : 0; }, lines: ['{revert} reverts: the "undo" button is well used.', 'Reverts sampled: {revert}. Forward-first, ask-questions-later.'] },
    { id: 'force', score: function (s) { return s.counts.force >= 2 ? 0.4 + s.forcePct / 8 : 0; }, lines: ['{force} commits mention rebase, amend or force. History is a draft here.', 'Rewriting history: {force} mentions. Pushy approves, as long as you do it with a lease.'] },
    { id: 'lazy', score: function (s) { return s.lazyPct >= 8 ? s.lazyPct / 22 : 0; }, lines: ['{lazy} messages are a single word like "fix" or "update".', '{lazypct}% of commit messages could be replaced by a shrug emoji.'] },
    { id: 'wip', score: function (s) { return s.counts.wip >= 2 ? 0.4 + s.wipPct / 8 : 0; }, lines: ['{wip} "wip" commits. Many are still in progress.', '"WIP" appears {wip} times. Pushy has seen things.'] },
    { id: 'short', score: function (s) { return s.avgLen && s.avgLen < 26 ? (30 - s.avgLen) / 14 : 0; }, lines: ['Average message length: {avg} characters. Efficient, mysterious.', 'The typical commit message here is about {avg} characters. A tweet would be an essay.'] },
    { id: 'long', score: function (s) { return s.avgLen > 70 ? s.avgLen / 90 : 0; }, lines: ['Average message length: {avg} characters. Someone is journaling.', 'Commit messages average {avg} characters. Pushy needs a scroll wheel.'] },
    { id: 'streak', score: function (s) { return s.streak >= 10 ? Math.min(1.2, s.streak / 25) : 0; }, lines: ['Longest streak: {streakd} in a row. Rest days are a myth.', '{streak} consecutive days of commits. Pushy is impressed and slightly worried.'] },
    { id: 'bigday', score: function (s) { return s.n >= 30 && s.mergePct < 20 && s.busiestDayCount / s.n >= 0.12 ? 0.6 + s.busiestDayCount / s.n : 0; }, lines: ['{bigdayn} commits landed on {bigday} alone. Something happened that day.', 'The busiest day, {bigday}, holds {bigdayn} commits. What a day.'] },
    { id: 'emoji', score: function (s) { return s.emojiPct >= 10 ? s.emojiPct / 28 : 0; }, lines: ['{emojipct}% of messages come with emoji.', 'Emoji count: {emoji} commits. The log is a sticker sheet.'] },
    { id: 'bus', score: function (s) { return s.n >= 20 && s.topEff >= 55 ? s.topEff / 80 : 0; }, lines: ['Bus factor in the sample: {bus}. One contributor wrote {top}%.', 'Top contributor share: {top}%. Please give them a holiday.'] },
    { id: 'team', score: function (s) { return s.n >= 50 && s.busFactor >= 8 ? 0.6 : 0; }, lines: ['A healthy crowd of {authors} authors in the sample. The bus factor is {bus}. Very responsible.', '{authors} different authors in the sample. Teamwork!'] },
    { id: 'conv', score: function (s) { return s.convPct >= 40 ? s.convPct / 70 : 0; }, lines: ['{conv}% of commits wear the Conventional Commits uniform.'] },
    { id: 'caps', score: function (s) { return s.counts.caps >= 2 ? 0.5 : 0; }, lines: ['{caps} commits were typed in ALL CAPS. The git log has a volume problem.'] },
    { id: 'topword', score: function (s) { var w = s.topWords[0]; return w && w.n >= 6 && s.human ? 0.5 + w.n / s.human : 0; }, lines: ['Favourite word: "{topword}" ({topwordn} commits).', 'The most-used word in the log is "{topword}". Write that on the tombstone.', 'If this repo had a motto: "{topword}".'] },
    { id: 'merge', score: function (s) { return s.mergePct >= 25 ? s.mergePct / 40 : 0; }, lines: ['{merge}% of commits are merges, so the git graph looks like a subway map.'] },
    { id: 'dormant', score: function (s) { return s.lastAgeDays >= 180 ? 0.5 + s.lastAgeDays / 700 : 0; }, lines: ['The latest sampled commit is {aged} old. The repo is on a very long coffee break.'] },
    { id: 'velocity', score: function (s) { return s.n >= 50 && s.perDay >= 8 ? s.perDay / 20 : 0; }, lines: ['{perday} commits per day on average. The wheel is smoking.'] },
    { id: 'gap', score: function (s) { return s.n >= 30 && s.mergePct < 20 && s.longestGap >= 45 ? 0.5 + s.longestGap / 400 : 0; }, lines: ['Longest silence between commits: {gapd}. Hibernation season.'] },
    { id: 'bots', score: function (s) { return s.botPct >= 15 ? s.botPct / 40 : 0; }, lines: ['Bots wrote {bot}% of the history. They never ask for lunch breaks.'] },
    { id: 'hour', score: function () { return 0.12; }, lines: ['Busiest hour of the day: {busyhour} {tz}.', 'Commit rush hour: {busyhour} {tz}.', 'Most commits land around {busyhour} {tz}.'] },
    { id: 'day', score: function () { return 0.1; }, lines: ['Busiest weekday: {busyday}.', '{busyday} is the favourite day to push.'] }
  ];

  var CLOSERS = ['Force push responsibly. Or at least with a lease.', 'Pushy believes in you. Mostly.', 'No hamsters were harmed in the making of this roast.', 'Now go write a better commit message. Squeak.', 'Roast served warm. Don\'t push to main.', 'This was just for fun. Pushy still loves you.', 'Next time, git commit -m "something helpful". Pushy dares you.', 'Seeds and love. Mostly seeds.'];
  var SMALL_N_NOTE = 'Small sample, so take this with a grain of seed.';

  function archetype(s, r) {
    var best = null, bestV = -1;
    ARCH.forEach(function (a) { var v = a.score(s) * a.prio; if (a.id !== 'saint' && v > bestV + 1e-9) { bestV = v; best = a; } });
    return bestV >= 0.5 ? best : ARCH.filter(function (a) { return a.id === 'saint'; })[0];
  }

  function roast(s, opts) {
    opts = opts || {};
    var seedStr = (s.repo || '') + '|' + (opts.seed || 0);
    var r = rng(hash(seedStr));
    var a = opts.forceArch ? ARCH.filter(function (x) { return x.id === opts.forceArch; })[0] || archetype(s) : archetype(s);
    var f = function (t) { return fill(t.replace('{s}', s.n === 1 ? '' : 's'), s); };
    var open = f(pick(r, (a.openAlt && s.counts.lazy < 3) ? a.openAlt : a.open));
    var punch = f(pick(r, a.punch));
    // extra observations: top 2 by score, not duplicating the archetype's own theme
    var skip = { midnight: 'night', minimalist: 'lazy', revert: 'revert', weekend: 'weekend', fixer: 'fix', oops: 'oops', lonewolf: 'bus', emoji: 'emoji', novelist: 'long', conventional: 'conv', bot: 'bots', tumbleweed: 'dormant', speed: 'velocity', friday: 'friday', wip: 'wip', shout: 'caps', merge: 'merge' }[a.id];
    var obs = OBS.filter(function (o) { return o.id !== skip && (a.id !== 'fresh' || /^(dormant|hour|day)$/.test(o.id)) && !(o.id === 'topword' && s.topWords[0] && /^(fix|feat|update|add)$/.test(s.topWords[0].word) && (a.id === 'fixer' || a.id === 'conventional' || a.id === 'minimalist')); }).map(function (o) { return { o: o, v: o.score(s) }; }).filter(function (x) { return x.v > 0; })
      .sort(function (x, y) { return y.v - x.v || (x.o.id < y.o.id ? -1 : 1); }).slice(0, 2);
    var extra = obs.map(function (x) { return f(pick(r, x.o.lines)); });
    var closer = pick(r, CLOSERS);
    var parts = [open].concat(extra);
    if (s.n < 30 && a.id !== 'fresh') parts.push(SMALL_N_NOTE);
    parts.push(closer);
    var text = parts.join(' ');
    // sanity: never exceed card limits
    var cardLine = punch.length > 150 ? punch.slice(0, 147) + '…' : punch;
    var picks = a.stats.slice(); ['n', 'night', 'weekend', 'lazy', 'fix', 'avg', 'streak', 'busyhour'].forEach(function (k) { if (picks.indexOf(k) < 0) picks.push(k); });
    var all = picks.map(function (k) { var v = STATS[k](s); return { key: k, value: v[0], label: v[1] }; });
    var nz = all.filter(function (t) { return !/^0%?$/.test(t.value); }), zs = all.filter(function (t) { return /^0%?$/.test(t.value); });
    var tiles = nz.concat(zs).slice(0, 4);
    return { archetype: a.id, title: a.title, text: text, paragraphs: parts, card: cardLine, tiles: tiles };
  }

  var api = {
    VERSION: VERSION, LIMITS: LIMITS, parseInput: parseInput, fetchRepoData: fetchRepoData, makeApi: makeApi, slimCommit: slimCommit,
    analyze: analyze, roast: roast, ARCHETYPES: ARCH.map(function (a) { return { id: a.id, title: a.title }; }), clean: clean, hash: hash, STATS: STATS, DAYS: DAYS, fmtPct: fmtPct, hh: hh,
    _ARCH: ARCH, _OBS: OBS, _CLOSERS: CLOSERS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PushyRoast = api;
})(typeof window !== 'undefined' ? window : globalThis);
