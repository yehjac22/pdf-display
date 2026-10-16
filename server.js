import express from 'express';
import busboy from 'busboy';
import { put, head } from '@vercel/blob';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8000;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// Each document is one live PDF at a fixed blob path. Adding an entry here
// automatically creates its display route (/<slug>) and upload section.
const DOCS = [
  { slug: 'schedule', label: 'Schedule' },
  { slug: 'monthly', label: 'Monthly' }
];

const DOC_BY_SLUG = new Map(DOCS.map((d) => [d.slug, d]));
const blobPathFor = (slug) => `${slug}.pdf`;

// Password: env var wins, otherwise a dev default so you can try it locally.
const PASSWORD = process.env.UPLOAD_PASSWORD || 'letmein';

const app = express();

// Wix serves the site from both the custom domain and its own subdomains,
// depending on how the visitor reached the page. Frame headers must list all
// of them or the embed will show blank inside Wix.
const FRAME_ANCESTORS = [
  "'self'",
  'https://isheiyisroel.org',
  'https://www.isheiyisroel.org',
  'https://*.wixsite.com',
  'https://*.editorx.io',
  'https://*.wix.com'
].join(' ');

const ALLOWED_EMBEDDERS = [
  'isheiyisroel.org',
  '*.wixsite.com',
  '*.editorx.io',
  '*.wix.com'
];

// Static assets only (html/css/js/png). Dummy PDF stays reachable for testing.
app.use(
  express.static(__dirname, {
    index: false,
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
      }
    }
  })
);

// Frame headers for the routes served via sendFile (bypass the static mw).
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// --- Display page: renders one document, chosen by slug ---
// "/" keeps working so the original single-document embed does not break; it
// falls back to the first document in DOCS.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'display.html'));
});

app.get('/:slug', (req, res, next) => {
  if (!DOC_BY_SLUG.has(req.params.slug)) return next();
  res.sendFile(path.join(__dirname, 'display.html'));
});

// --- Upload page: lists every document with its own upload section ---
app.get('/upload', (_req, res) => {
  res.sendFile(path.join(__dirname, 'upload.html'));
});

// --- API: which documents exist, and their labels ---
app.get('/api/docs', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ docs: DOCS });
});

// --- API: what PDF should a given display show? ---
// `doc` is a slug. Omitted -> first document, for the root display route.
app.get('/api/current', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const slug = req.query.doc || DOCS[0].slug;
  if (!DOC_BY_SLUG.has(slug)) {
    return res.status(404).json({ error: 'Unknown document' });
  }

  try {
    const meta = await head(blobPathFor(slug));
    return res.json({
      doc: slug,
      url: meta.url,
      size: meta.size,
      uploadedAt: meta.uploadedAt
    });
  } catch {
    // No blob yet -> nothing uploaded for this document
    return res.json({ doc: slug, url: null });
  }
});

// --- API: upload / replace one document's PDF ---
app.post('/api/upload', (req, res) => {
  const password = req.headers['x-upload-password'];
  if (!password || password !== PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  // Accepts the slug as ?doc= or a `doc` form field.
  const slug = String(req.query.doc || '').trim();
  const fieldSlugPromise = [];

  let bb;
  try {
    bb = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: MAX_BYTES }
    });
  } catch {
    return res.status(400).json({ error: 'Expected multipart/form-data' });
  }

  // Busboy can emit `field` events before `file`, but not guaranteed, so we
  // buffer the file until we know the slug.
  let resolvedSlug = slug || null;
  let pending = null;

  function finalize() {
    const target = resolvedSlug || DOCS[0].slug;
    if (!DOC_BY_SLUG.has(target)) {
      if (!res.headersSent) res.status(404).json({ error: 'Unknown document' });
      return;
    }
    if (!pending) return;

    const { buf, tooLarge } = pending;
    pending = null;

    if (tooLarge) {
      if (!res.headersSent) {
        res.status(413).json({ error: 'File too large (max 25 MB)' });
      }
      return;
    }

    put(blobPathFor(target), buf, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60
    })
      .then((blob) => {
        if (!res.headersSent) {
          res.json({ ok: true, doc: target, url: blob.url, size: buf.length });
        }
      })
      .catch((err) => {
        console.error('[upload] blob put failed:', err);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Upload to blob storage failed',
            detail: String(err && err.message ? err.message : err)
          });
        }
      });
  }

  bb.on('field', (name, value) => {
    if (name === 'doc' && value) {
      resolvedSlug = String(value).trim();
      finalize();
    }
  });

  let handled = false;

  bb.on('file', (_name, file, info) => {
    if (handled) {
      file.resume();
      return;
    }
    handled = true;

    const isPdf =
      info.mimeType === 'application/pdf' || /\.pdf$/i.test(info.filename || '');
    if (!isPdf) {
      file.resume();
      return res.status(415).json({ error: 'Not a PDF' });
    }

    const chunks = [];
    let tooLarge = false;

    file.on('data', (c) => chunks.push(c));
    file.on('limit', () => {
      tooLarge = true;
      file.resume();
    });

    file.on('close', () => {
      pending = { buf: Buffer.concat(chunks), tooLarge };
      // If the slug came from the query string, there is no field event to
      // wait for, so finalize as soon as the file is complete.
      if (slug) finalize();
    });
  });

  bb.on('close', () => {
    if (!handled && !res.headersSent) {
      return res.status(400).json({ error: 'No file received' });
    }
    // Slug supplied only as a form field that arrived after the file.
    if (pending) finalize();
    else if (!res.headersSent && resolvedSlug && !DOC_BY_SLUG.has(resolvedSlug)) {
      res.status(404).json({ error: 'Unknown document' });
    }
  });

  bb.on('error', (err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Upload stream error' });
  });

  req.pipe(bb);
});

app.listen(PORT, () => {
  console.log(`PDF Display running:  http://localhost:${PORT}`);
  for (const d of DOCS) {
    console.log(`  ${d.label.padEnd(9)} -> http://localhost:${PORT}/${d.slug}`);
  }
  console.log(`  upload    -> http://localhost:${PORT}/upload`);
  if (!process.env.UPLOAD_PASSWORD) {
    console.log(`  [dev] password is "${PASSWORD}" (set UPLOAD_PASSWORD to change)`);
  }
});
