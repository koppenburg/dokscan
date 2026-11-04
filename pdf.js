'use strict';
/**
 * Minimaler PDF-Writer: bettet JPEG-Bilder (DCTDecode) seitenweise ein.
 * Keine externen Abhängigkeiten, funktioniert offline.
 */
const PDFWriter = (() => {
  const enc = new TextEncoder();

  /** Liest Breite, Höhe und Farbkanäle aus dem SOF-Marker eines JPEGs. */
  function jpegInfo(bytes) {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw new Error('Kein gültiges JPEG');
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const m = bytes[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return {
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
          components: bytes[i + 9],
        };
      }
      i += 2 + len;
    }
    throw new Error('JPEG-Header nicht gefunden');
  }

  /** Text als UTF-16BE-Hexstring (sicher für Umlaute). */
  function pdfText(s) {
    let hex = '<FEFF';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (cp > 0xFFFF) {
        const v = cp - 0x10000;
        hex += (0xD800 + (v >> 10)).toString(16).padStart(4, '0');
        hex += (0xDC00 + (v & 0x3FF)).toString(16).padStart(4, '0');
      } else {
        hex += cp.toString(16).padStart(4, '0');
      }
    }
    return hex.toUpperCase() + '>';
  }

  function pdfDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
  }

  const num = (n) => (Math.round(n * 100) / 100).toString();

  /**
   * @param {Array<{jpeg:Uint8Array,pageWidth:number,pageHeight:number,x:number,y:number,w:number,h:number}>} pages  Maße in pt
   * @param {{title?:string, producer?:string}} meta
   * @returns {Blob}
   */
  function build(pages, meta = {}) {
    const chunks = [];
    const offsets = [];
    let offset = 0;
    const push = (data) => {
      const b = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(b);
      offset += b.length;
    };
    const obj = (n, parts) => {
      offsets[n] = offset;
      push(`${n} 0 obj\n`);
      for (const part of parts) push(part);
      push('\nendobj\n');
    };

    const n = pages.length;
    const total = 3 + 3 * n;
    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    const kids = pages.map((_, i) => `${4 + 3 * i} 0 R`).join(' ');
    obj(2, [`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`]);
    const now = pdfDate(new Date());
    obj(3, [`<< /Producer ${pdfText(meta.producer || 'DokScan')} /Creator ${pdfText(meta.producer || 'DokScan')} /Title ${pdfText(meta.title || 'Scan')} /CreationDate (${now}) /ModDate (${now}) >>`]);

    pages.forEach((p, i) => {
      const pageNo = 4 + 3 * i, contNo = 5 + 3 * i, imgNo = 6 + 3 * i;
      const info = jpegInfo(p.jpeg);
      obj(pageNo, [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.pageWidth)} ${num(p.pageHeight)}] ` +
        `/Resources << /XObject << /Im0 ${imgNo} 0 R >> /ProcSet [/PDF /ImageB /ImageC] >> /Contents ${contNo} 0 R >>`,
      ]);
      const content = `q\n${num(p.w)} 0 0 ${num(p.h)} ${num(p.x)} ${num(p.y)} cm\n/Im0 Do\nQ`;
      obj(contNo, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
      const cs = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      obj(imgNo, [
        `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
        p.jpeg,
        '\nendstream',
      ]);
    });

    const xrefAt = offset;
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let k = 1; k <= total; k++) xref += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    push(xref);
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  return { build, jpegInfo };
})();
