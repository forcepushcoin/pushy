'use strict';

var MARKER = require('./comment.js').MARKER;

function authHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pushy-action'
  };
}

async function gh(token, method, url, body) {
  var res = await fetch(url, {
    method: method,
    headers: authHeaders(token),
    body: body ? JSON.stringify(body) : undefined
  });
  var text = await res.text();
  var parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch (e) { parsed = { message: text }; } }
  if (!res.ok) {
    var msg = (parsed && parsed.message) || ('HTTP ' + res.status);
    var err = new Error('GitHub API ' + method + ' ' + res.status + ': ' + msg);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

function findSticky(comments, marker) {
  marker = marker || MARKER;
  var list = comments || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && typeof list[i].body === 'string' && list[i].body.indexOf(marker) !== -1) return list[i];
  }
  return null;
}

async function listComments(token, owner, repo, number) {
  var all = [];
  for (var page = 1; page <= 5; page++) {
    var batch = await gh(token, 'GET', 'https://api.github.com/repos/' + owner + '/' + repo + '/issues/' + number + '/comments?per_page=100&page=' + page);
    if (!Array.isArray(batch) || !batch.length) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function listPullFiles(token, owner, repo, number) {
  var names = [];
  for (var page = 1; page <= 5; page++) {
    var batch = await gh(token, 'GET', 'https://api.github.com/repos/' + owner + '/' + repo + '/pulls/' + number + '/files?per_page=100&page=' + page);
    if (!Array.isArray(batch) || !batch.length) break;
    batch.forEach(function (f) { if (f && f.filename) names.push(f.filename); });
    if (batch.length < 100) break;
  }
  return names;
}

async function upsertComment(token, owner, repo, number, body) {
  var existing = findSticky(await listComments(token, owner, repo, number));
  if (existing) {
    return gh(token, 'PATCH', 'https://api.github.com/repos/' + owner + '/' + repo + '/issues/comments/' + existing.id, { body: body });
  }
  return gh(token, 'POST', 'https://api.github.com/repos/' + owner + '/' + repo + '/issues/' + number + '/comments', { body: body });
}

module.exports = { gh: gh, findSticky: findSticky, listComments: listComments, listPullFiles: listPullFiles, upsertComment: upsertComment };
