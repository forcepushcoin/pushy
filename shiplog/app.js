/* Pushy Ship Log — UI glue. All repo-derived text is escaped before it touches innerHTML; the card is drawn with canvas fillText. */
(function () {
  'use strict';
  var P = window.PushyShiplog, C = window.PushyCard;
  var SITE_URL = 'https://forcepushcoin.github.io/shiplog/'; // deployed URL of this page; used for share links
  var CACHE_MIN = 15, SHOW_FIRST = 25;
  var EXAMPLES = ['modelcontextprotocol/servers', 'anthropics/skills', 'vercel/next.js', 'octocat/Hello-World'];
  var TYPE_COL = { feat: '#4cff8f', fix: '#ffc857', docs: '#5aa9ff', chore: '#9aa4b2', other: '#6b7280' };
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https:\/\/github\.com\//.test(String(u || '')) ? u : null; }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 1800); }
  function show(id) { ['progress', 'error', 'result'].forEach(function (x) { $(x).hidden = (x !== id); }); }
  function n(x) { return Number(x).toLocaleString('en-US'); }

  var st = { data: null, sum: null, md: '', theme: 'terminal', days: 30, running: false, input: '' };

  EXAMPLES.forEach(function (ex) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = ex;
    b.addEventListener('click', function () { $('repo').value = ex; run(ex); });
    $('examples').appendChild(b);
  });
  P.WINDOWS.forEach(function (d) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip win' + (d === st.days ? ' on' : ''); b.textContent = d + ' days'; b.setAttribute('data-days', d); b.setAttribute('aria-pressed', d === st.days);
    b.addEventListener('click', function () { setDays(d); if ($('repo').value.trim()) run($('repo').value); });
    $('windows').appendChild(b);
  });
  function setDays(d) { st.days = d; [].forEach.call(document.querySelectorAll('#windows .chip'), function (b) { var on = +b.getAttribute('data-days') === d; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); }

  /* ---- progress ---- */
  function prog(pctv, msg, nn) { $('pbar-fill').style.width = pctv + '%'; $('pbar-track').setAttribute('aria-valuenow', pctv); $('pbar-msg').textContent = msg; $('pbar-n').textContent = nn || ''; $('pbar-track').classList.toggle('done', pctv >= 100); }

  /* ---- cache ---- */
  function ckey(p, d) { return 'pushy-shiplog:' + P.VERSION.split('.')[0] + ':' + p.owner.toLowerCase() + '/' + p.repo.toLowerCase() + ':' + d; }
  function cget(p, d) { try { var v = JSON.parse(localStorage.getItem(ckey(p, d))); if (v && v.data && Date.now() - v.t < CACHE_MIN * 60000) return v.data; } catch (e) {} return null; }
  function cset(p, d, data) { try { localStorage.setItem(ckey(p, d), JSON.stringify({ t: Date.now(), data: data })); } catch (e) { try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('pushy-shiplog:') === 0) localStorage.removeItem(k); }); } catch (e2) {} } }

  /* ---- url state ---- */
  function readParams() {
    var q = new URLSearchParams(location.search);
    var th = q.get('theme'); if (th && C.THEMES[th]) st.theme = th;
    var d = parseInt(q.get('days'), 10); if (P.WINDOWS.indexOf(d) >= 0) setDays(d);
    return { repo: q.get('repo') || '' };
  }
  function shareUrl() { var u = SITE_URL + '?repo=' + encodeURIComponent(st.sum.repo) + '&days=' + st.days; if (st.theme !== 'terminal') u += '&theme=' + st.theme; return u; }
  function syncUrl() { try { history.replaceState(null, '', shareUrl().replace(SITE_URL, location.pathname)); } catch (e) {} }

  /* ---- errors ---- */
  function showError(e) {
    var title = 'Something went wrong', body = esc(e && e.message || 'Unknown error'), tips = [], code = e && e.code;
    if (code === 'RATE_LIMIT') {
      title = 'GitHub says: slow down 🐹';
      var when = e.reset ? new Date(e.reset) : null;
      body = esc(e.message) + (when ? ' It resets around <b>' + esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</b> (in about ' + Math.max(1, Math.round((e.reset - Date.now()) / 60000)) + ' min).' : '') + ' Each Ship Log uses 4 to 7 requests.';
      tips = ['Wait for the reset and try again.', 'Or paste a GitHub token (no scopes needed) under "Hit GitHub\'s rate limit?" above for 5,000 requests per hour.', 'Repos you looked up in the last 15 minutes come from the local cache and cost nothing.'];
    } else if (code === 'NOT_FOUND') { title = 'Can\'t find that repo'; tips = ['Pushy only reads public repositories.', 'Check the spelling, or paste the full URL from the address bar.']; }
    else if (code === 'EMPTY') { title = 'Nothing to summarize'; }
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
    st.running = true; $('go').disabled = true; $('go').textContent = 'Reading…';
    show('progress'); prog(6, 'Looking around…');
    try {
      var data = cget(parsed, st.days), cached = !!data;
      if (!data) {
        var step = 0;
        data = await P.fetchShipData(parsed, st.days, { token: ($('token').value || '').trim() || null, onProgress: function (m) { step++; prog(10 + step * 25, m); } });
        cset(parsed, st.days, data);
      } else prog(50, 'Found it in the local cache. No API calls needed.');
      data.fromCache = cached;
      prog(85, 'Sorting the crates…'); await new Promise(function (r) { setTimeout(r, 20); });
      st.data = data; st.sum = P.summarize(data); st.md = P.toMarkdown(st.sum, { siteUrl: SITE_URL });
      prog(94, 'Drawing the card…');
      await C.ready();
      render();
      prog(100, 'Done.');
      show('result'); syncUrl();
      $('result').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (e) { showError(e); }
    finally { st.running = false; $('go').disabled = false; $('go').textContent = 'Show'; }
  }

  /* ---- render ---- */
  function cardOpts() {
    var s = st.sum, c = s.commitTotal;
    var tiles = [
      { value: s.prCount ? n(s.prCount) : '0', label: 'PRs merged' },
      { value: (c ? n(c) : '0') + (s.commitsExact ? '' : '+'), label: 'commits' },
      { value: String(s.releases.length) + (s.releasesCapped ? '+' : ''), label: s.releases.length === 1 ? 'release' : 'releases' },
      { value: String(s.humans.length || s.contributors.length) + (s.contribCapped ? '+' : ''), label: 'contributors' }
    ];
    var latest = s.releases[0] ? (s.releases[0].tag || s.releases[0].name) + (s.releases[0].date ? ' (' + s.releases[0].date.slice(0, 10) + ')' : '') : '';
    return { repo: s.repo, days: s.days, since: s.since, until: s.until, tiles: tiles, counts: s.counts, kinds: s.kinds, latest: latest, theme: st.theme };
  }
  function drawCard() { C.draw($('card'), cardOpts()); }
  function xText() {
    var s = st.sum, parts = [];
    if (s.prCount) parts.push(n(s.prCount) + ' PRs merged'); else if (s.commitTotal) parts.push(n(s.commitTotal) + ' commits');
    if (s.releases.length) parts.push(s.releases.length + (s.releasesCapped ? '+' : '') + (s.releases.length === 1 ? ' release' : ' releases'));
    if (s.counts.feat) parts.push(s.counts.feat + ' feat');
    if (s.counts.fix) parts.push(s.counts.fix + ' fix');
    var head = '\uD83D\uDCE6 ' + s.repo + ' shipped in the last ' + s.days + ' days: ', tail = '\n\nShip log:';
    var body = parts.length ? parts.join(' \u00b7 ') : 'a quiet window';
    var room = 280 - 24 - head.length - tail.length - 2; if (body.length > room) body = body.slice(0, Math.max(0, room - 1)) + '\u2026';
    return head + body + tail;
  }

  function themeBtns() { return Object.keys(C.THEMES).map(function (k) { return '<button type="button" class="chip' + (k === st.theme ? ' on' : '') + '" data-theme="' + esc(k) + '">' + esc(C.THEMES[k].name) + '</button>'; }).join(''); }

  function render() {
    var s = st.sum, d = st.data;
    drawCard();
    var summaryLine = s.empty ? 'Nothing shipped in the last ' + s.days + ' days.' : (s.prCount ? n(s.prCount) + ' PRs merged' : '') + (s.prCount && s.commitTotal ? ' · ' : '') + (s.commitTotal ? n(s.commitTotal) + (s.commitsExact ? '' : '+') + ' commits' : '') + (s.releases.length ? ' · ' + s.releases.length + (s.releasesCapped ? '+' : '') + (s.releases.length === 1 ? ' release' : ' releases') : '');
    $('side').innerHTML =
      '<h2>Shipped in ' + esc(s.days) + ' days</h2><p class="repoline">' + esc(s.repo) + (s.stars ? ' · ★ ' + esc(n(s.stars)) : '') + (s.archived ? ' · archived' : '') + '</p>' +
      '<p class="roasttext">' + esc(summaryLine) + '<br><span style="color:var(--muted);font-size:.86rem">' + esc(s.since) + ' → ' + esc(s.until) + ' (UTC)</span></p>' +
      '<div class="actions"><button type="button" class="btn primary sm" id="b-dl">Download PNG</button><button type="button" class="btn ghost sm" id="b-md">Copy Markdown</button><button type="button" class="btn ghost sm" id="b-x">Post on X</button><button type="button" class="btn ghost sm" id="b-copy">Copy link</button></div>' +
      '<p class="xnote">X can\'t attach images from a link: download the PNG first, then attach it to your post.</p>' +
      '<div class="themes"><small>theme:</small>' + themeBtns() + '</div>';
    $('b-dl').onclick = download; $('b-md').onclick = copyMd; $('b-x').onclick = postX; $('b-copy').onclick = copyLink;
    [].forEach.call(document.querySelectorAll('[data-theme]'), function (b) { b.onclick = function () { st.theme = b.getAttribute('data-theme'); render(); syncUrl(); }; });
    var rl = d.rate && d.rate.remaining != null ? ' · GitHub API budget left: ' + esc(d.rate.remaining) + '/' + esc(d.rate.limit || 60) : '';
    $('runmeta').textContent = (d.fromCache ? 'From local cache (0 API calls this run; original run used ' + d.apiCalls + ')' : d.apiCalls + ' API call' + (d.apiCalls === 1 ? '' : 's')) + (d.fromCache ? '' : rl) + ' · window starts ' + s.since + ' UTC · ship log v' + P.VERSION;
    receipts();
  }

  function listItem(it) {
    var u = safeUrl(it.url), ref = it.n ? '#' + it.n : (it.sha || '');
    var label = esc(it.title);
    return '<li><span class="t">' + (it.scope ? '<span class="sc">' + esc(it.scope) + '</span>' : '') + label + '</span><span class="m">' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(ref) + '</a>' : esc(ref)) + ' · ' + esc(it.user) + '</span></li>';
  }
  function receipts() {
    var s = st.sum, h = '';
    var cells = [[s.prCount ? n(s.prCount) : '0', 'PRs merged' + (s.prFailed ? ' (search unavailable)' : '')], [(s.commitTotal ? n(s.commitTotal) : '0') + (s.commitsExact ? '' : '+'), 'commits'], [s.releases.length + (s.releasesCapped ? '+' : ''), 'releases'], [s.contributors.length + (s.contribCapped ? '+' : ''), 'contributors' + (s.contribCapped ? (s.contribBasis === 'prs' ? ' (latest ' + s.prShown + ' PRs)' : ' (latest ' + s.commitsSampled + ' commits)') : '')], [s.counts.feat, 'feat'], [s.counts.fix, 'fix']];
    h += '<h2>Changelog</h2><div class="stats">' + cells.map(function (x) { return '<div class="stat"><b>' + esc(x[0]) + '</b><span>' + esc(x[1]) + '</span></div>'; }).join('') + '</div>';
    if (s.empty) h += '<p class="empty" style="margin-top:14px">Nothing was merged, committed or released in this window. Try a longer one.</p>';
    var legend = P.TYPES.filter(function (t) { return s.counts[t]; }).map(function (t) { return '<span><i style="background:' + TYPE_COL[t] + '"></i>' + esc(t) + ' ' + s.counts[t] + '</span>'; }).join('');
    if (legend) h += '<div class="legend">' + legend + '</div>';
    if (s.total) h += '<p class="caveat" style="margin-top:10px">Listing ' + esc(s.total) + (s.source === 'prs' ? ' merged PRs' + (s.prCapped ? ' (latest ' + esc(s.prShown) + ' of ' + esc(n(s.prCount)) + ')' : '') : ' commits' + (s.commitsCapped ? ' (latest ' + esc(s.commitsSampled) + ' of ' + esc(n(s.commitTotal)) + ')' : '')) + '. ' + (s.source === 'commits' ? 'No merged PRs found, so commit subjects are used (merge commits skipped). ' : '') + 'Types come from the title prefix, then PR labels, then simple keywords; the rest is "other".</p>';
    P.TYPES.forEach(function (t, i) {
      var g = s.groups[t]; if (!g.length) return;
      h += '<details class="group" data-t="' + t + '"' + (g.length && (t === 'feat' || t === 'fix' || (!s.counts.feat && !s.counts.fix)) ? ' open' : '') + '><summary><span class="dot" style="background:' + TYPE_COL[t] + '"></span>' + esc(P.TYPE_NAMES[t]) + '<span class="n">' + g.length + '</span></summary><ul>' + g.slice(0, SHOW_FIRST).map(listItem).join('') + '</ul>' +
        (g.length > SHOW_FIRST ? '<button type="button" class="btn ghost sm more" data-more="' + t + '">Show ' + (g.length - SHOW_FIRST) + ' more</button>' : '') + '</details>';
    });
    var relH = s.releases.length ? '<ul class="rels">' + s.releases.slice(0, 15).map(function (r) {
      var u = safeUrl(r.url), nm = esc(r.name || r.tag);
      return '<li><span>' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + nm + '</a>' : nm) + (r.pre ? '<span class="pre">pre-release</span>' : '') + '</span><span class="mono" style="color:var(--muted);font-size:.8rem">' + esc((r.date || '').slice(0, 10)) + '</span></li>';
    }).join('') + '</ul>' + (s.releases.length > 15 ? '<p class="empty">+ ' + (s.releases.length - 15) + ' more</p>' : '') :
      (s.tags && s.tags.length ? '<p class="empty">No GitHub releases. Latest tags (GitHub does not date them in the list):</p><div class="tags" style="margin-top:8px">' + s.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' : '<p class="empty">No releases in this window.</p>');
    var mx = s.contributors.length ? s.contributors[0].n : 1;
    var coH = s.contributors.length ? '<ul class="contribs">' + s.contributors.slice(0, 8).map(function (c) {
      return '<li><div><span class="u">' + esc(c.user) + (c.bot ? ' <em style="color:var(--muted);font-style:normal">bot</em>' : '') + '</span><span class="bar"><i style="width:' + Math.round(c.n / mx * 100) + '%"></i></span></div><span class="c">' + c.n + '</span></li>';
    }).join('') + '</ul><p class="caveat" style="margin-top:8px">By ' + (s.contribBasis === 'commits' ? 'commits' + (s.commitsCapped ? ' in the latest ' + esc(s.commitsSampled) + ' of the window' : '') : 'merged PRs') + '.</p>' : '<p class="empty">No contributors in this window.</p>';
    h += '<div class="twocol" style="margin-top:18px"><div class="box"><h3>Releases &amp; tags</h3>' + relH + '</div><div class="box"><h3>Top contributors</h3>' + coH + '</div></div>';
    h += '<details class="box" style="margin-top:14px"><summary style="cursor:pointer;font-family:var(--mono);font-size:.86rem;color:var(--muted)">Markdown preview (what "Copy Markdown" copies)</summary><pre class="mdpre" id="mdpre"></pre></details>';
    $('receipts').innerHTML = h;
    $('mdpre').textContent = st.md;
    [].forEach.call(document.querySelectorAll('[data-more]'), function (b) {
      b.onclick = function () { var t = b.getAttribute('data-more'); b.parentNode.querySelector('ul').innerHTML = s.groups[t].map(listItem).join(''); b.remove(); };
    });
  }

  /* ---- actions ---- */
  function download() {
    var cv = $('card');
    try {
      cv.toBlob(function (b) {
        if (!b) { toast('Could not export the image'); return; }
        var a = document.createElement('a'), url = URL.createObjectURL(b);
        a.href = url; a.download = 'pushy-shiplog-' + st.sum.repo.replace(/[^A-Za-z0-9._-]+/g, '_') + '-' + st.days + 'd.png';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 4000); toast('Card downloaded');
      }, 'image/png');
    } catch (e) { toast('Could not export the image'); }
  }
  function copyText(text, okMsg, failMsg) {
    function fallback() { var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} t.remove(); toast(ok ? okMsg : failMsg); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback); else fallback();
  }
  function copyMd() { copyText(st.md, 'Markdown copied', 'Copy failed: select it in the preview below'); }
  function copyLink() { copyText(shareUrl(), 'Link copied', 'Copy failed'); }
  function postX() {
    var url = 'https://x.com/intent/post?text=' + encodeURIComponent(xText()) + '&url=' + encodeURIComponent(shareUrl());
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  $('form').addEventListener('submit', function (ev) { ev.preventDefault(); run($('repo').value); });

  var q = readParams();
  if (q.repo) { $('repo').value = q.repo; run(q.repo); }
  window.__shiplog = { st: st, run: run, xText: xText, shareUrl: shareUrl };
})();
