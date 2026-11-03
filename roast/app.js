/* Pushy Roast — UI glue. All repo-derived text is escaped before it touches innerHTML; the card is drawn with canvas fillText. */
(function () {
  'use strict';
  var P = window.PushyRoast, C = window.PushyCard;
  var SITE_URL = 'https://forcepushcoin.github.io/roast/'; // deployed URL of this page; used for share links
  var CACHE_MIN = 15;
  var EXAMPLES = [['anthropics/skills', 'anthropics/skills'], ['modelcontextprotocol/servers', 'modelcontextprotocol/servers'], ['torvalds/linux', 'torvalds/linux'], ['octocat/Hello-World', 'octocat/Hello-World']];
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 1800); }
  function show(id) { ['progress', 'error', 'result'].forEach(function (x) { $(x).hidden = (x !== id); }); }

  var st = { data: null, stats: null, roast: null, theme: 'terminal', tz: 0, seed: 0, running: false };
  var browserTz = -new Date().getTimezoneOffset() / 60;

  EXAMPLES.forEach(function (ex) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = ex[0];
    b.addEventListener('click', function () { $('repo').value = ex[1]; run(ex[1]); });
    $('examples').appendChild(b);
  });

  /* ---- progress ---- */
  var FLAV = ['Sniffing around the repo…', 'Reading the commit log…', 'Counting the 3 a.m. pushes…', 'Writing jokes (by hand, in advance)…', 'Drawing the card…'];
  function prog(pctv, msg, n) { $('pbar-fill').style.width = pctv + '%'; $('pbar-track').setAttribute('aria-valuenow', pctv); $('pbar-msg').textContent = msg; $('pbar-n').textContent = n || ''; $('pbar-track').classList.toggle('done', pctv >= 100); }

  /* ---- cache ---- */
  function ckey(p) { return 'pushy-roast:' + P.VERSION.split('.')[0] + ':' + p.owner.toLowerCase() + '/' + p.repo.toLowerCase(); }
  function cget(p) { try { var v = JSON.parse(localStorage.getItem(ckey(p))); if (v && v.data && Date.now() - v.t < CACHE_MIN * 60000) return v.data; } catch (e) {} return null; }
  function cset(p, data) { try { localStorage.setItem(ckey(p), JSON.stringify({ t: Date.now(), data: data })); } catch (e) { try { localStorage.clear(); } catch (e2) {} } }

  /* ---- url state ---- */
  function readParams() {
    var q = new URLSearchParams(location.search), out = {};
    out.repo = q.get('repo') || ''; var th = q.get('theme'); if (th && C.THEMES[th]) st.theme = th;
    var tz = parseFloat(q.get('tz')); if (isFinite(tz) && tz >= -12 && tz <= 14) st.tz = tz;
    var r = parseInt(q.get('r'), 10); if (isFinite(r) && r >= 0 && r < 1000) st.seed = r;
    return out;
  }
  function shareUrl() {
    var u = SITE_URL + '?repo=' + encodeURIComponent(st.stats.repo);
    if (st.theme !== 'terminal') u += '&theme=' + st.theme;
    if (st.tz) u += '&tz=' + st.tz;
    if (st.seed) u += '&r=' + st.seed;
    return u;
  }
  function syncUrl() { try { var u = shareUrl().replace(SITE_URL, location.pathname); history.replaceState(null, '', u); } catch (e) {} }

  /* ---- errors ---- */
  function showError(e) {
    var title = 'Something went wrong', body = esc(e && e.message || 'Unknown error'), tips = [];
    var code = e && e.code;
    if (code === 'RATE_LIMIT') {
      title = 'GitHub says: slow down 🐹';
      var when = e.reset ? new Date(e.reset) : null;
      body = esc(e.message) + (when ? ' It resets around <b>' + esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</b> (in about ' + Math.max(1, Math.round((e.reset - Date.now()) / 60000)) + ' min).' : '') + ' Each roast uses 3 to 5 requests.';
      tips = ['Wait for the reset and try again.', 'Or paste a GitHub token (no scopes needed) under "Hit GitHub\'s rate limit?" above for 5,000 requests per hour.', 'Repos you roasted in the last 15 minutes come from the local cache and cost nothing.'];
    } else if (code === 'NOT_FOUND') { title = 'Can\'t find that repo'; tips = ['Pushy only reads public repositories.', 'Check the spelling, or paste the full URL from the address bar.']; }
    else if (code === 'EMPTY') { title = 'Nothing to roast'; }
    else if (code === 'BAD_INPUT') { title = 'Hmm, that\'s not a repo'; tips = ['Try github.com/owner/repo or owner/repo.']; }
    else if (code === 'NETWORK') { title = 'Can\'t reach GitHub'; }
    else if (code === 'BAD_TOKEN') { title = 'That token did not work'; }
    $('errbox').innerHTML = '<div class="errbox"><h3>' + esc(title) + '</h3><p>' + body + '</p>' + (tips.length ? '<ul>' + tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    show('error');
  }

  /* ---- main run ---- */
  async function run(input) {
    if (st.running) return;
    var parsed = P.parseInput(input);
    if (!parsed) { showError({ code: 'BAD_INPUT', message: 'That does not look like a GitHub repo.' }); return; }
    st.running = true; $('go').disabled = true; $('go').textContent = 'Roasting…';
    show('progress'); prog(6, FLAV[0]);
    try {
      var data = cget(parsed), cached = !!data;
      if (!data) {
        var step = 0;
        data = await P.fetchRepoData(parsed, { token: ($('token').value || '').trim() || null, onProgress: function (m) { step++; prog(10 + step * 18, m); } });
        cset(parsed, data);
      } else prog(50, 'Found it in the local cache. No API calls needed.');
      data.fromCache = cached;
      prog(80, FLAV[2]); await new Promise(function (r) { setTimeout(r, 30); });
      st.data = data; st.stats = P.analyze(data, { tz: st.tz }); st.roast = P.roast(st.stats, { seed: st.seed });
      prog(92, FLAV[4]);
      await C.ready();
      render(true);
      prog(100, 'Done.');
      show('result');
      syncUrl();
      $('result').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (e) { showError(e); }
    finally { st.running = false; $('go').disabled = false; $('go').textContent = 'Roast'; }
  }

  /* ---- render ---- */
  function recompute() { st.stats = P.analyze(st.data, { tz: st.tz }); st.roast = P.roast(st.stats, { seed: st.seed }); }
  function drawCard() { C.draw($('card'), { repo: st.stats.repo, title: st.roast.title, tiles: st.roast.tiles, line: st.roast.card, theme: st.theme }); }
  function xText() {
    var s = st.stats, r = st.roast, head = '\uD83D\uDC39 ' + s.repo + ' is a "' + r.title + '". ', tail = '\n\nGet your repo roasted:';
    var room = 280 - 24 - head.length - tail.length - 2, line = r.card.length > room ? r.card.slice(0, Math.max(0, room - 1)) + '\u2026' : r.card;
    return head + line + tail;
  }
  function tzLabel(t) { return t === 0 ? 'UTC' : 'UTC' + (t > 0 ? '+' : '\u2212') + Math.abs(t); }

  function render(full) {
    var s = st.stats, r = st.roast, d = st.data;
    drawCard();
    var themeBtns = Object.keys(C.THEMES).map(function (k) { return '<button type="button" class="chip' + (k === st.theme ? ' on' : '') + '" data-theme="' + esc(k) + '">' + esc(C.THEMES[k].name) + '</button>'; }).join('');
    var tzOpts = '<option value="0"' + (st.tz === 0 ? ' selected' : '') + '>UTC (GitHub default)</option>';
    if (browserTz && Math.abs(browserTz) <= 14) tzOpts += '<option value="' + browserTz + '"' + (st.tz === browserTz ? ' selected' : '') + '>My time (' + esc(tzLabel(browserTz)) + ')</option>';
    for (var z = -12; z <= 14; z++) if (z !== 0 && z !== browserTz) tzOpts += '<option value="' + z + '"' + (st.tz === z ? ' selected' : '') + '>' + esc(tzLabel(z)) + '</option>';
    if (st.tz && Math.floor(st.tz) !== st.tz && st.tz !== browserTz) tzOpts += '<option value="' + st.tz + '" selected>' + esc(tzLabel(st.tz)) + '</option>';
    $('side').innerHTML =
      '<h2>' + esc(r.title) + '</h2><p class="repoline">' + esc(s.repo) + (s.stars ? ' · ★ ' + esc(s.stars.toLocaleString('en-US')) : '') + (s.archived ? ' · archived' : '') + '</p>' +
      '<p class="roasttext">' + esc(r.text) + '</p>' +
      '<div class="actions"><button type="button" class="btn primary sm" id="b-dl">Download PNG</button><button type="button" class="btn ghost sm" id="b-copy">Copy share link</button><button type="button" class="btn ghost sm" id="b-x">Post on X</button></div>' +
      '<p class="xnote">X can\'t attach images from a link: download the PNG first, then attach it to your post.</p>' +
      '<div class="themes"><small>theme:</small>' + themeBtns + '<span class="planned" title="Just a note: nothing to buy, no token needed.">Premium themes · planned</span></div>' +
      '<div class="opt"><small>clock:</small><select id="tz" aria-label="Time zone for night and weekend stats">' + tzOpts + '</select><button type="button" class="btn ghost sm" id="b-reroll">Reroll roast</button></div>';
    $('b-dl').onclick = download; $('b-copy').onclick = copyLink; $('b-x').onclick = postX; $('b-reroll').onclick = function () { st.seed = (st.seed + 1) % 1000; recompute(); render(); syncUrl(); };
    $('tz').onchange = function () { st.tz = parseFloat(this.value) || 0; recompute(); render(); syncUrl(); };
    [].forEach.call(document.querySelectorAll('[data-theme]'), function (b) { b.onclick = function () { st.theme = b.getAttribute('data-theme'); render(); syncUrl(); }; });

    var rl = d.rate && d.rate.remaining != null ? ' · GitHub API budget left: ' + esc(d.rate.remaining) + '/' + esc(d.rate.limit || 60) : '';
    $('runmeta').textContent = (d.fromCache ? 'From local cache (0 API calls this run; original run used ' + d.apiCalls + ')' : d.apiCalls + ' API call' + (d.apiCalls === 1 ? '' : 's')) + ' · ' + s.n + ' commits sampled (' + (s.firstDate || '?') + ' to ' + (s.lastDate || '?') + ')' + (d.fromCache ? '' : rl) + ' · times in ' + tzLabel(st.tz) + ' · roast engine v' + P.VERSION;
    receipts();
  }

  function bars(arr, nightEnd) {
    var mx = Math.max.apply(null, arr) || 1;
    return arr.map(function (v, i) { return '<i class="' + (i < nightEnd ? 'night' : '') + '" style="height:' + Math.max(2, Math.round(v / mx * 100)) + '%" title="' + esc(String(i).padStart(2, '0') + ':00 · ' + v + ' commits') + '"></i>'; }).join('');
  }
  function receipts() {
    var s = st.stats, c = s.counts, F = P.fmtPct;
    var cells = [
      [s.n, 'commits sampled'], [F(s.nightPct) + '%', 'night (00–05h, ' + tzLabel(st.tz) + ')'], [F(s.weekendPct) + '%', 'weekend commits'], [F(s.fridayPct) + '%', 'Friday commits'],
      [F(s.lazyPct) + '%', 'one-word messages'], [Math.round(s.avgLen), 'avg message length'], [c.fix, '"fix" commits'], [c.oops, 'oops / typo / forgot'],
      [c.revert, 'reverts'], [c.force, 'rebase / amend / force'], [c.wip, '"wip" commits'], [s.streak + 'd', 'longest streak'],
      [P.hh(s.busiestHour), 'busiest hour'], [s.busiestWeekdayName.slice(0, 3), 'busiest weekday'], [F(s.emojiPct) + '%', 'commits with emoji'], [F(s.convPct) + '%', 'conventional commits'],
      [F(s.topEff) + '%', s.allTime ? 'by top contributor (all time)' : 'by top author (sample)'], [s.busFactor, 'bus factor (sample)'], [F(s.mergePct) + '%', 'merge commits'], [s.authors, 'authors in sample']
    ];
    var h = '<h2>Receipts</h2><div class="stats">' + cells.map(function (x) { return '<div class="stat"><b>' + esc(x[0]) + '</b><span>' + esc(x[1]) + '</span></div>'; }).join('') + '</div>';
    var wdn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], wm = Math.max.apply(null, s.weekdays) || 1;
    h += '<div class="twocol"><div class="box"><h3>Commits by hour (' + esc(tzLabel(st.tz)) + ')</h3><div class="hist">' + bars(s.hours, 5) + '</div><div class="histlab"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div></div>' +
      '<div class="box"><h3>Commits by weekday</h3><div class="wdays">' + [1, 2, 3, 4, 5, 6, 0].map(function (i) { return '<div class="wd' + (i === 0 || i === 6 ? ' we' : '') + '"><span>' + wdn[i] + '</span><div><i style="width:' + Math.round(s.weekdays[i] / wm * 100) + '%"></i></div><span>' + s.weekdays[i] + '</span></div>'; }).join('') + '</div></div></div>';
    var words = s.topWords.length ? '<div class="tags">' + s.topWords.map(function (w) { return '<span class="tag">' + esc(w.word) + '<em>' + w.n + '</em></span>'; }).join('') + '</div>' : '<p class="empty">No words to count.</p>';
    var emo = s.topEmoji.length ? '<div class="tags" style="margin-top:10px">' + s.topEmoji.map(function (w) { return '<span class="tag">' + esc(w.emoji) + '<em>' + w.n + '</em></span>'; }).join('') + '</div>' : '';
    var lazy = s.lazyTop.length ? '<ul class="msgs">' + s.lazyTop.map(function (m) { return '<li>' + esc(m.text) + '<em>×' + m.n + '</em></li>'; }).join('') + '</ul>' : '<p class="empty">No one-word commit messages in this sample. Impressive.</p>';
    var shortest = s.shortest.length ? '<ul class="msgs">' + s.shortest.map(function (m) { return '<li>' + esc(m.text) + (m.n > 1 ? '<em>×' + m.n + '</em>' : '') + '</li>'; }).join('') + '</ul>' : '';
    h += '<div class="twocol"><div class="box"><h3>Most-used words</h3>' + words + emo + '</div><div class="box"><h3>Laziest messages</h3>' + lazy + (shortest ? '<h3 style="margin-top:14px">Shortest messages</h3>' + shortest : '') + '</div></div>';
    h += '<p class="caveat">Based on the latest ' + esc(s.n) + ' commits only, not the whole history. GitHub reports commit times in UTC, so "night" is a guess unless you pick the right clock above. Merge commits are left out of message stats. Words and messages are filtered for profanity. Just for fun, not a code review.</p>';
    $('receipts').innerHTML = h;
  }

  /* ---- actions ---- */
  function download() {
    var cv = $('card');
    try {
      cv.toBlob(function (b) {
        if (!b) { toast('Could not export the image'); return; }
        var a = document.createElement('a'), url = URL.createObjectURL(b);
        a.href = url; a.download = 'pushy-roast-' + st.stats.repo.replace(/[^A-Za-z0-9._-]+/g, '_') + '.png';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 4000); toast('Card downloaded');
      }, 'image/png');
    } catch (e) { toast('Could not export the image'); }
  }
  function copyLink() {
    var u = shareUrl();
    function fallback() { var t = document.createElement('textarea'); t.value = u; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} t.remove(); toast(ok ? 'Share link copied' : 'Copy failed: ' + u); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(function () { toast('Share link copied'); }, fallback); else fallback();
  }
  function postX() {
    var url = 'https://x.com/intent/post?text=' + encodeURIComponent(xText()) + '&url=' + encodeURIComponent(shareUrl());
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  $('form').addEventListener('submit', function (ev) { ev.preventDefault(); run($('repo').value); });

  var q = readParams();
  if (q.repo) { $('repo').value = q.repo; run(q.repo); }
  window.__roast = { st: st, run: run, xText: xText, shareUrl: shareUrl };
})();
