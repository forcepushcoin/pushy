'use strict';

var rules = require('../score/rules.js');

var MARKER = '<!-- pushy-score -->';
var FOOTER = 'Automated scan, not an audit · Pushy needs no token';

function cell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/</g, '&lt;').trim();
}

function findingUrl(owner, repo, sha, filePath, line) {
  if (!owner || !repo || !sha || !filePath) return null;
  var enc = String(filePath).split('/').map(encodeURIComponent).join('/');
  return 'https://github.com/' + owner + '/' + repo + '/blob/' + sha + '/' + enc + (line ? '#L' + line : '');
}

function isChanged(filePath, changed) {
  if (!filePath || !changed) return false;
  var list = Array.isArray(changed) ? changed : Array.from(changed);
  for (var i = 0; i < list.length; i++) {
    var c = String(list[i]).replace(/^\.\//, '');
    if (c === filePath || c.endsWith('/' + filePath)) return true;
  }
  return false;
}

function renderComment(report, opts) {
  opts = opts || {};
  var owner = opts.owner || (report.repo && report.repo.owner) || '';
  var repo = opts.repo || (report.repo && report.repo.name) || '';
  var sha = opts.sha || report.sha || '';
  var changed = opts.changed || null;
  var band = report.band || { key: 'gray', label: 'No band', line: '' };
  var lines = [];
  lines.push(MARKER);
  lines.push('## 🐹 ' + report.score + '/100 · ' + band.label);
  lines.push('');
  lines.push(band.line || '');
  lines.push('');
  lines.push('Ruleset `v' + report.ruleset.version + '` · commit `' + (report.shortSha || sha || 'local') + '`');
  var cov = report.coverage || {};
  lines.push('');
  lines.push('Read **' + (cov.analyzed || 0) + '** of **' + (cov.relevantTotal || 0) + '** scannable files (budget ' + ((cov.budget && cov.budget.files) || 400) + ' files / 15 MB).');
  lines.push('');
  lines.push('| Category | Score |');
  lines.push('| --- | --- |');
  Object.keys(rules.CATEGORIES).forEach(function (key) {
    var sub = report.sub && report.sub[key];
    lines.push('| ' + rules.CATEGORIES[key].name + ' | ' + (sub ? sub.score : 0) + ' / 100 |');
  });
  lines.push('');
  lines.push('### Findings');
  lines.push('');
  var findings = report.findings || [];
  var shown = findings.slice(0, opts.maxFindings || 40);
  var anyNew = shown.some(function (f) { return isChanged(f.path, changed); });
  if (!findings.length) {
    lines.push('No rule fired. That means none of the rules matched. It does not mean the tree is safe. Read the blind spots.');
  } else {
    if (anyNew) lines.push('| Severity | Rule | Where | Fix |');
    else lines.push('| Severity | Rule | Where | Fix |');
    lines.push('| --- | --- | --- | --- |');
    shown.forEach(function (f) {
      var where = f.path ? (f.path + (f.line ? ':' + f.line : '')) : 'repository';
      var href = f.url || findingUrl(owner, repo, sha, f.path, f.line);
      var whereCell = href ? '[`' + cell(where) + '`](' + href + ')' : '`' + cell(where) + '`';
      var sev = cell(f.sev);
      if (isChanged(f.path, changed)) sev += ' 🆕';
      var fix = cell(f.fix || '');
      if (fix.length > 180) fix = fix.slice(0, 177) + '…';
      lines.push('| ' + sev + ' | `' + cell(f.id) + '` | ' + whereCell + ' | ' + fix + ' |');
    });
    if (findings.length > shown.length) lines.push('');
    if (findings.length > shown.length) lines.push('_' + (findings.length - shown.length) + ' more findings are in the JSON report._');
    if (anyNew) {
      lines.push('');
      lines.push('🆕 is a finding in a file this pull request changes.');
    }
  }
  if (report.greenFlags && report.greenFlags.length) {
    lines.push('');
    lines.push('### What looked good');
    lines.push('');
    report.greenFlags.forEach(function (g) { lines.push('- ' + g); });
  }
  lines.push('');
  lines.push('### Blind spots');
  lines.push('');
  lines.push('Pattern matching on text. A high score means no rule fired.');
  (report.blindSpots || []).forEach(function (b) { lines.push('- ' + b); });
  if (report.capped && report.caps && report.caps.length) {
    lines.push('');
    lines.push('Score capped at ' + report.score + ' (raw ' + report.rawScore + ').');
  }
  lines.push('');
  lines.push(FOOTER);
  lines.push('');
  var body = lines.join('\n');
  if (body.length > 60000) body = body.slice(0, 59000) + '\n\n_Comment truncated._\n\n' + FOOTER + '\n';
  return body;
}

function renderSummary(report) {
  var band = report.band || {};
  var lines = [];
  lines.push('## 🐹 Pushy Score ' + report.score + '/100');
  lines.push('');
  lines.push('**' + (band.label || band.key || '') + '**');
  lines.push('');
  lines.push(band.line || '');
  lines.push('');
  lines.push('| Category | Score |');
  lines.push('| --- | --- |');
  Object.keys(rules.CATEGORIES).forEach(function (key) {
    var sub = report.sub && report.sub[key];
    lines.push('| ' + rules.CATEGORIES[key].name + ' | ' + (sub ? sub.score : 0) + ' / 100 |');
  });
  lines.push('');
  lines.push((report.findings || []).length + ' finding(s). ' + FOOTER);
  lines.push('');
  return lines.join('\n');
}

module.exports = { MARKER: MARKER, FOOTER: FOOTER, renderComment: renderComment, renderSummary: renderSummary, isChanged: isChanged };
