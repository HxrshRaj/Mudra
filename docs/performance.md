# Frontend performance audit

Tool: Lighthouse 12 (headless Chromium, mobile profile with simulated throttling), run against `vite preview` of the production build on one machine. Scores vary a little between runs; the three runs after the changes gave the same category scores.

| Metric | Before | After |
|---|---|---|
| performance | 89 | 100 |
| accessibility | 90 | 100 |
| best-practices | 96 | 96 |
| seo | 82 | 100 |
| first-contentful-paint | 2.8 s | 1.2 s |
| largest-contentful-paint | 3.1 s | 1.7 s |
| total-blocking-time | 30 ms | 0 ms |
| cumulative-layout-shift | 0 | 0 |
| speed-index | 2.8 s | 1.2 s |
| total-byte-weight | Total size was 351 KiB | Total size was 73 KiB |

## What was wrong and what changed

| Finding | Fix |
|---|---|
| 1.1 MB single JavaScript file; 249 KiB unused on first load | `ethers` and `siwe` are loaded with dynamic `import()` only when the user connects a wallet or signs in. First-load JavaScript is about 72 KB gzipped (was 359 KB). |
| No meta description (SEO 82) | Added a description, title and theme colour in `index.html`. |
| `robots.txt` invalid (served the HTML page) | Added `public/robots.txt`. |
| Contrast ratio 4.47:1 on footer text (needs 4.5:1) | Footer colour `#777` to `#595959`. |
| `favicon.ico` 404 in the console | Added `public/favicon.svg` and the link tag. |

## Known remaining items

- Best-practices stays at 96: the console shows one `401` from `GET /api/me` on the first load of a signed-out visitor. That is the intended "not signed in" answer from the protected route.
- Lighthouse still lists render-blocking CSS and unused JavaScript with small savings; they do not affect the score.
- These are lab numbers on localhost. Real-network results depend on the host and CDN.

## Guarding it

`client/lighthouserc.json` sets budgets (performance and accessibility and SEO scores, total page weight) and CI runs `lhci autorun` on every pull request.
