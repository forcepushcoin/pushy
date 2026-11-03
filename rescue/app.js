/* Pushy Rescue — UI glue. Every repo-derived string is escaped before it touches innerHTML; links are limited to https://github.com/. */
(function () {
  'use strict';
  var P = window.Pushy, RS = window.PushyRescue, R = window.PUSHY_RULES;
  var EXAMPLES = ['modelcontextprotocol/servers', 'anthropics/skills', 'octocat/Hello-World'];
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https:\/\/github\.com\//.test(String(u || '')) ? String(u) : null; }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 1800); }
  function show(id) { ['progress', 'error', 'result'].forEach(function (x) { $(x).hidden = (x !== id); }); }
  var st = { running: false, res: null, rep: null };

  EXAMPLES.forEach(function (ex) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = ex;
    b.addEventListener('click', function () { $('repo').value = ex; run(ex); });
    $('examples').appendChild(b);
  });

  /* ---- progress ---- */
  var pg = { raf: 0, n: 0, tot: 0, path: '', bytes: 0, t0: 0 };
  function progReset() { pg = { raf: 0, n: 0, tot: 0, path: '', bytes: 0, t0: Date.now() }; $('pbar-track').classList.remove('done'); $('pbar-fill').style.width = '3%'; $('pbar-msg').textContent = 'Looking around…'; $('pbar-n').textContent = ''; $('pbar-sub').textContent = ''; $('progtitle').textContent = 'looking for something to rescue…'; }
  function progMsg(m) { $('pbar-msg').textContent = m; }
  function progPaint() {
    pg.raf = 0; var f = pg.tot ? pg.n / pg.tot : 0;
    $('pbar-fill').style.width = Math.max(3, Math.round(f * 90)) + '%'; $('pbar-track').setAttribute('aria-valuenow', Math.round(f * 90));
    $('pbar-n').textContent = 'Reading ' + pg.n + '/' + pg.tot + ' files…';
    $('pbar-sub').textContent = pg.path + ' · ' + Math.round(pg.bytes / 1024).toLocaleString('en-US') + ' KB · ' + ((Date.now() - pg.t0) / 1000).toFixed(1) + ' s';
  }
  function progFile(n, tot, p, bytes) { pg.n = n; pg.tot = tot; pg.path = p; pg.bytes = bytes; if (!pg.raf) pg.raf = (window.requestAnimationFrame || setTimeout)(progPaint); }
  function progDone(m) { if (pg.raf) { try { cancelAnimationFrame(pg.raf); } catch (e) {} } $('pbar-fill').style.width = '100%'; $('pbar-track').classList.add('done'); $('pbar-track').setAttribute('aria-valuenow', 100); progMsg(m || 'Done.'); }

  /* ---- errors ---- */
  function showError(e) {
    var code = e && e.code, title = 'Something went wrong', body = esc((e && e.message) || 'Unknown error'), tips = [];
    if (code === 'RATE_LIMIT') {
      var when = e.reset ? new Date(e.reset) : null;
      title = 'GitHub says: slow down 🐹';
      body = esc(e.message) + (when ? ' It resets around <b>' + esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</b>.' : '') + ' Each Rescue uses about 4 requests.';
      tips = ['Wait for the reset and try again.', 'Or paste a GitHub token (no scopes needed) under "Hit GitHub\'s rate limit?" above.', 'Or switch network: the limit is per IP address.'];
      var d = document.querySelector('details.tok'); if (d) d.open = true;
    } else if (code === 'NOT_FOUND') { title = 'Can\'t find that repo'; tips = ['Pushy only reads public repositories.', 'Check the spelling, or paste the full URL from the address bar.']; }
    else if (code === 'EMPTY') { title = 'Nothing to scan'; }
    else if (code === 'BAD_INPUT') { title = 'Hmm, that\'s not a repo'; tips = ['Try github.com/owner/repo or owner/repo.']; }
    else { title = 'Rescue failed'; tips = ['This runs entirely in your browser; an ad-blocker or offline network can block GitHub or the CDN.']; }
    $('errbox').innerHTML = '<div class="errbox"><h3>' + esc(title) + '</h3><p>' + body + '</p>' + (tips.length ? '<ul>' + tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    show('error');
  }

  /* ---- main run ---- */
  async function run(input) {
    if (st.running) return;
    var parsed = P.parseInput(input);
    if (!parsed) { showError({ code: 'BAD_INPUT', message: 'That does not look like a GitHub repo.' }); return; }
    st.running = true; $('go').disabled = true; $('go').textContent = 'Working…';
    try { history.replaceState(null, '', '?repo=' + encodeURIComponent(String(input).trim())); } catch (e) {}
    show('progress'); progReset();
    try {
      var rep = await P.scan(parsed, {
        token: ($('token').value || '').trim() || null,
        keepContext: true,
        onProgress: function (m) { progMsg(m); },
        onFile: function (n, tot, p, bytes) { progFile(n, tot, p, bytes); }
      });
      progMsg('Working out the fixes…');
      await new Promise(function (r) { setTimeout(r, 20); });
      var res = RS.build(rep);
      progDone('Done.');
      st.rep = rep; st.res = res;
      render(rep, res);
      show('result');
      $('result').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (e) { showError(e); }
    finally { st.running = false; $('go').disabled = false; $('go').textContent = 'Rescue'; }
  }

  /* ---- render ---- */
  function blobUrl(rep, p, line) {
    var base = safeUrl(rep.repo && rep.repo.url); if (!base || !p) return null;
    return base + '/blob/' + encodeURIComponent(rep.sha) + '/' + p.split('/').map(encodeURIComponent).join('/') + (line ? '#L' + line : '');
  }
  function where(rep, p, line) {
    if (!p) return '<span>repository</span>';
    var u = blobUrl(rep, p, line), t = esc(p + (line ? ':' + line : ''));
    return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>' : t;
  }
  function diffHtml(it, secrets) {
    var h = '';
    it.before.forEach(function (l) { h += '<span class="m">- ' + esc(RS.redact(l, secrets)).slice(0, 400) + '</span>'; });
    it.after.forEach(function (l) { h += '<span class="p">+ ' + esc(RS.redact(l, secrets)).slice(0, 400) + '</span>'; });
    return h;
  }
  function patchHtml(p) {
    return p.split('\n').map(function (l) {
      var c = /^(\+\+\+|---|diff |@@|new file)/.test(l) ? 'c' : l[0] === '+' ? 'p' : l[0] === '-' ? 'm' : 'c';
      return '<span class="' + c + '">' + (esc(l) || ' ') + '</span>';
    }).join('');
  }
  function resTag(it) {
    if (it.isNew) return '<span class="res ok">re-scan: cleared</span>';
    return it.cleared ? '<span class="res ok">re-scan: cleared</span>' : '<span class="res warn">re-scan: ' + esc(it.remaining) + ' still flagged</span>';
  }
  function fname(rep) { return 'pushy-rescue-' + String(rep.repo.owner + '-' + rep.repo.name).replace(/[^A-Za-z0-9._-]+/g, '_') + '.patch'; }

  function render(rep, res) {
    var h = '', sec = res.secrets, name = rep.repo.owner + '/' + rep.repo.name;
    var nFix = res.items.length, nMan = res.manual.length;
    h += '<div class="scoreline"><div class="sbox"><small>Actual score</small><b>' + esc(res.score) + ' <i>/ 100</i></b><div class="bd">' + esc(res.band.label) + ' · from Pushy Score, unchanged</div></div>';
    if (res.projected && res.baselineOk) h += '<div class="arrow">→</div><div class="sbox proj"><small>Projected if patch applied <em>what-if</em></small><b>' + esc(res.projected.score) + ' <i>/ 100</i></b><div class="bd">same rules re-run on the patched files · not a score</div></div>';
    else h += '<div class="arrow">·</div><div class="sbox proj"><small>Projected score</small><b>n/a</b><div class="bd">' + (res.projected ? 'the re-scan did not reproduce the original result' : 'nothing here can be patched mechanically') + '</div></div>';
    h += '</div>';
    h += '<p class="summary"><b>' + esc(name) + '</b> <span>· commit ' + esc(rep.shortSha) + ' · ' + nFix + ' suggested edit' + (nFix === 1 ? '' : 's') + (res.patchFiles.length ? ' in ' + res.patchFiles.length + ' file' + (res.patchFiles.length === 1 ? '' : 's') : '') + ' · ' + nMan + ' thing' + (nMan === 1 ? '' : 's') + ' to do by hand</span></p>';
    if (res.introduced.length) h += '<div class="rotate"><b>Heads up:</b> the re-scan found new findings after the patch (' + res.introduced.map(function (x) { return esc(x.id); }).join(', ') + '). Read the diff closely.</div>';
    if (res.rotateList.length) {
      var seen = {}, li = '';
      res.rotateList.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = 1; li += '<li><code>' + esc(x.id) + '</code> ' + esc(x.title) + '</li>'; } });
      h += '<div class="rotate"><b>Rotate leaked secrets first.</b> Deleting a secret from the files does not remove it from git history or from anyone who cloned the repo. Revoke each credential at its provider.<ul>' + li + '</ul></div>';
    }
    h += '<div class="actions">' +
      (res.patch ? '<button type="button" class="btn primary sm" id="b-patch">Download .patch</button><button type="button" class="btn ghost sm" id="b-apply">Copy git apply command</button>' : '') +
      '<button type="button" class="btn ghost sm" id="b-plan">Copy Rescue plan</button></div>';

    if (nFix) {
      h += '<div class="rblock"><h2>Patch: ' + nFix + ' suggested edit' + (nFix === 1 ? '' : 's') + '</h2><p class="sub">Line edits only. Secrets are masked on screen; the .patch file itself still contains the old line, so do not post it publicly.</p>';
      res.items.forEach(function (it) {
        h += '<details class="fx"' + (nFix <= 3 ? ' open' : '') + '><summary><span class="sev ' + esc(it.sev) + '">' + esc(it.sev) + '</span><span class="rid">' + esc(it.id) + '</span><span class="where">' + where(rep, it.isNew ? null : it.path, it.line) + (it.isNew ? esc(it.path) + ' (new file)' : '') + '</span>' + resTag(it) + '</summary><div class="body"><p>' + esc(it.explain) + '</p>' + (it.needsInput ? '<p class="need"><b>You still need to:</b> ' + esc(it.needsInput) + '</p>' : '') + (it.whole ? '' : '<pre class="diff">' + diffHtml(it, sec) + '</pre>') + '</div></details>';
      });
      h += '<details class="fx"><summary><span class="rid">Full patch preview</span><span class="where">secrets masked</span></summary><div class="body"><pre class="diff">' + patchHtml(res.display.patch) + '</pre></div></details></div>';
    }

    if (nMan) {
      h += '<div class="rblock"><h2>Do these by hand</h2><p class="sub">A patch cannot make these safely.</p>';
      res.manual.forEach(function (g) {
        h += '<details class="fx"><summary><span class="sev ' + esc(g.sev) + '">' + esc(g.sev) + '</span><span class="rid">' + esc(g.id) + '</span><span class="where">' + esc(g.title) + '</span><span class="res">' + g.locations.length + ' place' + (g.locations.length === 1 ? '' : 's') + '</span></summary><div class="body">' +
          (g.why ? '<p>' + esc(g.why) + '</p>' : '') + '<ul class="todo">' + g.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
          (g.note ? '<p class="need">' + esc(g.note) + '</p>' : '') +
          (g.locations.some(function (l) { return l.path; }) ? '<div class="locs">' + g.locations.filter(function (l) { return l.path; }).slice(0, 12).map(function (l) { return where(rep, l.path, l.line); }).join(' · ') + (g.locations.length > 12 ? ' · +' + (g.locations.length - 12) + ' more' : '') + '</div>' : '') +
          '</div></details>';
      });
      h += '</div>';
    }
    if (res.signals.length) {
      h += '<div class="rblock"><h2>Signals a patch cannot change</h2><p class="sub">Not defects by themselves. Check that each one is expected.</p><ul class="todo">' + res.signals.map(function (f) { return '<li><code>' + esc(f.id) + '</code> ' + esc(f.title) + (f.snippet ? ': ' + esc(RS.clean(f.snippet, 140)) : '') + '</li>'; }).join('') + '</ul></div>';
    }
    if (!nFix && !nMan && !res.signals.length) h += '<div class="rblock"><p class="empty">Nothing to fix. Pushy Score found no actionable findings here.</p></div>';
    h += '<div class="rblock"><h2>Rescue plan (Markdown)</h2><p class="sub">Paste it into an issue or a PR description. Paths are escaped and secrets never appear in it.</p><pre class="mdpre" id="planpre"></pre></div>';
    var cov = rep.coverage;
    h += '<p class="blind">Scanned ' + esc(cov.analyzed) + ' of ' + esc(cov.relevantTotal) + ' scannable files' + (cov.skippedCounted ? ' (' + esc(cov.skippedCounted) + ' not analyzed, so they get no patch)' : '') + ' · ruleset v' + esc(rep.ruleset.version) + ' · ' + esc(rep.stats ? rep.stats.apiCalls : '?') + ' API calls · <a href="../score/?repo=' + encodeURIComponent(name) + '">full Pushy Score report</a></p>';
    $('out').innerHTML = h;
    $('planpre').textContent = res.plan;
    if (res.patch) { $('b-patch').onclick = download; $('b-apply').onclick = function () { copy('git apply --check pushy-rescue.patch && git apply pushy-rescue.patch', 'Command copied'); }; }
    $('b-plan').onclick = function () { copy(res.plan, 'Rescue plan copied'); };
  }

  function download() {
    var b = new Blob([st.res.patch], { type: 'text/x-diff' }), a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = fname(st.rep); document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('Patch downloaded');
  }
  function copy(text, msg) {
    function fallback() { var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast(msg); } catch (e) { toast('Copy failed: select the text by hand'); } t.remove(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(msg); }, fallback); else fallback();
  }

  $('form').addEventListener('submit', function (e) { e.preventDefault(); run($('repo').value); });
  var q = new URLSearchParams(location.search).get('repo');
  if (q) { $('repo').value = q; run(q); }
})();
