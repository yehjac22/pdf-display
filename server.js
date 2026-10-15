import express from 'express';
import busboy from 'busboy';
import { put, head } from '@vercel/blob';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8000;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const CURRENT_PATH = 'current.pdf'; // fixed pathname -> one live PDF at a time

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

// --- Display page: plain page that finds + renders the current PDF ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'display.html'));
});

// --- Upload page ---
app.get('/upload', (_req, res) => {
  res.sendFile(path.join(__dirname, 'upload.html'));
});

// --- API: what PDF should the display page show? ---
app.get('/api/current', async (_req, res) => {
  try {
    const meta = await head(CURRENT_PATH);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      url: meta.url,
      size: meta.size,
      uploadedAt: meta.uploadedAt
    });
  } catch {
    // No blob yet -> nothing uploaded
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ url: null });
  }
});

// --- API: upload / replace the current PDF ---
app.post('/api/upload', (req, res) => {
  const password = req.headers['x-upload-password'];
  if (!password || password !== PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  let bb;
  try {
    bb = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: MAX_BYTES }
    });
  } catch {
    return res.status(400).json({ error: 'Expected multipart/form-data' });
  }

  let handled = false;
  let tooLarge = false;

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
    file.on('data', (c) => chunks.push(c));
    file.on('limit', () => {
      tooLarge = true;
      file.resume();
    });

    file.on('close', async () => {
      if (tooLarge) {
        if (!res.headersSent) {
          res.status(413).json({ error: 'File too large (max 25 MB)' });
        }
        return;
      }
      try {
        const buf = Buffer.concat(chunks);
        const blob = await put(CURRENT_PATH, buf, {
          access: 'public',
          contentType: 'application/pdf',
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 60
        });
        if (!res.headersSent) {
          res.json({ ok: true, url: blob.url, size: buf.length });
        }
      } catch (err) {
        console.error('[upload] blob put failed:', err);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Upload to blob storage failed',
            detail: String(err && err.message ? err.message : err)
          });
        }
      }
    });
  });

  bb.on('close', () => {
    if (!handled && !res.headersSent) {
      res.status(400).json({ error: 'No file received' });
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
  console.log(`  display  -> http://localhost:${PORT}/`);
  console.log(`  upload   -> http://localhost:${PORT}/upload`);
  if (!process.env.UPLOAD_PASSWORD) {
    console.log(`  [dev] password is "${PASSWORD}" (set UPLOAD_PASSWORD to change)`);
  }
});
