/* Pushy Roast — 1200x630 share card on <canvas>. All text goes through fillText (never HTML), so repo-derived strings cannot inject markup. */
(function (root) {
  'use strict';
  var W = 1200, H = 630;
  var MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  var SANS = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  var ART = [
    '     ,--.     ,--.   ',
    '    ( () )---( () )  ',
    '     `--\'.---.`--\'   ',
    '    .\'  /     \\  `.  ',
    '   /   |  o o  |   \\ ',
    '  |    |   ^   |    |',
    '  |-.   \\ \\_/ /   .-|',
    '  |  `-._`---\'_.-\'  |',
    '   \\  .-\'     `-.  / ',
    '    `/  / | | \\  \\\'   ',
    '     (_/ (_) (_) \\_) '
  ];

  var THEMES = {
    terminal: { name: 'Terminal green', bg: '#020b05', panel: '#04140a', border: '#12532f', fg: '#c8ffd9', muted: '#4fae79', accent: '#4cff8f', art: '#4cff8f', glow: true, scan: true, tile: '#04160b' },
    github: { name: 'GitHub dark', bg: '#0d1117', panel: '#161b22', border: '#30363d', fg: '#e6edf3', muted: '#8b949e', accent: '#ff5c5c', art: '#6ee7a0', glow: false, scan: false, tile: '#161b22' },
    hazard: { name: 'Hazard', bg: '#0e0e0e', panel: '#181818', border: '#ffc857', fg: '#ffffff', muted: '#b5a67a', accent: '#ffc857', art: '#ffc857', glow: false, scan: false, tile: '#1b1b1b', stripes: true }
  };

  function safe(s, max) { s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim(); return max && s.length > max ? s.slice(0, max - 1) + '…' : s; }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function fit(ctx, text, font, maxW, size, minSize) { // shrink font until it fits, else ellipsize
    var s = size; for (; s >= minSize; s -= 2) { ctx.font = font(s); if (ctx.measureText(text).width <= maxW) return { text: text, size: s }; }
    ctx.font = font(minSize); var t = text; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return { text: t + '…', size: minSize };
  }
  function wrap(ctx, text, maxW, maxLines) {
    var words = text.split(' '), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = words[i]; }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); var l = lines[maxLines - 1]; while (l.length > 1 && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1); lines[maxLines - 1] = l + '…'; }
    return lines;
  }

  function draw(canvas, o) {
    var T = THEMES[o.theme] || THEMES.terminal, ctx = canvas.getContext('2d');
    canvas.width = W; canvas.height = H;
    ctx.textBaseline = 'alphabetic';
    // background
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    if (T.stripes) {
      [0, H - 22].forEach(function (y) {
        ctx.save(); ctx.beginPath(); ctx.rect(0, y, W, 22); ctx.clip();
        ctx.fillStyle = '#ffc857'; ctx.fillRect(0, y, W, 22); ctx.fillStyle = '#0e0e0e';
        for (var x = -40; x < W + 40; x += 44) { ctx.beginPath(); ctx.moveTo(x, y + 22); ctx.lineTo(x + 22, y + 22); ctx.lineTo(x + 44, y); ctx.lineTo(x + 22, y); ctx.closePath(); ctx.fill(); }
        ctx.restore();
      });
    } else {
      var g = ctx.createRadialGradient(W * 0.85, 0, 40, W * 0.85, 0, 700); g.addColorStop(0, T.glow ? 'rgba(76,255,143,.10)' : 'rgba(224,36,36,.16)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = T.border; ctx.lineWidth = 2; rr(ctx, 14, 14, W - 28, H - 28, 18); ctx.stroke();
    }
    var top = T.stripes ? 46 : 36, bot = T.stripes ? H - 46 : H - 36;
    // left panel with ASCII Pushy
    var px = 48, pw = 372;
    ctx.fillStyle = T.panel; rr(ctx, px, top + 12, pw, bot - top - 24, 16); ctx.fill();
    ctx.strokeStyle = T.border; ctx.lineWidth = 2; rr(ctx, px, top + 12, pw, bot - top - 24, 16); ctx.stroke();
    ctx.font = '700 21px ' + MONO; var cw = ctx.measureText('M').width, lh = 27;
    var aw = ART[0].length * cw, ax = px + (pw - aw) / 2, ay = top + 12 + 104;
    ctx.fillStyle = T.art; if (T.glow) { ctx.shadowColor = T.art; ctx.shadowBlur = 10; }
    ART.forEach(function (ln, i) { ctx.fillText(ln, ax, ay + i * lh); });
    ctx.shadowBlur = 0;
    ctx.font = '700 22px ' + MONO; ctx.fillStyle = T.accent; ctx.textAlign = 'center';
    ctx.fillText('PUSHY', px + pw / 2, ay + ART.length * lh + 34);
    ctx.font = '500 15px ' + MONO; ctx.fillStyle = T.muted;
    ctx.fillText('Commit Roast Card', px + pw / 2, ay + ART.length * lh + 58);
    ctx.textAlign = 'left';
    // right column
    var x0 = 456, rw = W - x0 - 52;
    ctx.font = '600 18px ' + MONO; ctx.fillStyle = T.muted; ctx.fillText('$FORCEPUSH  //  COMMIT ROAST', x0, top + 40);
    var rn = fit(ctx, safe(o.repo, 80), function (s) { return '700 ' + s + 'px ' + MONO; }, rw, 40, 22);
    ctx.font = '700 ' + rn.size + 'px ' + MONO; ctx.fillStyle = T.fg; ctx.fillText(rn.text, x0, top + 92);
    var at = fit(ctx, safe(o.title, 40), function (s) { return '800 ' + s + 'px ' + SANS; }, rw, 58, 34);
    ctx.font = '800 ' + at.size + 'px ' + SANS; ctx.fillStyle = T.accent; if (T.glow) { ctx.shadowColor = T.accent; ctx.shadowBlur = 12; }
    ctx.fillText(at.text, x0, top + 160); ctx.shadowBlur = 0;
    // stat tiles
    var tiles = (o.tiles || []).slice(0, 4), gap = 14, tw = (rw - gap * 3) / 4, ty = top + 192, th = 104;
    tiles.forEach(function (t, i) {
      var tx = x0 + i * (tw + gap);
      ctx.fillStyle = T.tile; rr(ctx, tx, ty, tw, th, 12); ctx.fill(); ctx.strokeStyle = T.border; ctx.lineWidth = 2; rr(ctx, tx, ty, tw, th, 12); ctx.stroke();
      var v = fit(ctx, safe(t.value, 8), function (s) { return '700 ' + s + 'px ' + MONO; }, tw - 24, 38, 20);
      ctx.font = '700 ' + v.size + 'px ' + MONO; ctx.fillStyle = T.fg; ctx.fillText(v.text, tx + 14, ty + 46);
      ctx.font = '500 14px ' + SANS; ctx.fillStyle = T.muted;
      wrap(ctx, safe(t.label, 40), tw - 24, 2).forEach(function (ln, j) { ctx.fillText(ln, tx + 14, ty + 70 + j * 18); });
    });
    // roast line
    var qy = ty + th + 52;
    ctx.fillStyle = T.accent; ctx.font = '800 54px ' + SANS; ctx.fillText('\u201C', x0 - 4, qy + 14);
    ctx.font = '600 31px ' + SANS; ctx.fillStyle = T.fg;
    var lines = wrap(ctx, safe(o.line, 170), rw - 40, 3);
    lines.forEach(function (ln, i) { ctx.fillText(ln, x0 + 34, qy + 4 + i * 42); });
    // footer
    ctx.font = '700 22px ' + MONO; ctx.fillStyle = T.accent; ctx.fillText('forcepushcoin.github.io/roast', x0, bot - 34);
    ctx.font = '500 15px ' + SANS; ctx.fillStyle = T.muted; ctx.fillText('Just for fun. Not a code review. $FORCEPUSH is a meme coin, NFA.', x0, bot - 10);
    if (T.scan) { ctx.fillStyle = 'rgba(0,0,0,.18)'; for (var y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2); }
    return canvas;
  }

  function ready() { // make sure the web fonts are loaded before drawing (with a timeout so a blocked font CDN never hangs us)
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var loads = Promise.all([document.fonts.load('700 20px "JetBrains Mono"'), document.fonts.load('500 20px "JetBrains Mono"'), document.fonts.load('800 20px "Inter"'), document.fonts.load('600 20px "Inter"'), document.fonts.load('500 14px "Inter"')]);
    return Promise.race([loads, new Promise(function (r) { setTimeout(r, 2500); })]).catch(function () {});
  }

  root.PushyCard = { W: W, H: H, THEMES: THEMES, ART: ART, draw: draw, ready: ready, safe: safe };
})(window);
