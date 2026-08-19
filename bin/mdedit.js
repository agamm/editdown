#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from '../lib/server.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const USAGE = `mdedit ${version} - edit a markdown file in your browser, save back to disk

Usage:
  mdedit [file.md] [options]

Arguments:
  file.md            the file to edit (defaults to README.md in the current directory)

Options:
  -p, --port <n>     port to listen on (default: 8432, next free port if taken)
      --no-open      do not open a browser
  -h, --help         show this message
  -v, --version      print the version
`;

function fail(msg) {
  console.error(`mdedit: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { file: null, port: 8432, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
    else if (arg === '-v' || arg === '--version') { console.log(version); process.exit(0); }
    else if (arg === '--no-open') opts.open = false;
    else if (arg === '-p' || arg === '--port') {
      const port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port: ${argv[i]}`);
      opts.port = port;
    } else if (arg.startsWith('-')) fail(`unknown option: ${arg}\n\n${USAGE}`);
    else if (opts.file) fail('only one file can be edited at a time');
    else opts.file = arg;
  }
  return opts;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
  child.on('error', () => {}); // no browser opener available; the URL is printed anyway
  child.unref();
}

const opts = parseArgs(process.argv.slice(2));

const file = path.resolve(opts.file ?? 'README.md');
if (!fs.existsSync(file)) {
  fail(opts.file
    ? `no such file: ${opts.file}`
    : 'no README.md in the current directory. Pass a file: mdedit notes.md');
}
if (!fs.statSync(file).isFile()) fail(`not a file: ${opts.file ?? 'README.md'}`);
try {
  fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
} catch {
  fail(`cannot read and write ${file}`);
}

const server = createServer(file);

// Walk up from the requested port rather than failing when it is already taken.
let attempts = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && opts.port !== 0 && attempts++ < 20) {
    server.listen(++opts.port, '127.0.0.1');
    return;
  }
  fail(err.message);
});

server.listen(opts.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`mdedit  ${path.relative(process.cwd(), file) || file}`);
  console.log(`        ${url}   (Ctrl+C to stop)`);
  if (opts.open) openBrowser(url);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); process.exit(0); });
}
