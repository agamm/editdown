import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../lib/server.js';

let dir, mdFile, server, base;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdedit-test-'));
  mdFile = path.join(dir, 'doc.md');
  fs.writeFileSync(mdFile, '# Hello\n');
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from('89504e47', 'hex'));
  fs.writeFileSync(path.join(os.tmpdir(), 'mdedit-outside-secret.txt'), 'do not serve me');

  server = createServer(mdFile);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'mdedit-outside-secret.txt'), { force: true });
});

test('GET /api/load returns the file contents', async () => {
  const res = await fetch(`${base}/api/load`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '# Hello\n');
});

test('POST /api/save writes the file to disk', async () => {
  const res = await fetch(`${base}/api/save`, { method: 'POST', body: '# Changed\n\nnew body\n' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(fs.readFileSync(mdFile, 'utf8'), '# Changed\n\nnew body\n');
});

test('POST /api/save reports the post-write mtime, so the client can skip its own edit', async () => {
  const before = (await (await fetch(`${base}/api/mtime`)).json()).mtime;
  const saved = await (await fetch(`${base}/api/save`, { method: 'POST', body: 'later\n' })).json();
  assert.ok(saved.mtime >= before, `save mtime ${saved.mtime} should not predate ${before}`);
  const now = (await (await fetch(`${base}/api/mtime`)).json()).mtime;
  assert.equal(saved.mtime, now);
});

test('a save that leaves no temp file behind', async () => {
  await fetch(`${base}/api/save`, { method: 'POST', body: 'clean\n' });
  const strays = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(strays, []);
});

test('assets next to the document are served', async () => {
  const res = await fetch(`${base}/pic.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('traversal outside the document directory is refused', async () => {
  for (const attack of ['/../mdedit-outside-secret.txt', '/%2e%2e/mdedit-outside-secret.txt']) {
    const res = await fetch(`${base}${attack}`, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `${attack} returned ${res.status}`);
    assert.ok(!(await res.text()).includes('do not serve me'), `${attack} leaked the file`);
  }
});

test('unknown api routes 404 rather than falling through to the asset handler', async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});

// A dependency bump that renames or drops a browser bundle would otherwise only
// show up as a blank editor in someone else's terminal.
test('every vendored browser bundle is served and defines its global', async () => {
  const expected = {
    '/vendor/marked.js': 'marked',
    '/vendor/turndown.js': 'TurndownService',
    '/vendor/turndown-gfm.js': 'turndownPluginGfm',
  };
  for (const [route, globalName] of Object.entries(expected)) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 200, `${route} did not serve`);
    const body = await res.text();
    assert.ok(body.length > 1000, `${route} looks empty`);
    assert.ok(body.includes(globalName), `${route} never mentions ${globalName}`);
  }
});

test('the page loads each vendored bundle', async () => {
  const html = await (await fetch(`${base}/`)).text();
  for (const route of ['/vendor/marked.js', '/vendor/turndown.js', '/vendor/turndown-gfm.js']) {
    assert.ok(html.includes(`src="${route}"`), `page does not load ${route}`);
  }
});
