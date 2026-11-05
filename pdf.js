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

  // WinAnsiEncoding (Windows-1252) für die Standardschrift Helvetica – deckt Deutsch ab
  const WIN_ANSI_EXTRA = { 0x20AC: 0x80, 0x201A: 0x82, 0x201E: 0x84, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97 };
  function winAnsiHex(s) {
    let hex = '';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      let b;
      if ((cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF)) b = cp;
      else if (WIN_ANSI_EXTRA[cp]) b = WIN_ANSI_EXTRA[cp];
      else b = 0x3F; // ?
      hex += b.toString(16).padStart(2, '0');
    }
    return hex.toUpperCase();
  }

  /**
   * @param {Array<{jpeg:Uint8Array,pageWidth:number,pageHeight:number,x:number,y:number,w:number,h:number,
   *   text?:Array<{s:string,x:number,y:number,size:number,scale:number}>}>} pages  Maße in pt;
   *   text = unsichtbare Textebene (Grundlinie x/y, Schriftgröße, horizontale Skalierung in %)
   * @param {{title?:string, producer?:string}} meta
   * @returns {Blob}
   */
  // ---------- Verschlüsselung: Standard-Security-Handler R6 (AES-256, ISO 32000-2) ----------
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
  const concat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  const sha = async (alg, data) => new Uint8Array(await subtle.digest(alg, data));
  async function aesCbc(keyBytes, iv, data, pad) {
    const k = await subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
    const out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, k, data));
    // WebCrypto hängt immer einen Padding-Block an; ohne Padding (Daten = Vielfaches von 16) abschneiden
    return pad ? out : out.subarray(0, data.length);
  }
  /** Hash-Algorithmus 2.B (Revision 6). */
  async function hash2B(pw, salt, udata) {
    let k = await sha('SHA-256', concat(pw, salt, udata));
    let e = new Uint8Array([0]);
    let i = 0;
    while (i < 64 || e[e.length - 1] > i - 32) {
      const one = concat(pw, k, udata);
      const k1 = new Uint8Array(one.length * 64);
      for (let j = 0; j < 64; j++) k1.set(one, j * one.length);
      e = await aesCbc(k.subarray(0, 16), k.subarray(16, 32), k1, false);
      let rem = 0;
      for (let j = 0; j < 16; j++) rem += e[j];
      k = await sha(['SHA-256', 'SHA-384', 'SHA-512'][rem % 3], e);
      i++;
    }
    return k.subarray(0, 32);
  }
  /** Erzeugt Schlüssel und Verschlüsselungs-Wörterbuch für ein Öffnen-Passwort. */
  async function makeEncryption(password) {
    if (!subtle) throw new Error('Verschlüsselung wird von diesem Browser nicht unterstützt');
    const pw = enc.encode(String(password).normalize('NFKC')).subarray(0, 127);
    const ownerPw = rand(32); // zufälliges Besitzer-Passwort: Öffnen nur mit dem Benutzer-Passwort
    const fileKey = rand(32);
    const zero = new Uint8Array(16);
    const empty = new Uint8Array(0);
    // Algorithmus 8: U, UE
    const uVal = rand(8), uKey = rand(8);
    const U = concat(await hash2B(pw, uVal, empty), uVal, uKey);
    const UE = await aesCbc(await hash2B(pw, uKey, empty), zero, fileKey, false);
    // Algorithmus 9: O, OE
    const oVal = rand(8), oKey = rand(8);
    const O = concat(await hash2B(ownerPw, oVal, U), oVal, oKey);
    const OE = await aesCbc(await hash2B(ownerPw, oKey, U), zero, fileKey, false);
    // Algorithmus 10: Perms (alle Rechte, Metadaten verschlüsselt)
    const P = -4;
    const perms = new Uint8Array(16);
    new DataView(perms.buffer).setInt32(0, P, true);
    perms.set([0xFF, 0xFF, 0xFF, 0xFF, 0x54, 0x61, 0x64, 0x62], 4);
    perms.set(rand(4), 12);
    const Perms = await aesCbc(fileKey, zero, perms, false);
    const dict = `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> ` +
      `/StmF /StdCF /StrF /StdCF /O <${toHex(O)}> /U <${toHex(U)}> /OE <${toHex(OE)}> /UE <${toHex(UE)}> /P ${P} /Perms <${toHex(Perms)}> /EncryptMetadata true >>`;
    // Strings und Streams: zufälliger IV + AES-256-CBC mit PKCS#7
    const encrypt = async (bytes) => { const iv = rand(16); return concat(iv, await aesCbc(fileKey, iv, bytes, true)); };
    return { dict, encrypt };
  }

  /** UTF-16BE mit BOM (für Textstrings). */
  function utf16be(s) {
    const units = [];
    for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i));
    const out = new Uint8Array(2 + units.length * 2);
    out[0] = 0xFE; out[1] = 0xFF;
    units.forEach((u, i) => { out[2 + i * 2] = u >> 8; out[3 + i * 2] = u & 0xFF; });
    return out;
  }

  /**
   * @param {Array<{jpeg:Uint8Array,pageWidth:number,pageHeight:number,x:number,y:number,w:number,h:number,text?:Array}>} pages  Maße in pt
   * @param {{title?:string, producer?:string, password?:string}} meta  mit password: AES-256-verschlüsselt (Öffnen-Passwort)
   * @returns {Promise<Blob>}
   */
  async function build(pages, meta = {}) {
    const crypt = meta.password ? await makeEncryption(meta.password) : null;
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
    // Textstring (UTF-16BE); verschlüsselt, wenn ein Passwort gesetzt ist
    const textStr = async (s) => (crypt ? `<${toHex(await crypt.encrypt(utf16be(String(s))))}>` : pdfText(s));
    const dateStr = async (d) => (crypt ? `<${toHex(await crypt.encrypt(enc.encode(d)))}>` : `(${d})`);
    const stream = async (dictBody, bytes) => {
      const data = crypt ? await crypt.encrypt(bytes) : bytes;
      return [`<< ${dictBody} /Length ${data.length} >>\nstream\n`, data, '\nendstream'];
    };

    const n = pages.length;
    const total = 4 + 3 * n + (crypt ? 1 : 0);
    const first = 5; // erstes Seitenobjekt
    push(crypt ? '%PDF-1.7\n' : '%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    obj(1, [crypt ? '<< /Type /Catalog /Pages 2 0 R /Extensions << /ADBE << /BaseVersion /1.7 /ExtensionLevel 8 >> >> >>' : '<< /Type /Catalog /Pages 2 0 R >>']);
    const kids = pages.map((_, i) => `${first + 3 * i} 0 R`).join(' ');
    obj(2, [`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`]);
    const now = pdfDate(new Date());
    const producer = await textStr(meta.producer || 'DokScan');
    obj(3, [`<< /Producer ${producer} /Creator ${await textStr(meta.producer || 'DokScan')} /Title ${await textStr(meta.title || 'Scan')} /CreationDate ${await dateStr(now)} /ModDate ${await dateStr(now)} >>`]);

    obj(4, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);

    for (let i = 0; i < n; i++) {
      const p = pages[i];
      const pageNo = first + 3 * i, contNo = first + 1 + 3 * i, imgNo = first + 2 + 3 * i;
      const info = jpegInfo(p.jpeg);
      obj(pageNo, [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.pageWidth)} ${num(p.pageHeight)}] ` +
        `/Resources << /XObject << /Im0 ${imgNo} 0 R >> /Font << /F1 4 0 R >> /ProcSet [/PDF /Text /ImageB /ImageC] >> /Contents ${contNo} 0 R >>`,
      ]);
      let content = `q\n${num(p.w)} 0 0 ${num(p.h)} ${num(p.x)} ${num(p.y)} cm\n/Im0 Do\nQ`;
      if (p.text && p.text.length) {
        // unsichtbarer Text (Render-Modus 3) exakt über den erkannten Wörtern
        const parts = ['\nBT\n3 Tr'];
        for (const t of p.text) {
          parts.push(`/F1 ${num(t.size)} Tf ${num(t.scale)} Tz 1 0 0 1 ${num(t.x)} ${num(t.y)} Tm <${winAnsiHex(t.s)}> Tj`);
        }
        parts.push('ET');
        content += parts.join('\n');
      }
      obj(contNo, await stream('', enc.encode(content)));
      const cs = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      obj(imgNo, await stream(`/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg));
    }
    let trailerExtra = '';
    if (crypt) {
      const encNo = total;
      obj(encNo, [crypt.dict]);
      const id = toHex(rand(16));
      trailerExtra = ` /Encrypt ${encNo} 0 R /ID [<${id}> <${id}>]`;
    }

    const xrefAt = offset;
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let k = 1; k <= total; k++) xref += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    push(xref);
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R${trailerExtra} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  return { build, jpegInfo };
})();
