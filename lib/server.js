import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Locate a package's browser bundle by path rather than by specifier: the files
 * we want are real but unexported (marked's export map covers only its ESM
 * entry), so require.resolve on the subpath throws.
 */
function vendorFile(pkg, ...candidates) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  for (const candidate of candidates) {
    const file = path.join(dir, candidate);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`no browser build found for ${pkg} (looked for ${candidates.join(', ')})`);
}

// Served from node_modules so the editor needs no network access.
const VENDOR = {
  '/vendor/marked.js': vendorFile('marked', 'lib/marked.umd.js', 'marked.min.js'),
  '/vendor/turndown.js': vendorFile('turndown', 'dist/turndown.js', 'lib/turndown.browser.umd.js'),
  '/vendor/turndown-gfm.js': vendorFile('turndown-plugin-gfm', 'dist/turndown-plugin-gfm.js'),
};

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.css': 'text/css',
  '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf',
};

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Write via a temp file in the same directory plus a rename, so an interrupted
 * write cannot leave the user's document truncated.
 */
async function writeAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.mdedit-${process.pid}.tmp`);
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

export function createServer(mdFile) {
  const basename = path.basename(mdFile);
  const assetRoot = path.dirname(path.resolve(mdFile));
  const template = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const page = template.replaceAll('__BASENAME__', escapeHtml(basename));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (req.method === 'POST' && pathname === '/api/save') {
        const body = await readBody(req);
        // Round-tripped markdown comes back without a final newline.
        await writeAtomic(mdFile, body.endsWith('\n') ? body : body + '\n');
        const { mtimeMs } = await fsp.stat(mdFile);
        // Hand back the new mtime so the client does not mistake its own save
        // for an external edit and re-render on top of the cursor.
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, mtime: mtimeMs / 1000 }));
      }

      if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method Not Allowed');

      if (pathname === '/api/load') {
        const content = await fsp.readFile(mdFile, 'utf8');
        return send(res, 200, 'text/plain; charset=utf-8', content);
      }

      if (pathname === '/api/mtime') {
        const { mtimeMs } = await fsp.stat(mdFile);
        return send(res, 200, 'application/json', JSON.stringify({ mtime: mtimeMs / 1000 }));
      }

      if (VENDOR[pathname]) {
        return send(res, 200, 'text/javascript', await fsp.readFile(VENDOR[pathname]));
      }

      if (pathname === '/') return send(res, 200, 'text/html; charset=utf-8', page);

      if (pathname.startsWith('/api/')) return send(res, 404, 'text/plain', 'Not Found');

      // Anything else is an asset referenced by the document, resolved against
      // the document's own directory. Confined to that subtree.
      const target = path.resolve(assetRoot, pathname.replace(/^\/+/, ''));
      if (target !== assetRoot && !target.startsWith(assetRoot + path.sep)) {
        return send(res, 403, 'text/plain', 'Forbidden');
      }
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) return send(res, 404, 'text/plain', 'Not Found');

      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      return send(res, 200, type, await fsp.readFile(target));
    } catch (err) {
      send(res, 500, 'text/plain', `mdedit: ${err.message}`);
    }
  });
}
