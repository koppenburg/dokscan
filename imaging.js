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
  const blur = (a, w, h, r) => pass(pass(a, w, h, r, true, 'avg'), w, h, r, false, 'avg');
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
    return { quad: q, score };
  }

  /**
   * Erkennt die Ränder eines Dokuments (Blatt Papier) im Bild.
   * Prüft mehrere Merkmale (Helligkeit, „Papierweiß“) und Schwellwerte und nimmt das beste Viereck.
   * Gibt normalisierte Ecken zurück oder null, wenn nichts Sicheres gefunden wurde.
   */
  function detect(src, size = 256, fast = false) {
    const small = fast ? drawFast(src, size) : draw(src, size);
    const w = small.width, h = small.height, n = w * h;
    const d = (fast ? small.getContext('2d', { willReadFrequently: true }) : ctx(small)).getImageData(0, 0, w, h).data;
    if (!fast) release(small);
    const gray = new Float32Array(n), white = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      const mn = Math.min(r, g, b), mxc = Math.max(r, g, b);
      white[i] = mn - 0.5 * (mxc - mn); // hell UND farblos
    }
    let best = null;
    for (const raw of [gray, white]) {
      const f = blur(raw, w, h, 2);
      const { thr, hi } = otsu(f);
      // zweite Stufe: trennt Papier vom hellen Untergrund, wenn die erste nur Schrift abgetrennt hat
      const upper = otsu(f, thr).thr;
      const levels = [thr, thr + (hi - thr) * 0.4];
      if (upper > thr + 4) levels.push(upper);
      for (const t of levels) {
        const mask = new Uint8Array(n);
        for (let i = 0; i < n; i++) mask[i] = f[i] > t ? 1 : 0;
        const c = quadFromMask(mask, w, h);
        if (c && (!best || c.score > best.score)) best = c;
      }
    }
    // Kantenbasiert: alles, was vom Bildrand aus ohne Kante erreichbar ist, ist Hintergrund.
    // Hilft bei hellem Untergrund, wo Helligkeits-Schwellwerte versagen.
    {
      const f = blur(gray, w, h, 1);
      const edge = new Uint8Array(n);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = (f[i + 1] - f[i - 1]) / 2, gy = (f[i + w] - f[i - w]) / 2;
          if (gx * gx + gy * gy > 9) edge[i] = 1;
        }
      }
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
      const c = quadFromMask(mask, w, h, 4);
      if (c && (!best || c.score > best.score)) best = c;
    }
    if (!best || best.score < 0.6) return null;
    // minimal nach innen, damit kein Streifen Untergrund am Rand bleibt
    const cx = best.quad.reduce((a, p) => a + p[0], 0) / 4, cy = best.quad.reduce((a, p) => a + p[1], 0) / 4;
    const q = best.quad.map(([x, y]) => [x + (cx - x) * 0.012, y + (cy - y) * 0.012]);
    // Fast das ganze Bild? Dann einfach das ganze Bild nehmen.
    if (q.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 0.02 && Math.abs(p[1] - FULL[i][1]) < 0.02)) return FULL.map((p) => p.slice());
    return q;
  }

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
   * Komplette Seitenverarbeitung (Hauptthread oder Worker):
   * Original laden → drehen → ggf. Ränder erkennen → entzerren → Filter → JPEG + Vorschaubild.
   */
  async function processPage({ original, rotation, corners, filter: mode, autoDetect, maxDim = 3000 }) {
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
    filter(c, mode);
    const processed = await toBlob(c, 'image/jpeg', 0.9);
    const t = draw(c, 420);
    const thumb = await toBlob(t, 'image/jpeg', 0.8);
    const res = { processed, thumb, pw: c.width, ph: c.height, corners };
    release(t); release(c);
    return res;
  }

  /** Zuletzt für die Live-Erkennung verkleinertes Kamerabild (oder null). */
  const lastFrame = () => fastCanvas;

  return { FULL, canvas, release, load, draw, toBlob, lastFrame, rotate, rotateCornersCW, isFull, isConvex, warp, filter, detect, processPage };
})();
