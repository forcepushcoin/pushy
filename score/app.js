/* Pushy Score — UI glue. All dynamic text is escaped before it touches innerHTML. */
(function () {
  'use strict';
  var R = window.PUSHY_RULES, P = window.Pushy;
  var SITE_URL = 'https://forcepushcoin.github.io/score/'; // set to the deployed URL of this page, e.g. "https://you.github.io/forcepush/score/", to add a link to the badge markdown
  var EXAMPLES = [
    ['anthropics/skills', 'anthropics/skills'],
    ['anthropics/skills · pdf', 'https://github.com/anthropics/skills/tree/main/skills/pdf'],
    ['modelcontextprotocol/servers', 'modelcontextprotocol/servers'],
    ['octocat/Hello-World', 'octocat/Hello-World']
  ];
  var CACHE_MIN = 10;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 1800); }
  var SEV = ['critical', 'high', 'medium', 'low', 'info'];
  var SEVCOL = { green: '#5be39a', yellow: '#ffd166', orange: '#ff9f43', red: '#ff5c5c', gray: '#b6c3e0' };
  var current = null;

  /* ---- examples + ruleset table ---- */
  EXAMPLES.forEach(function (ex) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = ex[0];
    b.addEventListener('click', function () { $('repo').value = ex[1]; run(ex[1]); });
    $('examples').appendChild(b);
  });
  (function table() {
    $('rv').textContent = 'v' + R.RULESET.version + ' · ' + R.RULESET.date;
    var rows = [], all = [].concat(R.lineRules, R.specialRules, R.pathRules, R.fileRules, R.repoRules);
    all.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    all.forEach(function (r) { rows.push('<tr><td class="id">' + esc(r.id) + '</td><td>' + esc(R.CATEGORIES[r.cat].name) + '</td><td><span class="sev ' + r.sev + '">' + r.sev + '</span></td><td>' + esc(r.title) + '</td></tr>'); });
    document.querySelector('#ruletable tbody').innerHTML = rows.join('');
  })();

  /* ---- progress log ---- */
  var logLines = [];
  function logReset() { logLines = []; $('log').innerHTML = ''; }
  function logAdd(msg, cls) { logLines.push('<span class="' + (cls || 'd') + '">' + esc(msg) + '</span>'); $('log').innerHTML = logLines.join('\n') + '\n<span class="cur"></span>'; }
  function show(id) { ['progress', 'error', 'result'].forEach(function (x) { $(x).hidden = (x !== id); }); if (id === 'result') $('result').hidden = false; }

  /* ---- cache ---- */
  function ckey(p) { return 'pushy:' + R.RULESET.version + ':' + p.owner.toLowerCase() + '/' + p.repo.toLowerCase() + '|' + (p.refSegments || []).join('/'); }
  function cget(p) { try { var v = JSON.parse(localStorage.getItem(ckey(p))); if (v && Date.now() - v.t < CACHE_MIN * 60000) return v; } catch (e) {} return null; }
  function cset(p, rep) { try { localStorage.setItem(ckey(p), JSON.stringify({ t: Date.now(), rep: rep })); } catch (e) {} }

  /* ---- run ---- */
  var busy = false;
  async function run(input, force) {
    if (busy) return;
    var parsed = P.parseInput(input);
    if (!parsed) { return showError({ code: 'BAD_INPUT', message: 'That does not look like a GitHub repo. Try github.com/owner/repo or owner/repo.' }); }
    busy = true; $('go').disabled = true; $('go').textContent = 'Scanning…';
    try { history.replaceState(null, '', '?repo=' + encodeURIComponent(input.trim())); } catch (e) {}
    var cached = !force && cget(parsed);
    if (cached) { render(cached.rep, { cachedAt: cached.t }); finish(); return; }
    show('progress'); logReset(); logAdd('$ pushy scan ' + input.trim(), 'ok');
    try {
      var rep = await P.scan(parsed, {
        token: ($('token').value || '').trim() || null,
        onProgress: function (m) { logAdd('→ ' + m); },
        onFile: function (n, tot, p) { if (n === tot || n % 10 === 0) logAdd('   read ' + n + '/' + tot + ' files'); }
      });
      logAdd('✓ done: ' + rep.score + '/100', 'ok');
      cset(parsed, rep);
      render(rep, {});
    } catch (e) { showError(e); }
    finish();
    function finish() { busy = false; $('go').disabled = false; $('go').textContent = 'Scan'; }
  }

  function showError(e) {
    var h = '<div class="errbox">';
    if (e.code === 'RATE_LIMIT') {
      var when = e.reset ? new Date(e.reset) : null, mins = when ? Math.max(1, Math.ceil((when - Date.now()) / 60000)) : null;
      h += '<h3>GitHub says: slow down 🐹</h3><p>' + esc(e.message) + '</p>' +
        '<p>' + (when ? 'It resets around <b>' + esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</b> (in about ' + mins + ' min).' : 'It resets within the hour.') + ' Each scan uses about 4 requests.</p>' +
        '<ul><li>Wait for the reset and try again.</li><li>Or paste a GitHub token (no scopes needed) under "Hit GitHub\'s rate limit?" above: it stays in this tab and goes only to api.github.com.</li><li>Or switch network: the limit is per IP address.</li></ul>';
      document.querySelector('details.tok').open = true;
    } else if (e.code === 'NOT_FOUND') {
      h += '<h3>Can\'t find that repo</h3><p>' + esc(e.message) + '</p><ul><li>Pushy only reads <b>public</b> repositories.</li><li>Check the spelling, or paste the full URL from the address bar.</li></ul>';
    } else if (e.code === 'EMPTY') {
      h += '<h3>Nothing to scan</h3><p>' + esc(e.message) + '</p>';
    } else if (e.code === 'BAD_INPUT') {
      h += '<h3>Hmm, that\'s not a repo</h3><p>' + esc(e.message) + '</p>';
    } else {
      h += '<h3>Scan failed</h3><p>' + esc(e.message || String(e)) + '</p><ul><li>This runs entirely in your browser; an ad-blocker or offline network can block GitHub or the CDN.</li></ul>';
    }
    h += '</div>';
    $('errbox').innerHTML = h; show('error');
  }

  /* ---- render ---- */
  function sevCount(c) { return SEV.filter(function (s) { return c[s]; }).map(function (s) { return c[s] + ' ' + s; }).join(' · ') || 'clean'; }
  function ring(score, color) {
    var r = 80, c = 2 * Math.PI * r, dash = c * score / 100;
    return '<div class="ring"><svg viewBox="0 0 190 190"><circle class="bg" cx="95" cy="95" r="' + r + '" fill="none" stroke-width="16"/><circle cx="95" cy="95" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="16" stroke-linecap="round" stroke-dasharray="' + dash.toFixed(1) + ' ' + c.toFixed(1) + '"/></svg><div class="num"><b>' + score + '</b><small>/ 100</small></div></div>';
  }
  function render(rep, o) {
    current = rep;
    var col = SEVCOL[rep.band.key] || '#b6c3e0', h = '', r = rep.repo;
    var where = r.owner + '/' + r.name + (rep.subpath ? '/' + rep.subpath : '');
    h += '<div class="scorecard">' + ring(rep.score, col) + '<div>' +
      '<div class="verdict ' + esc(rep.band.key) + '">' + esc(rep.band.label) + '</div>' +
      '<p class="vline">' + esc(rep.band.line) + '</p>' +
      '<div class="meta"><span><a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(where) + '</a></span><span>commit <a href="' + esc(r.url + '/commit/' + rep.sha) + '" target="_blank" rel="noopener noreferrer">' + esc(rep.shortSha) + '</a></span><span>' + esc(rep.scoreDay) + '</span><span>ruleset v' + esc(rep.ruleset.version) + '</span>' +
      (r.stars != null ? '<span>★ ' + esc(r.stars) + '</span>' : '') + '</div>' +
      (rep.capped ? '<div class="capnote"><b>Score capped:</b> raw score was ' + rep.rawScore + ', limited to ' + rep.score + ' because:<ul>' + rep.caps.filter(function (c) { return c.value <= rep.score; }).map(function (c) { return '<li>' + esc(c.reason) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<div class="disc-inline">Automated scan, not an audit or guarantee.' + (o.cachedAt ? ' · cached result from ' + Math.max(0, Math.round((Date.now() - o.cachedAt) / 60000)) + ' min ago · <a href="#" id="rescan">rescan</a>' : '') + (rep.rate && rep.rate.remaining != null ? ' · GitHub API budget left: ' + rep.rate.remaining + '/' + rep.rate.limit : '') + '</div>' +
      '</div></div>';

    // sub-scores
    h += '<div class="subs">';
    Object.keys(R.CATEGORIES).forEach(function (c) {
      var s = rep.sub[c], cc = s.score >= 85 ? '#5be39a' : s.score >= 70 ? '#ffd166' : s.score >= 45 ? '#ff9f43' : '#ff5c5c';
      h += '<div class="sub-card"><h3>' + esc(R.CATEGORIES[c].name) + '</h3><small>' + esc(R.CATEGORIES[c].hint) + '</small><div class="n">' + s.score + ' <i>/ 100</i></div><div class="bar2"><span style="width:' + s.score + '%;background:' + cc + '"></span></div><div class="cnt">' + esc(sevCount(s.counts)) + '</div></div>';
    });
    h += '</div>';

    // blind spots (mandatory)
    var cov = rep.coverage, notAn = rep.skipped, so = rep.skippedOther;
    h += '<div class="panel blind" id="blind"><h2>⚠ Blind spots — read this</h2>' +
      '<div>Pushy analyzed <b>' + cov.analyzed + '</b> of <b>' + cov.relevantTotal + '</b> scannable files (' + cov.totalFiles + ' files in scope). ' + (cov.skippedCounted ? '<b>' + cov.skippedCounted + ' scannable file(s) were NOT analyzed.</b>' : 'No scannable files were skipped.') + (cov.treeTruncated ? ' <b>GitHub truncated the file tree: some files were never listed.</b>' : '') + '</div>' +
      '<ul>' + rep.blindSpots.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' +
      (cov.skippedCounted && !rep.subpath ? '<div class="tip">Tip: scan a sub-folder for full coverage, e.g. <code>github.com/' + esc(r.owner + '/' + r.name) + '/tree/' + esc(rep.ref) + '/&lt;folder&gt;</code>.</div>' : '') +
      '<details' + (notAn.length ? ' open' : '') + '><summary>Not analyzed (' + notAn.length + ')' + '</summary>' + (notAn.length ? '<ul class="flist">' + notAn.slice(0, 150).map(function (s) { return '<li><span>' + esc(s.reason) + '</span>' + esc(s.path) + '</li>'; }).join('') + (notAn.length > 150 ? '<li><span>…</span>and ' + (notAn.length - 150) + ' more</li>' : '') + '</ul>' : '<p style="margin:8px 0 0;font-size:.88rem">Nothing skipped among scannable files.</p>') +
      '<p style="margin:10px 0 0;font-size:.84rem;color:var(--muted)">Also ignored: ' + [so.image + ' image(s)', so.vendored + ' vendored/build file(s)', so.lock + ' lockfile(s)', so.minified + ' minified/map file(s)', so.license + ' license/notice file(s)', so.other + ' file(s) of other types (fonts, schemas, data…) not opened'].join(', ') + '.</p></details>' +
      '<details><summary>Analyzed (' + rep.analyzed.length + ')</summary><ul class="flist">' + rep.analyzed.map(function (a) { return '<li><span>' + esc(Math.round(a.bytes / 102.4) / 10) + ' KB</span>' + esc(a.path) + '</li>'; }).join('') + '</ul></details></div>';

    // findings
    h += '<div class="panel"><h2><span style="color:var(--green);font-family:var(--mono)">// </span>Findings <span class="pill">' + rep.findings.length + '</span></h2><div class="filters" id="filters"></div><div id="findings"></div></div>';

    // green flags
    if (rep.greenFlags.length) h += '<div class="panel"><h2 style="font-size:1.1rem">What looked good</h2><div class="green-flags">' + rep.greenFlags.map(function (g) { return '<span class="gf">✓ ' + esc(g) + '</span>'; }).join('') + '</div></div>';

    // badge
    var svg = P.badgeSVG(rep), md = P.badgeMarkdown(rep, SITE_URL);
    h += '<div class="panel"><h2><span style="color:var(--green);font-family:var(--mono)">// </span>Your badge</h2><div class="badgebox"><div class="badgeprev" id="badgeprev">' + svg + '</div>' +
      '<div><b style="font-family:var(--mono);font-size:.8rem;color:var(--muted)">README MARKDOWN</b><pre class="md" id="mdsnip">' + esc(md) + '</pre></div>' +
      '<div class="row"><button class="btn primary sm" id="dlsvg" type="button">Download SVG</button><button class="btn ghost sm" id="cpmd" type="button">Copy markdown</button><button class="btn ghost sm" id="dljson" type="button">Download JSON report</button><button class="btn ghost sm" id="cplink" type="button">Copy share link</button></div>' +
      '<p style="margin:0;color:var(--muted);font-size:.86rem">Commit <code>pushy-score.svg</code> to your repo root. It is a <b>static snapshot</b> of commit <code>' + esc(rep.shortSha) + '</code> on ' + esc(rep.scoreDay) + ' (not a live badge): rescan after you push. It says "automated scan, not an audit" on purpose.</p></div></div>';

    $('resultbox').innerHTML = h; show('result');
    renderFindings('all');
    bind(rep, svg, md);
    var rs = $('rescan'); if (rs) rs.addEventListener('click', function (e) { e.preventDefault(); run($('repo').value, true); });
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderFindings(filter) {
    var rep = current, list = rep.findings;
    var fh = '<button class="chip' + (filter === 'all' ? ' on' : '') + '" data-f="all">All ' + list.length + '</button>';
    SEV.forEach(function (s) { var n = list.filter(function (f) { return f.sev === s; }).length; if (n) fh += '<button class="chip' + (filter === s ? ' on' : '') + '" data-f="' + s + '">' + s + ' ' + n + '</button>'; });
    $('filters').innerHTML = fh;
    [].forEach.call($('filters').querySelectorAll('.chip'), function (b) { b.addEventListener('click', function () { renderFindings(b.getAttribute('data-f')); }); });
    var vis = filter === 'all' ? list : list.filter(function (f) { return f.sev === filter; });
    if (!vis.length) { $('findings').innerHTML = '<div class="nofind">' + (list.length ? 'Nothing at this severity.' : 'No rule fired. That does not mean it is safe, so read the blind spots above. 🐹') + '</div>'; return; }
    var groups = {}, order = [];
    vis.forEach(function (f) { var k = f.id + '|' + f.sev; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(f); });
    order.sort(function (a, b) { return P.SEV_ORDER[groups[b][0].sev] - P.SEV_ORDER[groups[a][0].sev] || (a < b ? -1 : 1); });
    $('findings').innerHTML = order.map(function (k) {
      var g = groups[k], f = g[0];
      var occ = g.map(function (x, i) {
        var loc = x.path ? (x.path + (x.line ? ':' + x.line : '')) : 'repository';
        return '<li' + (i >= 5 ? ' class="hid" hidden' : '') + '>' + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(loc) + '</a>' : '<span class="mono">' + esc(loc) + '</span>') +
          (x.note ? ' <span class="onote">(' + esc(x.note) + ')</span>' : '') + (x.snippet ? '<pre>' + esc(x.snippet) + '</pre>' : '') + '</li>';
      }).join('');
      return '<div class="grp ' + f.sev + '"><div class="gh"><span class="sev ' + f.sev + '">' + f.sev + '</span><span class="rid">' + esc(f.id) + '</span><h3>' + esc(f.title) + '</h3><span class="cnt-b">' + g.length + ' hit' + (g.length > 1 ? 's' : '') + '</span></div>' +
        '<p class="why"><b>Why it matters</b><br>' + esc(f.why) + '</p><p class="fix"><b>Fix</b><br>' + esc(f.fix) + '</p><ul class="occ">' + occ + '</ul>' +
        (g.length > 5 ? '<button class="btn ghost sm more" type="button">Show ' + (g.length - 5) + ' more</button>' : '') + '</div>';
    }).join('');
    [].forEach.call($('findings').querySelectorAll('.more'), function (b) { b.addEventListener('click', function () { [].forEach.call(b.parentNode.querySelectorAll('li.hid'), function (li) { li.hidden = false; }); b.remove(); }); });
  }

  function download(name, text, type) { var a = document.createElement('a'), u = URL.createObjectURL(new Blob([text], { type: type })); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 500); }
  function copy(text, ok) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(ok); }, function () { var r = document.createRange(); r.selectNodeContents($('mdsnip')); var s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Press Ctrl/Cmd+C to copy'); }); }
  function bind(rep, svg, md) {
    $('dlsvg').addEventListener('click', function () { download('pushy-score.svg', svg, 'image/svg+xml'); });
    $('cpmd').addEventListener('click', function () { copy(md, 'Markdown copied'); });
    $('dljson').addEventListener('click', function () { download('pushy-report-' + rep.repo.owner + '-' + rep.repo.name + '-' + rep.shortSha + '.json', JSON.stringify(rep, null, 2), 'application/json'); });
    $('cplink').addEventListener('click', function () { copy(location.origin + location.pathname + '?repo=' + encodeURIComponent($('repo').value.trim()), 'Link copied'); });
  }

  $('form').addEventListener('submit', function (e) { e.preventDefault(); run($('repo').value, false); });
  var q = new URLSearchParams(location.search).get('repo');
  if (q) { $('repo').value = q; run(q, false); }
  window.__pushy = { run: run, get current() { return current; } };
})();
