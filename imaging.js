'use strict';
/**
 * Bildverarbeitung: Laden, Skalieren, Drehen, Perspektivkorrektur,
 * Dokumentfilter und automatische Randerkennung.
 */
const Img = (() => {
  /** Normalisierte Ecken (oben links, oben rechts, unten rechts, unten links) des ganzen Bildes. */
  const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];

  // Läuft im Hauptthread (Canvas) und im Web Worker (OffscreenCanvas).
  const IN_WORKER = typeof document === 'undefined';

  function canvas(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (IN_WORKER) return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  /** Gibt Canvas-Speicher frei (wichtig für iOS Safari). */
  function release(c) {
    if (!c) return;
    if (typeof c.close === 'function') { c.close(); return; } // ImageBitmap
    if (c.width) { c.width = 0; c.height = 0; }
  }
  const ctx = (c) => c.getContext('2d');

  function load(blob) {
    if (IN_WORKER) return createImageBitmap(blob);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
      img.src = url;
    });
  }

  function sizeOf(src) {
    return [src.naturalWidth || src.videoWidth || src.width, src.naturalHeight || src.videoHeight || src.height];
  }

  function smoothDraw(dst, src, w, h) {
    const x = ctx(dst);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, w, h);
  }

  /** Zeichnet Bild/Video/Canvas in ein neues Canvas, längste Seite höchstens maxDim (schrittweise verkleinert). */
  function draw(src, maxDim) {
    const [sw, sh] = sizeOf(src);
    const s = maxDim ? Math.min(1, maxDim / Math.max(sw, sh)) : 1;
    const tw = Math.max(1, Math.round(sw * s)), th = Math.max(1, Math.round(sh * s));
    let cur = src, cw = sw, ch = sh, tmp = null;
    while (cw > tw * 2) {
      const n = canvas(Math.ceil(cw / 2), Math.ceil(ch / 2));
      smoothDraw(n, cur, n.width, n.height);
      if (tmp) release(tmp);
      tmp = cur = n; cw = n.width; ch = n.height;
    }
    const out = canvas(tw, th);
    smoothDraw(out, cur, tw, th);
    if (tmp) release(tmp);
    return out;
  }

  /** Schnelles Verkleinern in einem Schritt in ein wiederverwendetes Canvas (für die Live-Erkennung). */
  let fastCanvas = null;
  function drawFast(src, maxDim) {
    const [sw, sh] = sizeOf(src);
    const s = Math.min(1, maxDim / Math.max(sw, sh));
    const tw = Math.max(1, Math.round(sw * s)), th = Math.max(1, Math.round(sh * s));
    if (!fastCanvas) fastCanvas = canvas(tw, th);
    if (fastCanvas.width !== tw || fastCanvas.height !== th) { fastCanvas.width = tw; fastCanvas.height = th; }
    const x = fastCanvas.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'low';
    x.drawImage(src, 0, 0, tw, th);
    return fastCanvas;
  }

  function toBlob(c, type = 'image/jpeg', q = 0.9) {
    if (typeof c.convertToBlob === 'function') return c.convertToBlob({ type, quality: q });
    return new Promise((resolve, reject) => {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))), type, q);
    });
  }

  /** Dreht ein Canvas im Uhrzeigersinn um 0/90/180/270 Grad. Gibt bei 0 dasselbe Canvas zurück. */
  function rotate(src, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return src;
    const w = src.width, h = src.height;
    const swap = deg === 90 || deg === 270;
    const out = canvas(swap ? h : w, swap ? w : h);
    const x = ctx(out);
    if (deg === 90) { x.translate(h, 0); x.rotate(Math.PI / 2); }
    else if (deg === 180) { x.translate(w, h); x.rotate(Math.PI); }
    else { x.translate(0, w); x.rotate(-Math.PI / 2); }
    x.drawImage(src, 0, 0);
    return out;
  }

  /** Ecken passend zu einer 90°-Drehung im Uhrzeigersinn umrechnen. */
  function rotateCornersCW(c) {
    const r = ([x, y]) => [1 - y, x];
    return [r(c[3]), r(c[0]), r(c[1]), r(c[2])];
  }

  function isFull(c) {
    return !c || c.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 1e-3 && Math.abs(p[1] - FULL[i][1]) < 1e-3);
  }

  function isConvex(c) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
      const cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
      if (Math.abs(cross) < 1e-9) return false;
      const s = Math.sign(cross);
      if (!sign) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  // ---------- Perspektivkorrektur ----------

  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let m = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
      [A[i], A[m]] = [A[m], A[i]];
      [b[i], b[m]] = [b[m], b[i]];
      const p = A[i][i];
      if (Math.abs(p) < 1e-12) throw new Error('Ausschnitt ungültig');
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / p;
        if (!f) continue;
        for (let k = i; k < n; k++) A[r][k] -= f * A[i][k];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let k = i + 1; k < n; k++) s -= A[i][k] * x[k];
      x[i] = s / A[i][i];
    }
    return x;
  }

  /** Homographie, die from[i] auf to[i] abbildet. */
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = from[i], [x, y] = to[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    const h = solve(A, b);
    h.push(1);
    return h;
  }

  /** Entzerrt das Viereck (normalisierte Ecken) zu einem Rechteck. */
  function warp(src, corners, maxDim) {
    const W = src.width, H = src.height;
    const P = corners.map(([x, y]) => [x * W, y * H]);
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let ow = Math.max(d(P[0], P[1]), d(P[3], P[2]));
    let oh = Math.max(d(P[0], P[3]), d(P[1], P[2]));
    const s = Math.min(1, maxDim / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * s));
    oh = Math.max(1, Math.round(oh * s));
    const h = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], P);
    const sd = ctx(src).getImageData(0, 0, W, H).data;
    const out = canvas(ow, oh);
    const oc = ctx(out);
    const od = oc.createImageData(ow, oh);
    const o = od.data;
    const W1 = W - 1, H1 = H - 1;
    let i = 0;
    for (let v = 0; v < oh; v++) {
      const vv = v + 0.5;
      const bx = h[1] * vv + h[2], by = h[4] * vv + h[5], bz = h[7] * vv + 1;
      for (let u = 0; u < ow; u++, i += 4) {
        const uu = u + 0.5;
        const z = h[6] * uu + bz;
        let x = (h[0] * uu + bx) / z - 0.5;
        let y = (h[3] * uu + by) / z - 0.5;
        if (x < 0) x = 0; else if (x > W1) x = W1;
        if (y < 0) y = 0; else if (y > H1) y = H1;
        const x0 = x | 0, y0 = y | 0;
        const fx = x - x0, fy = y - y0;
        const dx = x0 < W1 ? 4 : 0, dy = y0 < H1 ? W * 4 : 0;
        const a = (y0 * W + x0) * 4, b = a + dx, c = a + dy, e = c + dx;
        for (let k = 0; k < 3; k++) {
          const top = sd[a + k] + (sd[b + k] - sd[a + k]) * fx;
          const bot = sd[c + k] + (sd[e + k] - sd[c + k]) * fx;
          o[i + k] = top + (bot - top) * fy;
        }
        o[i + 3] = 255;
      }
    }
    oc.putImageData(od, 0, 0);
    return out;
  }

  // ---------- Hilfsfilter für kleine Bilder ----------

  function pass(src, w, h, r, horiz, reduce) {
    const dst = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = reduce === 'max' ? -Infinity : 0, cnt = 0;
        for (let k = -r; k <= r; k++) {
          const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = src[yy * w + xx];
          if (reduce === 'max') { if (v > acc) acc = v; } else { acc += v; cnt++; }
        }
        dst[y * w + x] = reduce === 'max' ? acc : acc / cnt;
      }
    }
    return dst;
  }
  /** Box-Weichzeichner mit laufender Summe (Aufwand unabhängig vom Radius); Ränder wie zuvor normiert. */
  function boxPass(src, w, h, r, horiz) {
    const dst = new Float32Array(w * h);
    const len = horiz ? w : h, lines = horiz ? h : w;
    const step = horiz ? 1 : w, lineStep = horiz ? w : 1;
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      let acc = 0;
      for (let k = 0; k <= Math.min(r, len - 1); k++) acc += src[base + k * step];
      for (let i = 0; i < len; i++) {
        const lo = i - r, hi = i + r;
        const cnt = Math.min(hi, len - 1) - Math.max(lo, 0) + 1;
        dst[base + i * step] = acc / cnt;
        if (hi + 1 < len) acc += src[base + (hi + 1) * step];
        if (lo >= 0) acc -= src[base + lo * step];
      }
    }
    return dst;
  }
  const blur = (a, w, h, r) => boxPass(boxPass(a, w, h, r, true), w, h, r, false);
  const dilate = (a, w, h, r) => pass(pass(a, w, h, r, true, 'max'), w, h, r, false, 'max');

  /** Schätzt die Papierfarbe (Hintergrund) pro Pixel, um Schatten und ungleichmäßiges Licht auszugleichen. */
  function background(c) {
    const W = c.width, H = c.height;
    const sdim = Math.min(256, Math.max(48, Math.round(Math.max(W, H) / 12)));
    const small = draw(c, sdim);
    const w = small.width, h = small.height;
    const sx = ctx(small);
    const id = sx.getImageData(0, 0, w, h);
    const d = id.data;
    const a = new Float32Array(w * h);
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + ch];
      let r = dilate(dilate(a, w, h, 2), w, h, 2);
      r = blur(blur(r, w, h, 3), w, h, 3);
      for (let i = 0; i < w * h; i++) d[i * 4 + ch] = r[i];
    }
    sx.putImageData(id, 0, 0);
    const big = canvas(W, H);
    smoothDraw(big, small, W, H);
    const bd = ctx(big).getImageData(0, 0, W, H).data;
    release(big);
    release(small);
    return bd;
  }

  function curve(lo, hi, gamma) {
    const lut = new Uint8ClampedArray(1025);
    for (let i = 0; i <= 1024; i++) {
      const v = i / 1024;
      let t = (v - lo) / (hi - lo);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      lut[i] = Math.round(255 * Math.pow(t, gamma));
    }
    return lut;
  }
  const LUTS = {
    document: curve(0.10, 0.88, 1.25),
    gray: curve(0.10, 0.88, 1.3),
    bw: curve(0.58, 0.80, 1),
  };

  /** Wendet einen Filter in-place an: original | document | gray | bw */
  function filter(c, mode) {
    if (!mode || mode === 'original' || !LUTS[mode]) return c;
    const W = c.width, H = c.height;
    const x = ctx(c);
    const id = x.getImageData(0, 0, W, H);
    const d = id.data;
    const bg = background(c);
    const lut = LUTS[mode];
    const n = d.length;
    if (mode === 'document') {
      for (let i = 0; i < n; i += 4) {
        for (let k = 0; k < 3; k++) {
          const b = bg[i + k] || 1;
          let q = (d[i + k] * 1024 / b) | 0;
          if (q > 1024) q = 1024;
          d[i + k] = lut[q];
        }
      }
    } else {
      for (let i = 0; i < n; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const b = (0.299 * bg[i] + 0.587 * bg[i + 1] + 0.114 * bg[i + 2]) || 1;
        let q = (l * 1024 / b) | 0;
        if (q > 1024) q = 1024;
        const v = lut[q];
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    x.putImageData(id, 0, 0);
    return c;
  }

  // ---------- Helligkeit und Kontrast ----------
  const hasAdjust = (a) => !!a && (Math.round(a.b || 0) !== 0 || Math.round(a.c || 0) !== 0);
  /**
   * Tonwertkurve für Helligkeit/Kontrast (je −100 … 100). Helligkeit wirkt über ein Gamma
   * (Schwarz und Weiß bleiben erhalten), Kontrast spreizt um die Mitte.
   */
  function adjustLut(a) {
    const lut = new Uint8ClampedArray(256);
    const g = Math.pow(2, -(a.b || 0) / 70);
    const k = Math.pow(2, (a.c || 0) / 60);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(((Math.pow(i / 255, g) - 0.5) * k + 0.5) * 255);
    return lut;
  }
  /** Helligkeit/Kontrast auf Bilddaten (RGBA) anwenden; src und dst dürfen gleich sein. */
  function adjustData(src, dst, a) {
    const lut = adjustLut(a);
    for (let i = 0, n = src.length; i < n; i += 4) {
      dst[i] = lut[src[i]]; dst[i + 1] = lut[src[i + 1]]; dst[i + 2] = lut[src[i + 2]]; dst[i + 3] = src[i + 3];
    }
    return dst;
  }
  function adjust(c, a) {
    if (!hasAdjust(a)) return c;
    const x = ctx(c);
    const id = x.getImageData(0, 0, c.width, c.height);
    adjustData(id.data, id.data, a);
    x.putImageData(id, 0, 0);
    return c;
  }
  /** Filter und Anpassung in passender Reihenfolge: bei S/W vor der Schwelle, sonst danach. */
  function finish(c, mode, a) {
    if (mode === 'bw') { adjust(c, a); filter(c, mode); } else { filter(c, mode); adjust(c, a); }
    return c;
  }

  // ---------- Automatische Dokumenterkennung ----------

  function convexHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function polyArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  function orderCorners(q) {
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    q = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0;
    for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[k][0] + q[k][1]) k = i;
    return q.slice(k).concat(q.slice(0, k));
  }

  /**
   * Verfeinert die Ecken: Für jede Kante wird eine Gerade durch die nahen Randpunkte
   * gelegt (Hauptachse), die Ecken sind die Schnittpunkte benachbarter Geraden.
   */
  function refine(quad, pts, w, h) {
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 4) return quad;
      const ux = dx / len, uy = dy / len;
      const tol = Math.max(2, len * 0.03);
      let sx = 0, sy = 0, cnt = 0;
      const sel = [];
      for (const p of pts) {
        const rx = p[0] - a[0], ry = p[1] - a[1];
        const t = (rx * ux + ry * uy) / len;
        if (t < 0.12 || t > 0.88) continue;
        if (Math.abs(rx * uy - ry * ux) > tol) continue;
        sel.push(p); sx += p[0]; sy += p[1]; cnt++;
      }
      if (cnt < 6) { lines.push(null); continue; }
      const mx = sx / cnt, my = sy / cnt;
      let xx = 0, xy = 0, yy = 0;
      for (const [x, y] of sel) { xx += (x - mx) ** 2; xy += (x - mx) * (y - my); yy += (y - my) ** 2; }
      const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
      lines.push({ px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) });
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const L1 = lines[(i + 3) % 4], L2 = lines[i];
      if (!L1 || !L2) { out.push(quad[i]); continue; }
      const det = L1.dx * L2.dy - L1.dy * L2.dx;
      if (Math.abs(det) < 0.2) { out.push(quad[i]); continue; }
      const t = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / det;
      const x = L1.px + t * L1.dx, y = L1.py + t * L1.dy;
      // Plausibilität: Ecke darf sich nur wenig verschieben
      if (Math.hypot(x - quad[i][0], y - quad[i][1]) > 0.08 * Math.max(w, h)) { out.push(quad[i]); continue; }
      out.push([x, y]);
    }
    return out;
  }

  /** Otsu-Schwellwert und Mittelwert der hellen Klasse. */
  function otsu(g, lo = -1) {
    const hist = new Float64Array(256);
    let n = 0;
    for (let i = 0; i < g.length; i++) {
      const v = Math.min(255, Math.max(0, g[i] | 0));
      if (v > lo) { hist[v]++; n++; }
    }
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 127, hi = 200;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; hi = mF; }
    }
    return { thr, hi };
  }

  function angleOk(q) {
    for (let i = 0; i < 4; i++) {
      const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
      const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1);
      const deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (deg < 40 || deg > 140) return false;
    }
    return true;
  }

  /** Größte Zusammenhangskomponente der Maske → Viereck mit Bewertung (oder null). */
  function quadFromMask(mask, w, h, inset = 1.2) {
    const n = w * h;
    const label = new Int32Array(n);
    const stack = new Int32Array(n);
    let cur = 0, bestLabel = 0, bestSize = 0;
    for (let s = 0; s < n; s++) {
      if (label[s] || !mask[s]) continue;
      cur++;
      let sp = 0, size = 0;
      stack[sp++] = s; label[s] = cur;
      while (sp) {
        const p = stack[--sp];
        size++;
        const x = p % w;
        if (x > 0 && !label[p - 1] && mask[p - 1]) { label[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && !label[p + 1] && mask[p + 1]) { label[p + 1] = cur; stack[sp++] = p + 1; }
        if (p >= w && !label[p - w] && mask[p - w]) { label[p - w] = cur; stack[sp++] = p - w; }
        if (p < n - w && !label[p + w] && mask[p + w]) { label[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = cur; }
    }
    if (bestSize < 0.1 * n || bestSize > 0.97 * n) return null;

    // Randpunkte: äußerste Pixel je Zeile und je Spalte
    const pts = [];
    for (let y = 0; y < h; y++) {
      let minx = -1, maxx = -1;
      for (let x = 0; x < w; x++) {
        if (label[y * w + x] === bestLabel) { if (minx < 0) minx = x; maxx = x; }
      }
      if (minx >= 0) pts.push([minx, y + 0.5], [maxx + 1, y + 0.5]);
    }
    for (let x = 0; x < w; x++) {
      let miny = -1, maxy = -1;
      for (let y = 0; y < h; y++) {
        if (label[y * w + x] === bestLabel) { if (miny < 0) miny = y; maxy = y; }
      }
      if (miny >= 0) pts.push([x + 0.5, miny], [x + 0.5, maxy + 1]);
    }
    const hull = convexHull(pts);
    if (hull.length < 4) return null;
    const hullArea = polyArea(hull);
    while (hull.length > 4) {
      let minA = Infinity, mi = -1;
      for (let i = 0; i < hull.length; i++) {
        const a = hull[(i - 1 + hull.length) % hull.length], b = hull[i], c = hull[(i + 1) % hull.length];
        const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
        if (ar < minA) { minA = ar; mi = i; }
      }
      hull.splice(mi, 1);
    }
    const quadArea = polyArea(hull);
    const fill = Math.min(1, bestSize / quadArea);
    const fit = quadArea / hullArea;
    if (quadArea < 0.1 * n || fit < 0.88 || fill < 0.7) return null;
    const refined = refine(orderCorners(hull), pts, w, h);
    // leicht nach innen ziehen, damit kein dunkler Hintergrundrand stehen bleibt
    const mx = refined.reduce((s, p) => s + p[0], 0) / 4, my = refined.reduce((s, p) => s + p[1], 0) / 4;
    const q = refined.map(([x, y]) => {
      const dx = mx - x, dy = my - y, l = Math.hypot(dx, dy) || 1;
      return [Math.min(1, Math.max(0, (x + (dx / l) * inset) / w)), Math.min(1, Math.max(0, (y + (dy / l) * inset) / h))];
    });
    if (!isConvex(q) || !angleOk(q.map(([x, y]) => [x * w, y * h]))) return null;
    // Kanten, die auf dem Bildrand liegen, sprechen eher für Hintergrund als für ein Blatt
    let onBorder = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const near = (v) => v < 0.03 || v > 0.97;
      if ((near(a[0]) && near(b[0]) && Math.abs(a[0] - b[0]) < 0.03) || (near(a[1]) && near(b[1]) && Math.abs(a[1] - b[1]) < 0.03)) onBorder++;
    }
    // Zwei oder mehr Kanten auf dem Bildrand: kein freistehendes Blatt (Verlauf, Wand, Blatt füllt das Bild)
    if (onBorder >= 2) return null;
    const areaFrac = quadArea / n;
    const score = fill * fit * (0.5 + 0.5 * Math.min(1, areaFrac / 0.8)) - onBorder * 0.1;
    return { quad: q, score, raw: refined };
  }

  // ---------- Kantenbasierte Dokumenterkennung ----------

  /** Farbkanäle glätten und Farbgradienten (stärkster Kanal je Pixel) berechnen. */
  function prepareEdges(d, w, h) {
    const n = w * h;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { R[i] = d[i * 4]; G[i] = d[i * 4 + 1]; B[i] = d[i * 4 + 2]; }
    const ch = [blur(R, w, h, 1), blur(G, w, h, 1), blur(B, w, h, 1)];
    const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let bx = 0, by = 0, bm = -1;
        for (let k = 0; k < 3; k++) {
          const c = ch[k];
          const sx = (c[i - w + 1] + 2 * c[i + 1] + c[i + w + 1] - c[i - w - 1] - 2 * c[i - 1] - c[i + w - 1]) / 8;
          const sy = (c[i + w - 1] + 2 * c[i + w] + c[i + w + 1] - c[i - w - 1] - 2 * c[i - w] - c[i - w + 1]) / 8;
          const m = sx * sx + sy * sy;
          if (m > bm) { bm = m; bx = sx; by = sy; }
        }
        gx[i] = bx; gy[i] = by; mag[i] = Math.sqrt(bm);
      }
    }
    // Schwelle für „Kante“: robust gegen Rauschen und Textur
    // 80. Perzentil der Gradientenstärke über ein Histogramm (schneller als Sortieren)
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[Math.min(255, mag[i] | 0)]++;
    let acc = 0, p80 = 0;
    for (; p80 < 255; p80++) { acc += hist[p80]; if (acc >= n * 0.8) break; }
    const thr = Math.max(4, (p80 + 0.5) * 1.2);
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = 0.3 * ch[0][i] + 0.59 * ch[1][i] + 0.11 * ch[2][i];
    return { w, h, ch, lum, gx, gy, mag, thr };
  }

  /** Hough-Transformation mit Gradientenrichtung → stärkste Geraden [theta, rho, Stärke]. */
  function houghLines(P, maxLines = 48) {
    const { w, h, gx, gy, mag, thr, ch } = P;
    // Farbe an einer Stelle (gerundet, im Bild begrenzt)
    const colAt = (x, y) => { const xi = Math.max(0, Math.min(w - 1, Math.round(x))), yi = Math.max(0, Math.min(h - 1, Math.round(y))); const k = yi * w + xi; return [ch[0][k], ch[1][k], ch[2][k]]; };
    const NT = 120, dT = Math.PI / NT;
    const diag = Math.ceil(Math.hypot(w, h));
    const NR = 2 * diag + 1;
    const acc = new Float32Array(NT * NR);
    const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
    for (let t = 0; t < NT; t++) { cosT[t] = Math.cos(t * dT); sinT[t] = Math.sin(t * dT); }
    const SPREAD = 5;
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        const m = mag[i];
        if (m < thr) continue;
        // Nur Stufenkanten: beidseits 3 px quer zur Kante muss sich die Farbe deutlich unterscheiden.
        // Dünne Linien (Textzeilen, Fugen, Maserung) haben beidseits dieselbe Farbe.
        const ux = gx[i] / m, uy = gy[i] / m;
        const c1 = colAt(x + ux * 3, y + uy * 3), c2 = colAt(x - ux * 3, y - uy * 3);
        if (Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]) < Math.max(8, thr)) continue;
        // Gewicht nach Länge statt Kontrast: schwache, lange Blattkanten (heller Tisch) sollen gegen
        // kontrastreiche, aber kurze Textzeilen bestehen
        const wgt = Math.min(m, thr * 2);
        let th = Math.atan2(gy[i], gx[i]);
        if (th < 0) th += Math.PI;
        const tb = Math.round(th / dT);
        for (let k = -SPREAD; k <= SPREAD; k++) {
          let t = tb + k;
          if (t < 0) t += NT; else if (t >= NT) t -= NT;
          const rho = x * cosT[t] + y * sinT[t];
          acc[t * NR + Math.round(rho) + diag] += wgt * (1 - Math.abs(k) / (SPREAD + 1));
        }
      }
    }
    let max = 0;
    for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i];
    if (!max) return [];
    const cand = [];
    const lim = max * 0.08;
    for (let t = 0; t < NT; t++) {
      for (let r = 0; r < NR; r++) {
        const v = acc[t * NR + r];
        if (v < lim) continue;
        let isMax = true;
        for (let dt = -3; dt <= 3 && isMax; dt++) {
          let tt = t + dt, rr0 = r;
          if (tt < 0) { tt += NT; rr0 = NR - 1 - r; } else if (tt >= NT) { tt -= NT; rr0 = NR - 1 - r; }
          for (let dr = -6; dr <= 6; dr++) {
            const rr = rr0 + dr;
            if (rr < 0 || rr >= NR || (dt === 0 && dr === 0)) continue;
            if (acc[tt * NR + rr] > v) { isMax = false; break; }
          }
        }
        if (isMax) cand.push([t * dT, r - diag, v]);
      }
    }
    cand.sort((a, b) => b[2] - a[2]);
    return cand.slice(0, maxLines);
  }

  function intersect(l1, l2) {
    const c1 = Math.cos(l1[0]), s1 = Math.sin(l1[0]), c2 = Math.cos(l2[0]), s2 = Math.sin(l2[0]);
    const det = c1 * s2 - s1 * c2;
    if (Math.abs(det) < 1e-6) return null;
    return [(l1[1] * s2 - s1 * l2[1]) / det, (c1 * l2[1] - l1[1] * c2) / det];
  }

  /** Aus den Geraden Vierecke bilden: zwei annähernd parallele Paare, die sich schneiden. */
  function lineQuads(P, lines) {
    const { w, h } = P;
    const minSide = Math.min(w, h);
    const pairs = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i], b = lines[j];
        let dth = Math.abs(a[0] - b[0]);
        let rb = b[1];
        if (dth > Math.PI / 2) { dth = Math.PI - dth; rb = -rb; }
        if (dth > 0.42) continue;                         // ≤ ~24° Abweichung (Perspektive)
        if (Math.abs(a[1] - rb) < minSide * 0.18) continue; // Abstand der Seiten
        let mt = (a[0] + (Math.abs(a[0] - b[0]) > Math.PI / 2 ? (b[0] < a[0] ? b[0] + Math.PI : b[0] - Math.PI) : b[0])) / 2;
        pairs.push({ a, b, mt, s: a[2] + b[2] });
      }
    }
    // Je Richtung (15°-Bereiche) nur die stärksten Paare – sonst verdrängen viele parallele
    // Textzeilen die senkrechten Blattkanten
    pairs.sort((x, y) => y.s - x.s);
    const perBucket = new Map();
    const P2 = [];
    for (const pr of pairs) {
      const bkt = Math.floor((((pr.mt % Math.PI) + Math.PI) % Math.PI) / (Math.PI / 12));
      const c = perBucket.get(bkt) || 0;
      if (c >= 16) continue;
      perBucket.set(bkt, c + 1);
      P2.push(pr);
    }
    const quads = [];
    for (let i = 0; i < P2.length; i++) {
      for (let j = i + 1; j < P2.length; j++) {
        const A = P2[i], B = P2[j];
        if (Math.abs(Math.sin(A.mt - B.mt)) < 0.75) continue; // grob rechtwinklig (50–130°)
        const pts = [intersect(A.a, B.a), intersect(A.a, B.b), intersect(A.b, B.b), intersect(A.b, B.a)];
        if (pts.some((p) => !p || p[0] < -0.06 * w || p[0] > 1.06 * w || p[1] < -0.06 * h || p[1] > 1.06 * h)) continue;
        const q = orderCorners(pts);
        const ar = polyArea(q);
        if (ar < 0.08 * w * h) continue;
        if (!isConvex(q.map(([x, y]) => [x / w, y / h]))) continue;
        q.strength = A.s + B.s;
        quads.push(q);
      }
    }
    return quads;
  }

  /**
   * Bewertet ein Viereck (Pixelkoordinaten): Wie durchgehend liegen alle vier Seiten auf einer Kante,
   * und wie deutlich unterscheidet sich die Farbe innen und außen?
   */
  /** Kantenunterstützung und Farbkontrast einer Seite a→b (Normale nach außen bei Uhrzeigersinn). */
  function sideMetrics(P, a, b) {
    const { w, h, ch, gx, gy, mag, thr } = P;
    const at = (c, x, y) => c[(y | 0) * w + (x | 0)];
    const inside = (x, y) => x >= 1 && y >= 1 && x < w - 1 && y < h - 1;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 8) return null;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const nx = uy, ny = -ux;
    const K = P.fast ? Math.max(10, Math.min(18, Math.round(len / 6))) : Math.max(12, Math.min(40, Math.round(len / 4)));
    let hit = 0, valid = 0, inL = 0, outL = 0, nL = 0;
    const diffs = [];
    const bandIn = [0, 0, 0], bandOut = [0, 0, 0];
    let nBand = 0;
    for (let k = 0; k < K; k++) {
      const t = 0.08 + 0.84 * k / (K - 1);
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      if (!inside(px, py)) continue;
      valid++;
      let best = 0;
      for (const o of [-1.5, -0.75, 0, 0.75, 1.5]) {
        const x = px + nx * o, y = py + ny * o;
        if (!inside(x, y)) continue;
        const i = (y | 0) * w + (x | 0);
        const gn = Math.abs(gx[i] * nx + gy[i] * ny);
        if (gn > best && gn > 0.8 * mag[i]) best = gn;
      }
      if (best > thr) hit++;
      // Farbunterschied innen/außen in drei Abständen; der kleinste zählt. Ein echter Rand bleibt
      // überall verschieden, eine Seite neben einer Textzeile nur in einem Abstand.
      let dmin = Infinity;
      for (const o of [3, 6, 9]) {
        const xi = px - nx * o, yi = py - ny * o, xo = px + nx * o, yo = py + ny * o;
        if (!inside(xi, yi) || !inside(xo, yo)) { dmin = -1; break; }
        const dr = at(ch[0], xi, yi) - at(ch[0], xo, yo), dg = at(ch[1], xi, yi) - at(ch[1], xo, yo), db = at(ch[2], xi, yi) - at(ch[2], xo, yo);
        dmin = Math.min(dmin, Math.sqrt(dr * dr + dg * dg + db * db));
        if (o === 3) { inL += at(ch[1], xi, yi); outL += at(ch[1], xo, yo); nL++; }
        for (let k = 0; k < 3; k++) { bandIn[k] += at(ch[k], xi, yi); bandOut[k] += at(ch[k], xo, yo); }
        nBand++;
      }
      if (dmin >= 0) diffs.push(dmin);
    }
    if (valid < K * 0.5) return null;
    diffs.sort((x, y) => x - y);
    const pointCon = diffs.length ? 1 - Math.exp(-diffs[Math.floor(diffs.length / 2)] / 22) : 0;
    // Durchschnittsfarbe der Streifen innen/außen: mittelt Textzeilen heraus
    const band = nBand ? Math.hypot(bandIn[0] - bandOut[0], bandIn[1] - bandOut[1], bandIn[2] - bandOut[2]) / nBand : 0;
    const bandCon = 1 - Math.exp(-band / 16);
    return { sup: hit / valid, con: Math.min(pointCon, bandCon), inL, outL, nL };
  }

  function scoreQuad(P, q) {
    const { w, h } = P;
    const sup = [], con = [];
    let inL = 0, outL = 0, nL = 0;
    for (let s = 0; s < 4; s++) {
      const m = sideMetrics(P, q[s], q[(s + 1) % 4]);
      if (!m) return { s: 0, minSup: 0, minCon: 0 };
      sup.push(m.sup); con.push(m.con);
      inL += m.inL; outL += m.outL; nL += m.nL;
    }
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    let score = 0.35 * mean(sup) + 0.25 * Math.min(...sup) + 0.25 * mean(con) + 0.15 * Math.min(...con);
    score += 0.12 * Math.min(1, polyArea(q) / (w * h));
    if (nL && inL / nL > outL / nL + 6) score += 0.04; // Papier meist heller als der Untergrund
    return { s: score, minSup: Math.min(...sup), minCon: Math.min(...con) };
  }

  /** Mittlere Farbe und Helligkeitsstreuung in einem Vierecksbereich (Stichproben). */
  function regionStats(P, poly) {
    const { w, h, ch } = P;
    let r = 0, g = 0, b = 0, l2 = 0, n = 0;
    const [a, bb, c, d] = poly;
    for (let i = 1; i < 12; i++) {
      for (let j = 1; j < 12; j++) {
        const u = i / 12, v = j / 12;
        // bilineare Interpolation im Viereck
        const x = (1 - v) * ((1 - u) * a[0] + u * bb[0]) + v * ((1 - u) * d[0] + u * c[0]);
        const y = (1 - v) * ((1 - u) * a[1] + u * bb[1]) + v * ((1 - u) * d[1] + u * c[1]);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const k = (y | 0) * w + (x | 0);
        const R = ch[0][k], G = ch[1][k], B = ch[2][k];
        r += R; g += G; b += B; l2 += (0.3 * R + 0.59 * G + 0.11 * B) ** 2; n++;
      }
    }
    if (!n) return null;
    r /= n; g /= n; b /= n;
    const lm = 0.3 * r + 0.59 * g + 0.11 * b;
    return { r, g, b, sd: Math.sqrt(Math.max(0, l2 / n - lm * lm)) };
  }
  const statDist = (s1, s2) => Math.hypot(s1.r - s2.r, s1.g - s2.g, s1.b - s2.b) + Math.abs(s1.sd - s2.sd);

  /**
   * Schiebt Seiten nach außen, wenn dort eine weitere parallele Kante liegt und der Streifen dazwischen
   * noch zum Blatt gehört (Text, Kopfzeile) – während dahinter Untergrund kommt.
   * Behebt den typischen Fehler, dass eine Textzeile statt des schwachen Blattrands gewählt wird.
   */
  function expandSides(P, q, lines) {
    const eSup = CFG.eSup, eCon = CFG.eCon;
    const lineOf = (a, b) => { const th = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2; return [th, a[0] * Math.cos(th) + a[1] * Math.sin(th)]; };
    let quad = q.map((p) => p.slice());
    for (let pass = 0; pass < 3; pass++) {
      const insideStats = regionStats(P, quad);
      let changed = false;
      for (let s = 0; s < 4; s++) {
        const a = quad[s], b = quad[(s + 1) % 4];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
        const nx = uy, ny = -ux; // nach außen
        const prevL = lineOf(quad[(s + 3) % 4], quad[s]), nextL = lineOf(b, quad[(s + 2) % 4]);
        // Ausdehnung des Vierecks senkrecht zu dieser Seite
        const depth = Math.max(...quad.map((p) => Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny)));
        // Kandidaten: parallele (leicht gekippte) Geraden weiter außen, auf denen eine Kante liegt
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const baseAng = Math.atan2(uy, ux);
        const options = [];
        const maxDist = depth * 1.4;
        for (let dist = 4; dist <= maxDist; dist += 1.5) {
          let bestOpt = null;
          for (const tilt of [-0.07, -0.035, 0, 0.035, 0.07]) {
            const ang = baseAng + tilt;
            const th = ang + Math.PI / 2;
            const cx = mx + nx * dist, cy = my + ny * dist;
            const L = [th, cx * Math.cos(th) + cy * Math.sin(th)];
            const p1 = intersect(prevL, L), p2 = intersect(L, nextL);
            if (!p1 || !p2) continue;
            const m = sideMetrics(P, p1, p2);
            if (!m || m.sup < eSup || m.con < eCon) continue;
            const v = m.sup + m.con * 0.5;
            if (!bestOpt || v > bestOpt.v) bestOpt = { L, dist, v };
          }
          if (bestOpt) options.push(bestOpt);
        }
        for (const L of lines) {
          const c = Math.cos(L[0]), sn = Math.sin(L[0]);
          if (Math.abs(c * ux + sn * uy) > 0.2) continue; // nicht parallel genug
          const sgn = c * nx + sn * ny > 0 ? 1 : -1;
          const dist = sgn * (L[1] - (mx * c + my * sn));
          if (dist < 5 || dist > maxDist) continue;
          options.push({ L, dist, v: 0 });
        }
        options.sort((x, y) => x.dist - y.dist);
        for (const { L, dist } of options) {
          const p1 = intersect(prevL, L), p2 = intersect(L, nextL);
          if (!p1 || !p2) continue;
          const cand = quad.map((p) => p.slice());
          cand[s] = p1; cand[(s + 1) % 4] = p2;
          if (!isConvex(cand.map(([x, y]) => [x / P.w, y / P.h]))) continue;
          const ms = sideMetrics(P, p1, p2);
          if (!ms || ms.sup < eSup || ms.con < eCon) continue; // neue Seite muss eine echte Kante sein
          const strip = regionStats(P, [a, b, p2, p1]);
          const off = Math.min(12, dist * 0.6);
          const beyond = regionStats(P, [p1, p2, [p2[0] + nx * off, p2[1] + ny * off], [p1[0] + nx * off, p1[1] + ny * off]]);
          if (!strip || !beyond) continue;
          const dBeyond = statDist(strip, beyond);
          if (dBeyond < CFG.dBeyond) continue; // Streifen sieht aus wie Untergrund → hier endet das Blatt
          // Breiter Streifen muss eher zum Blatt gehören als zum Bereich dahinter (z. B. nicht nur Schatten
          // auf dem Tisch); ein schmaler darf farbig sein (Kopfzeile, Farbbalken)
          if (dist > depth * CFG.narrow && insideStats && statDist(strip, insideStats) > dBeyond + 10) continue;
          // schwache Kanten nur, wenn der Streifen eindeutig wie das Blattinnere aussieht
          if ((ms.sup < CFG.strongSup || ms.con < CFG.strongCon) && !(insideStats && statDist(strip, insideStats) < CFG.weakInside)) continue;
          quad = cand;
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
    return quad;
  }

  /**
   * Feinjustierung auf dem großen Bild: Jede Seite wird entlang ihrer Normalen auf den stärksten
   * Farbsprung gesetzt, dann robust als Gerade neu angepasst.
   */
  function refineOnImage(qn, src) {
    const [sw, sh] = sizeOf(src);
    const big = draw(src, Math.min(1400, Math.max(sw, sh)));
    const W = big.width, H = big.height;
    const d = ctx(big).getImageData(0, 0, W, H).data;
    release(big);
    const px = (x, y, k) => { const xi = Math.max(0, Math.min(W - 1, x | 0)), yi = Math.max(0, Math.min(H - 1, y | 0)); return d[(yi * W + xi) * 4 + k]; };
    const col = (x, y, ux, uy) => {
      // Mittelwert aus drei Punkten entlang der Seite (glättet Rauschen)
      let r = 0, g = 0, b = 0;
      for (const o of [-2, 0, 2]) { const X = x + ux * o, Y = y + uy * o; r += px(X, Y, 0); g += px(X, Y, 1); b += px(X, Y, 2); }
      return [r / 3, g / 3, b / 3];
    };
    const q = qn.map(([x, y]) => [x * W, y * H]);
    const R = Math.max(6, Math.round(Math.max(W, H) * 0.012));
    const lines = [];
    for (let s = 0; s < 4; s++) {
      const a = q[s], b = q[(s + 1) % 4];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
      const nx = uy, ny = -ux;
      const pts = [];
      const K = 48;
      for (let k = 0; k < K; k++) {
        const t = 0.06 + 0.88 * k / (K - 1);
        const x0 = a[0] + (b[0] - a[0]) * t, y0 = a[1] + (b[1] - a[1]) * t;
        let bestS = 0, bestD = -1;
        for (let o = -R; o <= R; o++) {
          const c1 = col(x0 + nx * (o - 1.5), y0 + ny * (o - 1.5), ux, uy), c2 = col(x0 + nx * (o + 1.5), y0 + ny * (o + 1.5), ux, uy);
          const D = Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]) * (1 - 0.25 * Math.abs(o) / R);
          if (D > bestD) { bestD = D; bestS = o; }
        }
        if (bestD > 18) pts.push([x0 + nx * bestS, y0 + ny * bestS]);
      }
      if (pts.length < K * 0.35) return null;
      let line = fitLine(pts);
      // Ausreißer verwerfen und erneut anpassen
      const res = pts.map((p) => Math.abs((p[0] - line.px) * line.ny - (p[1] - line.py) * line.nx));
      const lim = [...res].sort((x, y) => x - y)[Math.floor(res.length * 0.75)];
      line = fitLine(pts.filter((_, i) => res[i] <= lim + 0.5));
      lines.push(line);
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const L1 = lines[(i + 3) % 4], L2 = lines[i];
      const det = L1.dx * L2.dy - L1.dy * L2.dx;
      if (Math.abs(det) < 0.2) return null;
      const t = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / det;
      const x = L1.px + t * L1.dx, y = L1.py + t * L1.dy;
      if (Math.hypot(x - q[i][0], y - q[i][1]) > 0.04 * Math.hypot(W, H)) return null;
      out.push([Math.min(1, Math.max(0, x / W)), Math.min(1, Math.max(0, y / H))]);
    }
    return isConvex(out) ? out : null;
  }

  function fitLine(pts) {
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let xx = 0, xy = 0, yy = 0;
    for (const [x, y] of pts) { xx += (x - mx) ** 2; xy += (x - mx) * (y - my); yy += (y - my) ** 2; }
    const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    return { px: mx, py: my, dx, dy, nx: -dy, ny: dx };
  }

  /**
   * Erkennt die Ränder eines Dokuments (Blatt Papier) im Bild.
   * Kandidaten aus Geradensuche (Hough) und Helligkeits-/Kantenmasken werden einheitlich bewertet
   * (durchgehende Kanten auf allen vier Seiten + Farbunterschied innen/außen); das beste Viereck
   * wird – außer in der Live-Vorschau – auf dem großen Bild exakt an die Kanten angepasst.
   * Gibt normalisierte Ecken zurück oder null, wenn nichts Sicheres gefunden wurde.
   */
  function detect(src, size = 320, fast = false, prev = null) {
    const small = fast ? drawFast(src, size) : draw(src, size);
    const w = small.width, h = small.height, n = w * h;
    const d = (fast ? small.getContext('2d', { willReadFrequently: true }) : ctx(small)).getImageData(0, 0, w, h).data;
    if (!fast) release(small);
    const P = prepareEdges(d, w, h);
    P.fast = fast;
    const lines = houghLines(P, fast ? 36 : 48);
    let cands = lineQuads(P, lines);
    if (fast && cands.length > 160) cands = cands.sort((a, b) => b.strength - a.strength).slice(0, 160);

    // Zusätzliche Kandidaten aus Masken (helles Papier, „Papierweiß“, kantenfreier Hintergrund)
    const gray = new Float32Array(n), white = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      const mn = Math.min(r, g, b), mxc = Math.max(r, g, b);
      white[i] = mn - 0.5 * (mxc - mn);
    }
    for (const raw of [gray, white]) {
      const f = blur(raw, w, h, 2);
      const { thr, hi } = otsu(f);
      const upper = otsu(f, thr).thr;
      const levels = fast ? [thr] : [thr, thr + (hi - thr) * 0.4];
      if (!fast && upper > thr + 4) levels.push(upper);
      const mask = new Uint8Array(n);
      for (const t of levels) {
        for (let i = 0; i < n; i++) mask[i] = f[i] > t ? 1 : 0;
        const c = quadFromMask(mask, w, h);
        if (c) cands.push(c.raw);
      }
    }
    {
      const edge = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (P.mag[i] > P.thr) edge[i] = 1;
      const closed = dilate(edge, w, h, 1);
      const bg = new Uint8Array(n);
      const stack = new Int32Array(n);
      let sp = 0;
      const seed = (i) => { if (!bg[i] && !closed[i]) { bg[i] = 1; stack[sp++] = i; } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (sp) {
        const p = stack[--sp];
        const x = p % w;
        if (x > 0) seed(p - 1);
        if (x < w - 1) seed(p + 1);
        if (p >= w) seed(p - w);
        if (p < n - w) seed(p + w);
      }
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = bg[i] ? 0 : 1;
      const c = quadFromMask(mask, w, h, 0);
      if (c) cands.push(c.raw);
    }

    // Live: das zuletzt erkannte Viereck ist ebenfalls Kandidat, und Kandidaten in seiner Nähe
    // bekommen einen Bonus – verhindert Springen zwischen fast gleich guten Lösungen
    const prevPx = prev ? prev.map(([x, y]) => [x * w, y * h]) : null;
    if (prevPx && isConvex(prev)) cands.push(prevPx);
    const diag = Math.hypot(w, h);
    let best = null, bestScore = 0, bestRaw = 0;
    const scored = [];
    for (const q of cands) {
      const r = scoreQuad(P, q);
      scored.push([q, r]);
      let s = r.s;
      if (prevPx && r.s >= CFG.acceptLive) {
        const dmax = Math.max(...q.map((p, i) => Math.hypot(p[0] - prevPx[i][0], p[1] - prevPx[i][1]))) / diag;
        s += 0.12 * Math.max(0, 1 - dmax / 0.04);
      }
      if (s > bestScore) { bestScore = s; best = q; bestRaw = r.s; }
    }
    if (prevPx) bestScore = bestRaw; // Schwelle auf der echten Bewertung prüfen
    // optional: liegen gute Vierecke ineinander, das äußere nehmen
    if (best && CFG.nested) {
      const inPoly = (p, poly) => { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
      const tol = 0.02 * Math.hypot(w, h);
      const contains = (outer, inner) => {
        const cx = outer.reduce((s, p) => s + p[0], 0) / 4, cy = outer.reduce((s, p) => s + p[1], 0) / 4;
        const grown = outer.map(([x, y]) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x + dx / l * tol, y + dy / l * tol]; });
        return inner.every((p) => inPoly(p, grown));
      };
      let area = polyArea(best);
      for (const [q, r] of scored) {
        if (r.s < DETECT_ACCEPT || r.s < bestScore * CFG.nestedRatio) continue;
        const a = polyArea(q);
        if (a > area * 1.04 && contains(q, best)) { best = q; area = a; }
      }
    }
    detect.lastScore = bestScore;
    // Mindestsicherheit (per Benchmark: richtige Treffer liegen darüber, viele Fehltreffer darunter)
    if (!best || bestScore < (fast ? CFG.acceptLive : CFG.accept)) return null;
    // Seiten nach außen schieben – nur auf dem Foto; in der verrauschten Live-Vorschau ließe es den Rahmen springen
    if (!fast) { try { best = expandSides(P, best, lines); } catch (e) { /* unverändert lassen */ } }
    let qn = best.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
    if (!fast) {
      try { qn = refineOnImage(qn, src) || qn; } catch (e) { /* grobe Lösung behalten */ }
    }
    // hauchdünn nach innen, damit kein Streifen Untergrund am Rand bleibt
    const cx = qn.reduce((a, p) => a + p[0], 0) / 4, cy = qn.reduce((a, p) => a + p[1], 0) / 4;
    const q = qn.map(([x, y]) => [x + (cx - x) * 0.004, y + (cy - y) * 0.004]);
    if (q.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 0.02 && Math.abs(p[1] - FULL[i][1]) < 0.02)) return FULL.map((p) => p.slice());
    return q;
  }
  const DETECT_ACCEPT = 0.5;
  // Abgestimmte Schwellwerte der Erkennung (per Benchmark ermittelt)
  const CFG = { accept: 0.87, acceptLive: 0.8, eSup: 0.35, eCon: 0.12, strongSup: 0.45, strongCon: 0.2, weakInside: 30, narrow: 0.2, dBeyond: 22, nested: 0, nestedRatio: 0.82 };

  /**
   * Schneidet dunkle Reststreifen des Untergrunds an den Rändern ab (höchstens 2 % je Seite).
   */
  function trimEdges(c) {
    const W = c.width, H = c.height;
    if (W < 50 || H < 50) return c;
    const x = ctx(c);
    const lum = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; return s / (d.length / 4); };
    const line = (side, k) => {
      if (side === 0) return lum(x.getImageData(0, k, W, 1).data);           // oben
      if (side === 1) return lum(x.getImageData(0, H - 1 - k, W, 1).data);   // unten
      if (side === 2) return lum(x.getImageData(k, 0, 1, H).data);           // links
      return lum(x.getImageData(W - 1 - k, 0, 1, H).data);                   // rechts
    };
    const cut = [0, 0, 0, 0];
    for (let side = 0; side < 4; side++) {
      const len = side < 2 ? H : W;
      const max = Math.max(2, Math.round(len * 0.02));
      const ref = line(side, max + 3);
      let k = 0;
      while (k < max && line(side, k) < ref * 0.82) k++;
      cut[side] = k < max ? k : 0; // ganzer Bereich dunkel → eher Inhalt, nichts abschneiden
    }
    if (!cut.some(Boolean)) return c;
    const nw = W - cut[2] - cut[3], nh = H - cut[0] - cut[1];
    const out = canvas(nw, nh);
    ctx(out).drawImage(c, cut[2], cut[0], nw, nh, 0, 0, nw, nh);
    return out;
  }

  /**
   * Unschärfe-Maß nach Crété-Roffet et al. („The Blur Effect“, 2007): Wie viel Kantenvariation geht
   * verloren, wenn man das Bild zusätzlich weichzeichnet? Scharfe Fotos verlieren viel, unscharfe kaum.
   * Ergebnis 0 (scharf) … 1 (sehr unscharf); null, wenn die Seite zu wenig Struktur hat (z. B. leer).
   */
  function blurScore(src, maxDim = 1400) {
    const c = draw(src, maxDim);
    const w = c.width, h = c.height;
    const d = ctx(c).getImageData(0, 0, w, h).data;
    release(c);
    // nur der innere Bereich (Ränder/Zuschnittkanten nicht mitzählen)
    const x0 = Math.round(w * 0.06), x1 = Math.round(w * 0.94), y0 = Math.round(h * 0.06), y1 = Math.round(h * 0.94);
    const n = w * h;
    const G = new Float32Array(n);
    for (let i = 0; i < n; i++) G[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    // leicht entrauschen (3×3), damit Sensorrauschen nicht als „Schärfe“ zählt
    const F = blur(G, w, h, 1);
    const Bh = boxPass(F, w, h, 4, true), Bv = boxPass(F, w, h, 4, false);
    let sFh = 0, sVh = 0, sFv = 0, sVv = 0;
    for (let y = y0 + 1; y < y1; y++) {
      for (let x = x0 + 1; x < x1; x++) {
        const i = y * w + x;
        const dFh = Math.abs(F[i] - F[i - 1]), dBh = Math.abs(Bh[i] - Bh[i - 1]);
        const dFv = Math.abs(F[i] - F[i - w]), dBv = Math.abs(Bv[i] - Bv[i - w]);
        // Rauschen (kleine Sprünge) ignorieren, sonst wirkt jedes verrauschte Foto „scharf“
        if (dFh > 4) { sFh += dFh; sVh += Math.max(0, dFh - dBh); }
        if (dFv > 4) { sFv += dFv; sVv += Math.max(0, dFv - dBv); }
      }
    }
    const area = (x1 - x0) * (y1 - y0);
    if ((sFh + sFv) / area < 1.2) return null; // kaum Struktur → keine Aussage
    const bh = sFh ? (sFh - sVh) / sFh : 0, bv = sFv ? (sFv - sVv) / sFv : 0;
    return Math.max(bh, bv);
  }

  /**
   * Komplette Seitenverarbeitung (Hauptthread oder Worker):
   * Original laden → drehen → ggf. Ränder erkennen → entzerren → Filter → JPEG + Vorschaubild.
   */
  /** Original laden, drehen, ggf. Ränder erkennen und entzerren (ohne Filter). */
  async function prepare({ original, rotation, corners, autoDetect, maxDim = 3000 }) {
    const img = await load(original);
    let c = draw(img, maxDim);
    release(img);
    const r = rotate(c, rotation);
    if (r !== c) { release(c); c = r; }
    if (autoDetect) {
      try { corners = detect(c) || corners; } catch (e) { /* Hinweis aus der Live-Erkennung behalten */ }
    }
    if (!isFull(corners)) {
      const w = warp(c, corners, maxDim);
      release(c); c = w;
      const t = trimEdges(c);
      if (t !== c) { release(c); c = t; }
    }
    return { c, corners };
  }

  async function processPage({ original, rotation, corners: hint, filter: mode, adjust: adj, autoDetect, maxDim = 3000 }) {
    const { c, corners } = await prepare({ original, rotation, corners: hint, autoDetect, maxDim });
    // Schärfe auf dem entzerrten Foto messen (vor dem Filter, der Kontraste verändert)
    let blur = null;
    try { blur = blurScore(c); } catch (e) { blur = null; }
    finish(c, mode, adj);
    const processed = await toBlob(c, 'image/jpeg', 0.9);
    const t = draw(c, 420);
    const thumb = await toBlob(t, 'image/jpeg', 0.8);
    const res = { processed, thumb, pw: c.width, ph: c.height, corners, blur };
    release(t); release(c);
    return res;
  }

  /** Zuletzt für die Live-Erkennung verkleinertes Kamerabild (oder null). */
  const lastFrame = () => fastCanvas;

  // interne Bausteine für Tests
  const _internals = { blurScore, CFG, prepareEdges, houghLines, lineQuads, scoreQuad, sideMetrics, regionStats, statDist, expandSides, intersect };

  return { _internals, blurScore, FULL, canvas, release, load, draw, toBlob, lastFrame, rotate, rotateCornersCW, isFull, isConvex, warp, filter, hasAdjust, adjustData, adjust, finish, detect, prepare, processPage };
})();
