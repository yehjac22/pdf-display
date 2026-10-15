# PDF Display

Two pages:

- **Upload page** (`/upload`) — password-protected; replaces the current PDF.
- **Display page** (`/`) — renders the current PDF with PDF.js. Designed to be
  embedded in another site (e.g. Wix) via an iframe.

Only one PDF is live at a time. Uploading a new one overwrites `current.pdf` in
Vercel Blob, and the display page picks up the change automatically (it polls
`/api/current` every 30 s).

## Local development

```bash
npm install
UPLOAD_PASSWORD=yourpassword npm run dev
```

Then open http://localhost:8000 (display) and http://localhost:8000/upload
(upload). Without `UPLOAD_PASSWORD` set, the dev password is `letmein`.

Locally you can preview the display page against any PDF using the override:

```
http://localhost:8000/?pdf=dummy.pdf
```

## Environment variables

| Variable          | Required | Purpose                                        |
| ----------------- | -------- | ---------------------------------------------- |
| `UPLOAD_PASSWORD` | yes      | Password required by the upload page.          |
| `BLOB_READ_WRITE_TOKEN` | yes (deployed) | Vercel Blob read/write token.           |

`BLOB_READ_WRITE_TOKEN` is injected automatically when you connect a Blob store
to the project on Vercel. Do not commit it.

## Deploying to Vercel

1. Push this repo to GitHub.
2. Import the repo at vercel.com/new.
3. In the project, go to **Storage → Create → Blob**, and connect it to the
   project. This sets `BLOB_READ_WRITE_TOKEN`.
4. Add `UPLOAD_PASSWORD` under **Settings → Environment Variables**.
5. Deploy.

## Embedding in Wix

Add an **Embed → Custom Embed → iframe** (or the HTML Embed element) pointing at
your deployment root:

```html
<iframe
  src="https://your-project.vercel.app/"
  style="width:100%;height:100vh;border:0"
  title="PDF"
></iframe>
```
Set the iframe height to fill whatever container you place it in. The display
page has no toolbar, no upload UI, and no page chrome — it is just the PDF.

### Allowed embedders

Framing is restricted via `Content-Security-Policy: frame-ancestors` to:

- `isheiyisroel.org` and `www.isheiyisroel.org`
- `*.wixsite.com`, `*.editorx.io`, `*.wix.com` (Wix preview + editor origins)

The Wix domains are needed because the editor preview and the free `wixsite.com`
URL frame the embed too, not just the custom domain. This list lives in
`FRAME_ANCESTORS` in `server.js`.

Note that `X-Frame-Options` is deliberately **not** set — it has no wildcard
support for subdomains, so it cannot express `*.wixsite.com`, and setting it
would override the CSP. `frame-ancestors` supersedes it in all current
browsers.

## API

| Endpoint            | Method | Auth                     | Returns                       |
| ------------------- | ------ | ------------------------ | ----------------------------- |
| `/api/current`      | GET    | none                     | `{ url, size, uploadedAt }`   |
| `/api/upload`       | POST   | `X-Upload-Password` header | `{ ok, url, size }`         |

Upload expects `multipart/form-data` with a single `file` field. Max 25 MB.

## Notes

- PDF.js is loaded from cdnjs at version `5.4.149`, with unpkg as a fallback.
- The PDF is fetched cross-origin from Vercel Blob, which sends permissive CORS
  headers, so PDF.js can render it in the browser.
- If you want a permanent page per PDF instead of one live document, this would
  need a small index (e.g. Vercel KV) instead of the fixed `current.pdf` path.
