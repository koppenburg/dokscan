'use strict';
// Hintergrund-Thread für die Seitenverarbeitung, damit die Bedienung flüssig bleibt.
importScripts('imaging.js');

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    if (job === 'ping') {
      // Prüft, ob OffscreenCanvas mit 2D-Kontext und JPEG-Export funktioniert
      const c = new OffscreenCanvas(8, 8);
      c.getContext('2d').fillRect(0, 0, 8, 8);
      await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      self.postMessage({ id, ok: true });
      return;
    }
    if (job.type === 'encode') {
      // Kamerabild → Original-JPEG + kleines Vorschaubild
      const c = Img.draw(job.bitmap, job.maxDim);
      job.bitmap.close();
      const original = await Img.toBlob(c, 'image/jpeg', 0.92);
      const t = Img.draw(c, 160);
      const thumb = await Img.toBlob(t, 'image/jpeg', 0.7);
      Img.release(t); Img.release(c);
      self.postMessage({ id, ok: true, result: { original, thumb } });
      return;
    }
    const result = await Img.processPage(job);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
