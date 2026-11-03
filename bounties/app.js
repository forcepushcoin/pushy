/* Pushy Bounty board — UI glue. Issue text is escaped before it touches innerHTML; links always point at github.com/forcepushcoin/pushy. */
(function () {
  'use strict';
  var B = window.PushyBounties;
  /* Maintainers: set BOUNTY_WALLET to the public Solana address of the pool once it exists (announced at launch).
     While it is empty the page says "announced at launch". Never put a private key or seed phrase here. */
  var CONFIG = { BOUNTY_WALLET: '' };
  var CACHE_MIN = 10;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function show(id) { ['progress', 'error', 'result'].forEach(function (x) { $(x).hidden = (x !== id); }); }
  var running = false;

  /* ---- pool wallet ---- */
  (function pool() {
    var w = CONFIG.BOUNTY_WALLET, ok = B.validWallet(w);
    $('pool').innerHTML = '<div><span class="k">Pool wallet</span>' + (ok
      ? '<span class="v">' + esc(w) + ' · <a href="' + esc(B.solscanUrl(w)) + '" target="_blank" rel="noopener noreferrer">Solscan</a></span>'
      : '<span class="v soon">announced at launch</span>') + '</div>' +
      '<p class="note">' + (ok ? 'Public pool wallet. Amounts are set per bounty by the maintainers.' : 'Nothing is payable until the wallet is published here and on the official X account.') + '</p>';
  })();

  /* ---- cache ---- */
  var KEY = 'pushy-bounties:' + B.VERSION.split('.')[0] + ':' + B.REPO;
  function cget() { try { var v = JSON.parse(localStorage.getItem(KEY)); if (v && v.data && Date.now() - v.t < CACHE_MIN * 60000) return v; } catch (e) {} return null; }
  function cset(data) { try { localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), data: data })); } catch (e) {} }

  /* ---- errors ---- */
  function showError(e) {
    var code = e && e.code, title = 'Could not load the board', body = esc((e && e.message) || 'Unknown error'), tips = [];
    if (code === 'RATE_LIMIT') {
      var when = e.reset ? new Date(e.reset) : null;
      title = 'GitHub says: slow down 🐹';
      body += (when ? ' It resets around <b>' + esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</b>.' : '');
      tips = ['Wait for the reset and try again.', 'Or add a GitHub token (no scopes needed) under "Hit GitHub\'s rate limit?" above.', 'You can always read the list on GitHub: github.com/forcepushcoin/pushy/issues?q=label%3Abounty'];
      document.querySelector('details.tok').open = true;
    } else if (code === 'NETWORK') { title = 'Can\'t reach GitHub'; }
    $('errbox').innerHTML = '<div class="errbox"><h3>' + esc(title) + '</h3><p>' + body + '</p>' + (tips.length ? '<ul>' + tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    show('error');
  }

  /* ---- render ---- */
  function ago(iso) {
    var t = Date.parse(iso); if (!t) return '';
    var d = Math.max(0, Math.floor((Date.now() - t) / 86400000));
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  }
  var STATUS_TXT = { open: 'open', claimed: 'claimed', paid: 'paid', proposed: 'proposed', closed: 'closed' };
  function row(it) {
    var rw = '';
    if (it.reward && !it.reward.tbd) rw = '<div class="rw">' + esc(it.reward.text) + '<small>' + (it.reward.confirmed ? 'confirmed by label' : 'as written by author') + '</small></div>';
    else rw = '<div class="rw tbd">TBD</div>';
    return '<div class="brow"><span class="st2 ' + esc(it.status) + '">' + esc(STATUS_TXT[it.status] || it.status) + '</span>' +
      '<div class="t"><a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer"><span class="n">#' + esc(it.number) + '</span>' + esc(it.title) + '</a></div>' + rw +
      '<div class="m">' + (it.author ? '<span>by ' + esc(it.author) + '</span>' : '') + '<span>' + (it.state === 'closed' ? 'closed ' + esc(ago(it.closedAt)) : 'opened ' + esc(ago(it.createdAt))) + '</span>' +
      (it.comments ? '<span>' + esc(it.comments) + ' comment' + (it.comments === 1 ? '' : 's') + '</span>' : '') + it.labels.map(function (l) { return '<span class="lbl">' + esc(l) + '</span>'; }).join('') + '</div></div>';
  }
  function render(d, cachedAt) {
    var h = '', nOpen = d.open.length, nClosed = d.closed.length;
    if (!nOpen) {
      h += '<div class="emptyb"><h3>No open bounties yet</h3><p>Nothing is labelled <code>bounty</code> and open right now. Be the first: open a bounty issue, or read the rules.</p><div class="actions">' +
        '<a class="btn primary sm" href="https://github.com/forcepushcoin/pushy/issues/new?template=bounty.yml" target="_blank" rel="noopener noreferrer">Open the bounty template</a>' +
        '<a class="btn ghost sm" href="https://github.com/forcepushcoin/pushy/blob/main/BOUNTIES.md" target="_blank" rel="noopener noreferrer">Read BOUNTIES.md</a></div></div>';
    } else {
      h += '<div class="bgroup" style="margin-top:0"><h2>Open <small>' + nOpen + '</small></h2>' + d.open.map(row).join('') + '</div>';
    }
    if (nClosed) h += '<div class="bgroup"><h2>Recently closed <small>' + nClosed + ' in the last ' + B.CLOSED_DAYS + ' days</small></h2>' + d.closed.map(row).join('') + '</div>';
    h += '<p class="runmeta">Read from <a href="https://github.com/' + esc(B.REPO) + '/issues?q=label%3Abounty" target="_blank" rel="noopener noreferrer">' + esc(B.REPO) + ' issues labelled bounty</a>' + (d.capped ? ' (latest ' + 100 + ' shown)' : '') + ' · ' + (cachedAt ? 'cached ' + Math.max(0, Math.round((Date.now() - cachedAt) / 60000)) + ' min ago, 0 API calls' : '1 API call') + (d.rate && d.rate.remaining != null ? ' · GitHub API budget left: ' + esc(d.rate.remaining) + '/' + esc(d.rate.limit) : '') + '</p>';
    $('out').innerHTML = h; show('result');
  }

  async function load(force) {
    if (running) return;
    running = true; $('refresh').disabled = true;
    try {
      var c = !force && cget();
      if (c) { render(c.data, c.t); }
      else {
        show('progress');
        var d = await B.fetchBounties({ token: ($('token').value || '').trim() || null });
        cset(d); render(d, 0);
      }
    } catch (e) { showError(e); }
    finally { running = false; $('refresh').disabled = false; }
  }
  $('refresh').addEventListener('click', function () { load(true); });
  load(false);
})();
