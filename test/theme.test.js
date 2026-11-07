import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../lib/server.js';

const clientPath = fileURLToPath(new URL('../lib/client.html', import.meta.url));
const html = fs.readFileSync(clientPath, 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));

function lin(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

function contrast(a, b) {
  const L1 = luminance(a);
  const L2 = luminance(b);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

function parseHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

function parseColor(value) {
  const hex = value.match(/#([0-9a-fA-F]{6})/);
  if (hex) return parseHex('#' + hex[1]);
  const rgb = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (!rgb) throw new Error(`not a color: ${value}`);
  return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
}

function cssBlocks(source) {
  const blocks = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') depth--;
      j++;
    }
    const selector = source.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    blocks.push({ selector, body: source.slice(open + 1, j - 1) });
    i = j;
  }
  return blocks;
}

function varsIn(body) {
  const out = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[match[1]] = match[2].trim();
  return out;
}

const blocks = cssBlocks(css);
const lightVars = varsIn(blocks.find((b) => b.selector === ':root').body);
const darkBlock = blocks.find((b) => b.selector === ':root[data-theme="dark"]');
const darkVars = varsIn(darkBlock.body);
const media = blocks.find((b) => b.selector === '@media (prefers-color-scheme: dark)');
const mediaInner = cssBlocks(media.body).find((b) => b.selector === ':root:not([data-theme="light"])');
const mediaVars = varsIn(mediaInner.body);

function themeVars(mode) {
  return mode === 'dark' ? { ...lightVars, ...darkVars } : { ...lightVars };
}

function rgbOf(mode, name) {
  const value = themeVars(mode)[name];
  assert.ok(value, `${mode} is missing ${name}`);
  return parseHex(value);
}

const TEXT = [
  ['--text', '--bg'],
  ['--link', '--bg'],
  ['--code-text', '--code-bg'],
  ['--pre-text', '--pre-bg'],
  ['--quote', '--bg'],
  ['--text', '--table-head'],
  ['--link', '--table-head'],
  ['--source-text', '--source-bg'],
  ['--selection-text', '--selection'],
  ['--toolbar-text', '--toolbar-bg'],
  ['--toolbar-text', '--toolbar-btn'],
  ['--toolbar-text', '--toolbar-btn-hover'],
  ['--on-save', '--toolbar-save'],
  ['--on-save', '--toolbar-save-hover'],
  ['--toolbar-saved-text', '--toolbar-saved'],
];

const UI = [
  ['--rule', '--bg'],
  ['--rule', '--table-head'],
  ['--table-border', '--bg'],
  ['--table-border', '--table-head'],
  ['--quote-border', '--bg'],
  ['--pre-border', '--bg'],
  ['--focus', '--toolbar-bg'],
  ['--focus', '--toolbar-btn'],
];

test('dark tokens match the system-preference fallback', () => {
  assert.deepEqual(darkVars, mediaVars);
  assert.match(darkBlock.body, /color-scheme:\s*dark/);
  assert.match(mediaInner.body, /color-scheme:\s*dark/);
  assert.match(blocks.find((b) => b.selector === ':root').body, /color-scheme:\s*light/);
});

test('light and dark palettes meet WCAG contrast', () => {
  for (const mode of ['light', 'dark']) {
    for (const [fg, bg] of TEXT) {
      const ratio = contrast(rgbOf(mode, fg), rgbOf(mode, bg));
      assert.ok(ratio >= 4.5, `${mode} ${fg} on ${bg} is ${ratio.toFixed(2)}, need 4.5`);
    }
    for (const [fg, bg] of UI) {
      const ratio = contrast(rgbOf(mode, fg), rgbOf(mode, bg));
      assert.ok(ratio >= 3, `${mode} ${fg} on ${bg} is ${ratio.toFixed(2)}, need 3`);
    }
  }
  for (const [fg, bg] of [
    ['--code-border', '--bg'],
    ['--code-border', '--code-bg'],
    ['--toolbar-line', '--bg'],
    ['--toolbar-line', '--toolbar-bg'],
  ]) {
    const ratio = contrast(rgbOf('dark', fg), rgbOf('dark', bg));
    assert.ok(ratio >= 3, `dark ${fg} on ${bg} is ${ratio.toFixed(2)}, need 3`);
  }
});

test('the page offers a persistent theme control and no remote scripts', () => {
  assert.match(html, /id="theme-btn"/);
  assert.match(html, /localStorage\.getItem\('editdown-theme'\)/);
  assert.match(html, /localStorage\.setItem\('editdown-theme'/);
  assert.match(html, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(html, /data-theme-pref/);
  assert.match(css, /#wysiwyg a \{[^}]*text-decoration:\s*underline/);
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['/vendor/marked.js', '/vendor/turndown.js', '/vendor/turndown-gfm.js']);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
});

test('link tooltip colors stay readable on the dark popover', () => {
  const body = (selector) => blocks.find((b) => b.selector === selector).body;
  const tipBg = parseColor(body('#link-tooltip').match(/background:\s*([^;]+)/)[1]);
  const checks = [
    [body('#link-tooltip').match(/border:\s*([^;]+)/)[1], tipBg, 3],
    [body('#link-tooltip a.tt-display').match(/color:\s*([^;]+)/)[1], tipBg, 4.5],
    [body('#link-tooltip button').match(/color:\s*([^;]+)/)[1], tipBg, 4.5],
    [body('#link-tooltip .edit-btn').match(/color:\s*([^;]+)/)[1], tipBg, 4.5],
    [body('#link-tooltip .remove-btn').match(/color:\s*([^;]+)/)[1], tipBg, 4.5],
    [body('#link-tooltip .sep').match(/color:\s*([^;]+)/)[1], tipBg, 3],
  ];
  for (const [fg, bg, min] of checks) {
    const ratio = contrast(parseColor(fg), bg);
    assert.ok(ratio >= min, `${fg} on tooltip is ${ratio.toFixed(2)}, need ${min}`);
  }
  const input = body('#link-tooltip .tt-edit-row input');
  const inputBg = parseColor(input.match(/background:\s*([^;]+)/)[1]);
  const inputFg = parseColor(input.match(/color:\s*([^;]+)/)[1]);
  const inputBorder = parseColor(input.match(/border:\s*([^;]+)/)[1]);
  assert.ok(contrast(inputFg, inputBg) >= 4.5);
  assert.ok(contrast(inputBorder, inputBg) >= 3);
});

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const SAMPLE = `# Theme sample

A paragraph with a [readable link](https://example.com/docs) and \`inline code\`.

## Second

> A blockquote that should stay readable.

| Name | Role |
| --- | --- |
| Ada | Editor |

\`\`\`
const theme = "dark";
\`\`\`

![swatch](swatch.svg)
`;

let dir;
let mdFile;
let server;
let base;
let chrome;
let chromeStderr = '';
let cdp;
let shots;

function shot(name, png) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, name), png);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editdown-theme-'));
  mdFile = path.join(dir, 'sample.md');
  fs.writeFileSync(mdFile, SAMPLE);
  fs.writeFileSync(
    path.join(dir, 'swatch.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64">
      <rect width="240" height="64" rx="6" fill="#9b2335"/>
      <text x="16" y="40" fill="#ffffff" font-size="20" font-family="sans-serif">relative asset</text>
    </svg>`,
  );
  server = createServer(mdFile);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  shots = process.env.EDITDOWN_SHOTS || '';

  const chromePath = findChrome();
  if (!chromePath) return;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'editdown-chrome-'));
  chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', (chunk) => { chromeStderr += chunk; });
  const started = Date.now();
  let version;
  while (Date.now() - started < 8000) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* chrome still booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!version) throw new Error(`chrome did not open a debugger\n${chromeStderr}`);
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find((entry) => entry.type === 'page');
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
});

after(() => {
  server?.close();
  chrome?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function connectCdp(url) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const waiters = [];
  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails?.text || 'exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push('console error');
    }
    for (const waiter of [...waiters]) {
      if (waiter.method === message.method) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({
      consoleErrors,
      send(method, params = {}) {
        const id = ++nextId;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      waitFor(method, timeout = 5000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeout);
          waiters.push({
            method,
            resolve: (msg) => { clearTimeout(timer); res(msg); },
          });
        });
      },
    }));
    ws.addEventListener('error', () => reject(new Error('devtools websocket failed')));
  });
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
  }
  return result.result.value;
}

async function gotoTheme(scheme) {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  const loaded = cdp.waitFor('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `${base}/` });
  await loaded;
  await evaluate(`new Promise((resolve, reject) => {
    const ready = () => document.querySelector('#wysiwyg h1');
    if (ready()) return resolve(true);
    const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => reject(new Error('editor did not render')), 5000);
  })`);
}

async function sample() {
  return evaluate(`(() => {
    const cs = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
    const img = document.querySelector('#wysiwyg img');
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      pref: document.documentElement.getAttribute('data-theme-pref'),
      label: document.getElementById('theme-btn').textContent,
      bg: cs('.editor-wrap', 'backgroundColor'),
      text: cs('#wysiwyg', 'color'),
      link: cs('#wysiwyg a', 'color'),
      linkDecoration: cs('#wysiwyg a', 'textDecorationLine'),
      codeBg: cs('#wysiwyg p code', 'backgroundColor'),
      codeText: cs('#wysiwyg p code', 'color'),
      codeBorder: cs('#wysiwyg p code', 'borderTopColor'),
      preBg: cs('#wysiwyg pre code', 'backgroundColor'),
      preText: cs('#wysiwyg pre code', 'color'),
      preBorder: cs('#wysiwyg pre code', 'borderTopColor'),
      quote: cs('#wysiwyg blockquote', 'color'),
      quoteBorder: cs('#wysiwyg blockquote', 'borderLeftColor'),
      thBg: cs('#wysiwyg th', 'backgroundColor'),
      thText: cs('#wysiwyg th', 'color'),
      tdBorder: cs('#wysiwyg td', 'borderTopColor'),
      sourceBg: cs('#source', 'backgroundColor'),
      sourceText: cs('#source', 'color'),
      toolbarBg: cs('.toolbar', 'backgroundColor'),
      toolbarText: cs('.toolbar h3', 'color'),
      saveBg: cs('#save-btn', 'backgroundColor'),
      saveText: cs('#save-btn', 'color'),
      themeBg: cs('#theme-btn', 'backgroundColor'),
      themeText: cs('#theme-btn', 'color'),
      toolbarLine: cs('.toolbar', 'borderBottomColor'),
      img: img ? img.naturalWidth : 0,
      status: document.getElementById('status').textContent,
      mode: document.getElementById('mode-btn').textContent,
    };
  })()`);
}

function assertReadable(mode, view) {
  const pairs = [
    ['text', view.text, view.bg, 4.5],
    ['link', view.link, view.bg, 4.5],
    ['code', view.codeText, view.codeBg, 4.5],
    ['pre', view.preText, view.preBg, 4.5],
    ['quote', view.quote, view.bg, 4.5],
    ['th', view.thText, view.thBg, 4.5],
    ['source', view.sourceText, view.sourceBg, 4.5],
    ['toolbar', view.toolbarText, view.toolbarBg, 4.5],
    ['save', view.saveText, view.saveBg, 4.5],
    ['theme button', view.themeText, view.themeBg, 4.5],
    ['rule', view.tdBorder, view.bg, 3],
    ['quote bar', view.quoteBorder, view.bg, 3],
    ['pre edge', view.preBorder, view.bg, 3],
  ];
  if (mode === 'dark') {
    pairs.push(['code edge', view.codeBorder, view.bg, 3]);
    pairs.push(['toolbar line', view.toolbarLine, view.toolbarBg, 3]);
    pairs.push(['toolbar line on page', view.toolbarLine, view.bg, 3]);
  }
  for (const [name, fg, bg, min] of pairs) {
    const ratio = contrast(parseColor(fg), parseColor(bg));
    assert.ok(ratio >= min, `${mode} ${name} ${fg} on ${bg} is ${ratio.toFixed(2)}, need ${min}`);
  }
  assert.equal(view.linkDecoration, 'underline');
}

async function screenshot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  shot(name, Buffer.from(data, 'base64'));
}

test('browser follows the system, remembers an explicit theme, and still edits', { timeout: 40000 }, async (t) => {
  if (!cdp) {
    t.skip('Chrome is not installed');
    return;
  }
  await gotoTheme('dark');
  await evaluate(`localStorage.removeItem('editdown-theme')`);
  await gotoTheme('dark');
  let view = await sample();
  assert.equal(view.theme, 'dark');
  assert.equal(view.pref, 'auto');
  assert.equal(view.label, 'Theme: Auto');
  assert.ok(view.img >= 200, `relative image did not load (${view.img})`);
  assertReadable('dark', view);
  await screenshot('dark-rich.png');

  await evaluate(`cycleTheme()`);
  view = await sample();
  assert.equal(view.pref, 'light');
  assert.equal(view.theme, 'light');
  assert.equal(view.label, 'Theme: Light');
  assert.equal(view.status, '');
  assert.equal(await evaluate(`localStorage.getItem('editdown-theme')`), 'light');
  assertReadable('light', view);
  await screenshot('light-rich-override.png');

  await gotoTheme('dark');
  view = await sample();
  assert.equal(view.pref, 'light', 'explicit light should survive reload on a dark system');
  assert.equal(view.theme, 'light');

  await evaluate(`cycleTheme()`);
  assert.equal((await sample()).theme, 'dark');
  await evaluate(`document.getElementById('mode-btn').click()`);
  view = await sample();
  assert.equal(view.mode, 'Rich Edit');
  assertReadable('dark', view);
  await screenshot('dark-source.png');
  await evaluate(`document.getElementById('mode-btn').click()`);
  await evaluate(`cycleTheme()`);
  assert.equal((await sample()).pref, 'auto');

  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await evaluate(`new Promise((r) => setTimeout(r, 50))`);
  view = await sample();
  assert.equal(view.pref, 'auto');
  assert.equal(view.theme, 'light');
  assertReadable('light', view);
  await evaluate(`document.getElementById('mode-btn').click()`);
  await screenshot('light-source.png');
  await evaluate(`document.getElementById('mode-btn').click()`);
  await screenshot('light-rich.png');

  await evaluate(`(() => {
    document.querySelector('#wysiwyg h1').textContent = 'Edited heading';
    document.querySelector('#wysiwyg').dispatchEvent(new Event('input', { bubbles: true }));
    save();
  })()`);
  const savedAt = Date.now();
  while (!fs.readFileSync(mdFile, 'utf8').includes('Edited heading')) {
    if (Date.now() - savedAt > 4000) throw new Error('save did not reach disk');
    await new Promise((r) => setTimeout(r, 50));
  }
  const saved = fs.readFileSync(mdFile, 'utf8');
  assert.match(saved, /^# Edited heading\n/);
  assert.match(saved, /readable link/);
  assert.match(saved, /swatch\.svg/);
  await evaluate(`new Promise((resolve) => {
    const done = () => document.getElementById('status').textContent.startsWith('Saved');
    if (done()) resolve(true);
    else new MutationObserver(() => { if (done()) resolve(true); }).observe(document.getElementById('status'), { childList: true, characterData: true, subtree: true });
  })`);

  const reloadedAt = new Date(Date.now() + 5000);
  fs.writeFileSync(mdFile, '# Reloaded heading\n\nPicked up from disk.\n');
  fs.utimesSync(mdFile, reloadedAt, reloadedAt);
  const sawReload = Date.now();
  let heading = '';
  while (!heading.includes('Reloaded heading')) {
    if (Date.now() - sawReload > 4000) throw new Error(`reload did not render, heading is ${JSON.stringify(heading)}`);
    heading = await evaluate(`document.querySelector('#wysiwyg h1') ? document.querySelector('#wysiwyg h1').textContent : ''`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await evaluate(`document.getElementById('status').textContent`), 'Reloaded from disk');
  await screenshot('reloaded.png');
  assert.deepEqual(cdp.consoleErrors, []);
});
