'use strict';
/**
 * PDF-Import mit pdf.js (lokal in vendor/pdfjs, wird erst bei Bedarf geladen).
 * Jede PDF-Seite wird als Bild gerendert; vorhandener Text wird mit Position übernommen,
 * damit das neue PDF ohne Texterkennung wieder durchsuchbar ist.
 */
const PdfImport = (() => {
  const BASE = new URL('vendor/pdfjs/', location.href).href;
  let libPromise = null;

  function lib() {
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
        const s = document.createElement('script');
        s.src = BASE + 'pdf.min.js';
        s.onload = () => {
          const L = window.pdfjsLib;
          if (!L) { reject(new Error('PDF-Import konnte nicht geladen werden')); return; }
          L.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js';
          resolve(L);
        };
        s.onerror = () => reject(new Error('PDF-Import konnte nicht geladen werden'));
        document.head.appendChild(s);
      }).catch((e) => { libPromise = null; throw e; });
    }
    return libPromise;
  }

  /** Text einer Seite als „Wörter“ im Format der Texterkennung (Pixel des gerenderten Bildes). */
  async function pageText(page, viewport) {
    const tc = await page.getTextContent();
    const words = [];
    const lines = [];
    for (const it of tc.items) {
      const s = (it.str || '').trim();
      if (!s) continue;
      // Grundlinie und Höhe im Bild (Transformation des Textes + Ansicht)
      const [a, b, , d, e, f] = it.transform;
      const fontH = Math.hypot(b, d) || Math.abs(d) || 10;
      const [x0, y0] = viewport.convertToViewportPoint(e, f);
      const [x1] = viewport.convertToViewportPoint(e + (it.width || Math.abs(a) * s.length * 0.5), f);
      const [, yTop] = viewport.convertToViewportPoint(e, f + fontH);
      const h = Math.abs(y0 - yTop);
      if (Math.abs(b) > Math.abs(a) * 0.2) continue; // gedrehter Text: Texterkennung übernimmt
      words.push([s, Math.min(x0, x1), y0 - h * 0.8, Math.max(x0, x1), y0 + h * 0.2, y0, h * 1.15]);
      lines.push(s + (it.hasEOL ? '\n' : ' '));
    }
    return { text: lines.join('').replace(/[ \t]+\n/g, '\n').trim(), words };
  }

  /**
   * Rendert die Seiten eines PDFs nacheinander.
   * @param {File|Blob} file
   * @param {{maxDim?:number, askPassword:(wrong:boolean)=>string|null, onStart?:(n:number)=>void}} opts
   * @returns {AsyncGenerator<{blob:Blob, w:number, h:number, text:{text:string,words:Array}|null, index:number, total:number}>}
   */
  async function* pages(file, opts = {}) {
    const L = await lib();
    const data = new Uint8Array(await file.arrayBuffer());
    const task = L.getDocument({
      data, isEvalSupported: false, useSystemFonts: true,
      cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/',
    });
    let cancelled = false;
    task.onPassword = (update, reason) => {
      const pw = opts.askPassword ? opts.askPassword(reason === L.PasswordResponses.INCORRECT_PASSWORD) : null;
      if (pw == null) { cancelled = true; task.destroy(); } else update(pw);
    };
    let doc;
    try { doc = await task.promise; }
    catch (e) {
      if (cancelled) { const err = new Error('Import abgebrochen'); err.cancelled = true; throw err; }
      throw new Error('PDF konnte nicht gelesen werden');
    }
    if (opts.onStart) opts.onStart(doc.numPages);
    const maxDim = opts.maxDim || 2400;
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(4, maxDim / Math.max(base.width, base.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const x = c.getContext('2d');
        x.fillStyle = '#fff';
        x.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: x, viewport: vp }).promise;
        let text = null;
        try { text = await pageText(page, vp); if (!text.words.length) text = null; } catch (e) { text = null; }
        const blob = await Img.toBlob(c, 'image/jpeg', 0.9);
        const w = c.width, h = c.height;
        Img.release(c);
        page.cleanup();
        yield { blob, w, h, text, index: i, total: doc.numPages };
      }
    } finally {
      doc.destroy();
    }
  }

  const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  return { pages, isPdf };
})();
