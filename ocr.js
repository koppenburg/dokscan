'use strict';
/**
 * Texterkennung (OCR) mit Tesseract – komplett lokal, die Dateien liegen in vendor/tesseract.
 * Wird erst bei Bedarf geladen (ca. 9 MB, danach im Browser zwischengespeichert).
 */
const Ocr = (() => {
  const BASE = new URL('vendor/tesseract/', location.href).href;
  let workerPromise = null;
  let progressCb = null;
  let chain = Promise.resolve();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Texterkennung konnte nicht geladen werden' + (navigator.onLine ? '' : ' – beim ersten Mal ist eine Internetverbindung nötig')));
      document.head.appendChild(s);
    });
  }

  function getWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        await loadScript(BASE + 'tesseract.min.js');
        return window.Tesseract.createWorker('deu', 1, {
          workerPath: BASE + 'worker.min.js',
          corePath: BASE,
          langPath: BASE + 'lang',
          workerBlobURL: false,
          gzip: true,
          logger: (m) => { if (progressCb) progressCb(m); },
        });
      })().catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  /**
   * Erkennt den Text eines Bildes.
   * @returns {{text:string, words:Array<[string,number,number,number,number,number]>}}
   *          Wörter als [Text, x0, y0, x1, y1, Grundlinie-y, Zeilenhöhe] in Bildpixeln
   */
  function recognize(blob, onProgress) {
    // Aufträge nacheinander abarbeiten (ein Tesseract-Worker)
    const run = chain.then(async () => {
      progressCb = onProgress || null;
      try {
        const worker = await getWorker();
        const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
        const words = [];
        for (const block of data.blocks || []) {
          for (const para of block.paragraphs || []) {
            for (const line of para.lines || []) {
              const bl = line.baseline;
              for (const w of line.words || []) {
                const t = (w.text || '').trim();
                if (!t || w.confidence < 30) continue;
                const b = w.bbox;
                let base = b.y1;
                if (bl && bl.x1 !== bl.x0) {
                  const cx = (b.x0 + b.x1) / 2;
                  base = bl.y0 + (bl.y1 - bl.y0) * (cx - bl.x0) / (bl.x1 - bl.x0);
                  if (base < b.y0 || base > b.y1 + (b.y1 - b.y0) * 0.5) base = b.y1;
                }
                words.push([t, b.x0, b.y0, b.x1, b.y1, base, line.bbox ? line.bbox.y1 - line.bbox.y0 : b.y1 - b.y0]);
              }
            }
          }
        }
        return { text: (data.text || '').trim(), words };
      } finally {
        progressCb = null;
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  const loaded = () => !!workerPromise;
  return { recognize, loaded };
})();
