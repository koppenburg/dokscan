'use strict';
// Offline-Cache für die App-Dateien (stale-while-revalidate).
const CACHE = 'dokscan-v20';
// Fremdbibliotheken (Texterkennung, PDF-Import) in einem eigenen Cache, der Updates der App übersteht.
// Nur hochzählen, wenn sich Dateien in vendor/ ändern.
const VENDOR = 'dokscan-vendor-1';
const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'imaging.js', 'pdf.js', 'proc-worker.js', 'ocr.js', 'pdfimport.js', 'naming.js', 'backup.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
];
const FONTS = [
  'FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb',
  'FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb', 'FoxitSymbol.pfb',
  'LiberationSans-Bold.ttf', 'LiberationSans-BoldItalic.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-Regular.ttf',
];
// SIMD-Test wie in tesseract.js: davon hängt ab, welcher Rechenkern geladen wird
const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
function vendorFiles() {
  let simd = false;
  try { simd = WebAssembly.validate(SIMD_TEST); } catch (e) { simd = false; }
  return [
    'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js', 'vendor/tesseract/lang/deu.traineddata.gz',
    simd ? 'vendor/tesseract/tesseract-core-simd-lstm.wasm.js' : 'vendor/tesseract/tesseract-core-lstm.wasm.js',
    'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js', 'vendor/qrcode/qrcode.js',
    ...FONTS.map((f) => 'vendor/pdfjs/standard_fonts/' + f),
  ];
}
const isVendor = (url) => new URL(url, self.location.href).pathname.includes('/vendor/');

self.addEventListener('install', (e) => {
  // cache: 'reload' umgeht den HTTP-Cache, damit wirklich die neue Version gespeichert wird
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Texterkennung und PDF-Import für die Offline-Nutzung vorladen (von der App angestoßen, wenn online). */
async function warmVendor() {
  const cache = await caches.open(VENDOR);
  let loaded = 0;
  for (const f of vendorFiles()) {
    const url = new URL(f, self.location.href).href;
    if (await cache.match(url)) continue;
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) { await cache.put(url, res); loaded++; }
    } catch (err) { return { ok: false, loaded }; } // offline – beim nächsten Start erneut
  }
  return { ok: true, loaded };
}

self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'warm-vendor') return;
  e.waitUntil(warmVendor().then((r) => { if (e.source) e.source.postMessage({ type: 'vendor-ready', ...r }); }));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (isVendor(req.url)) {
    // Bibliotheken ändern sich nicht: zuerst aus dem Cache, sonst laden und behalten
    e.respondWith(
      caches.open(VENDOR).then(async (cache) => {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
