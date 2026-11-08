'use strict';
/**
 * Datensicherung der Ablage als ZIP-Datei (ohne Kompression – Fotos sind bereits JPEG).
 * Inhalt: dokscan.json (Dokumente und Seiten ohne Bilder) + die Bilder als einzelne Dateien.
 * Lesen und Schreiben ohne fremde Bibliothek; große Dateien werden stückweise gelesen (File.slice).
 */
const Backup = (() => {
  const FORMAT = 1;

  // ---------- CRC-32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, crc = 0) {
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return ~c >>> 0;
  }

  const enc = new TextEncoder();
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  /** ZIP aus [{name, data: Blob|Uint8Array}] – Blob-Teile werden nicht kopiert. */
  async function zip(files, onProgress) {
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const name = enc.encode(f.name);
      const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(await f.data.arrayBuffer());
      const crc = crc32(bytes);
      const size = bytes.length;
      if (offset + size > 0xFFFFFFF0) throw new Error('Die Sicherung wäre größer als 4 GB.');
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTime(now), true); h.setUint16(12, dosDate(now), true);
      h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, f.data instanceof Uint8Array ? bytes : f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, dosTime(now), true); c.setUint16(14, dosDate(now), true);
      c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + size;
      if (onProgress) onProgress(i + 1, files.length);
    }
    const cdSize = central.reduce((s, b) => s + (b.byteLength || b.length), 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
  }

  /** Inhaltsverzeichnis einer (unkomprimierten) ZIP-Datei: Map name → Blob */
  async function unzip(file) {
    const tailLen = Math.min(file.size, 65557);
    const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Keine gültige Sicherungsdatei.');
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const out = new Map();
    let p = 0;
    for (let k = 0; k < count; k++) {
      if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Sicherungsdatei ist beschädigt.');
      const method = cd.getUint16(p + 10, true);
      const size = cd.getUint32(p + 20, true);
      const nLen = cd.getUint16(p + 28, true), xLen = cd.getUint16(p + 30, true), cLen = cd.getUint16(p + 32, true);
      const local = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nLen));
      p += 46 + nLen + xLen + cLen;
      if (method !== 0) throw new Error('Sicherungsdatei ist komprimiert – bitte die von DokScan erstellte Datei verwenden.');
      const lh = new DataView(await file.slice(local, local + 30).arrayBuffer());
      const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      out.set(name, file.slice(start, start + size));
    }
    return out;
  }

  const BLOB_KEYS_PAGE = ['original', 'processed', 'thumb'];

  /**
   * Sicherung erstellen.
   * @param {Array} docs Dokumente  @param {(docId:string)=>Promise<Array>} pagesOf Seiten eines Dokuments
   */
  async function create(docs, pagesOf, onProgress) {
    const files = [];
    const manifest = { app: 'DokScan', format: FORMAT, created: Date.now(), docs: [], pages: [] };
    for (const d of docs) {
      const { thumb, ...meta } = d;
      if (thumb instanceof Blob) { meta.thumbFile = `docs/${d.id}-thumb.jpg`; files.push({ name: meta.thumbFile, data: thumb }); }
      manifest.docs.push(meta);
      for (const p of (await pagesOf(d.id)) || []) {
        const rec = { ...p };
        for (const k of BLOB_KEYS_PAGE) {
          if (rec[k] instanceof Blob) {
            const name = `pages/${p.id}-${k}.jpg`;
            files.push({ name, data: rec[k] });
            rec[k] = { file: name, type: rec[k].type || 'image/jpeg' };
          } else rec[k] = null;
        }
        manifest.pages.push(rec);
      }
    }
    files.unshift({ name: 'dokscan.json', data: enc.encode(JSON.stringify(manifest)) });
    const blob = await zip(files, onProgress);
    return { blob, docs: manifest.docs.length, pages: manifest.pages.length };
  }

  /** Sicherung lesen: liefert Dokumente und Seiten mit Bildern als Blobs. */
  async function read(file) {
    const entries = await unzip(file);
    const m = entries.get('dokscan.json');
    if (!m) throw new Error('Keine DokScan-Sicherung.');
    const manifest = JSON.parse(await m.text());
    if (manifest.app !== 'DokScan' || !Array.isArray(manifest.docs)) throw new Error('Keine DokScan-Sicherung.');
    if (manifest.format > FORMAT) throw new Error('Die Sicherung stammt aus einer neueren Version – bitte DokScan aktualisieren.');
    const blobOf = (ref) => {
      const b = ref && entries.get(ref.file);
      return b ? new Blob([b], { type: ref.type || 'image/jpeg' }) : null;
    };
    const docs = manifest.docs.map(({ thumbFile, ...d }) => ({ ...d, thumb: thumbFile ? blobOf({ file: thumbFile }) : null }));
    const pages = manifest.pages.map((p) => {
      const rec = { ...p };
      for (const k of BLOB_KEYS_PAGE) rec[k] = blobOf(p[k]);
      return rec;
    });
    return { docs, pages, created: manifest.created };
  }

  return { create, read, _internals: { zip, unzip, crc32 } };
})();
