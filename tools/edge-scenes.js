'use strict';
// Realistischere Testszenen für die Randerkennung (deterministisch über Seed)
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeScene(seed, kind) {
  const r = rng(seed * 7919 + 13);
  const W = 1600, H = 1200;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const kinds = ['wood', 'carpet', 'light', 'cloth', 'tiles', 'dark'];
  kind = kind || kinds[Math.floor(r() * kinds.length)];
  // Hintergrund
  if (kind === 'wood') {
    x.fillStyle = `hsl(${25 + r() * 10},${35 + r() * 20}%,${30 + r() * 15}%)`; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 260; i++) { x.strokeStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,220,180'},${0.04 + r() * 0.08})`; x.lineWidth = 1 + r() * 4; x.beginPath(); const y0 = r() * H; x.moveTo(0, y0); for (let k = 0; k <= 8; k++) x.lineTo(k * W / 8, y0 + Math.sin(k + r()) * 12); x.stroke(); }
  } else if (kind === 'carpet') {
    x.fillStyle = `hsl(${r() * 360},20%,${35 + r() * 20}%)`; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 9000; i++) { x.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${0.08 + r() * 0.12})`; x.fillRect(r() * W, r() * H, 2 + r() * 4, 2 + r() * 4); }
  } else if (kind === 'light') {
    const g = 200 + r() * 25; x.fillStyle = `rgb(${g},${g - 2},${g - 8})`; x.fillRect(0, 0, W, H);
  } else if (kind === 'cloth') {
    const h = r() * 360; x.fillStyle = `hsl(${h},45%,55%)`; x.fillRect(0, 0, W, H);
    x.fillStyle = `hsla(${h},45%,35%,0.5)`; const st = 40 + r() * 40; for (let i = 0; i < W; i += st) x.fillRect(i, 0, st / 3, H); for (let j = 0; j < H; j += st) x.fillRect(0, j, W, st / 3);
  } else if (kind === 'tiles') {
    x.fillStyle = `rgb(${150 + r() * 40},${150 + r() * 40},${150 + r() * 40})`; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(60,60,60,0.8)'; x.lineWidth = 3; const st = 140 + r() * 80; const a = (r() - 0.5) * 0.3;
    x.save(); x.translate(W / 2, H / 2); x.rotate(a); for (let i = -W; i < W; i += st) { x.beginPath(); x.moveTo(i, -H); x.lineTo(i, H); x.stroke(); } for (let j = -H; j < H; j += st) { x.beginPath(); x.moveTo(-W, j); x.lineTo(W, j); x.stroke(); } x.restore();
  } else {
    x.fillStyle = `rgb(${20 + r() * 30},${20 + r() * 30},${25 + r() * 30})`; x.fillRect(0, 0, W, H);
  }
  // Blatt (Perspektive, Drehung)
  const cx = W / 2 + (r() - 0.5) * 300, cy = H / 2 + (r() - 0.5) * 200;
  const ph = H * (0.6 + r() * 0.3), pw = ph * (0.68 + r() * 0.08);
  const ang = (r() - 0.5) * 0.7;
  const base = [[-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, ph / 2], [-pw / 2, ph / 2]];
  const persp = base.map(([a, b]) => [a * (1 + (b < 0 ? -1 : 1) * (r() * 0.12)), b]);
  let quad = persp.map(([a, b]) => [cx + a * Math.cos(ang) - b * Math.sin(ang) + (r() - 0.5) * 30, cy + a * Math.sin(ang) + b * Math.cos(ang) + (r() - 0.5) * 30]);
  // Blatt vollständig im Bild halten (2 % Rand) – so fotografiert man Unterlagen
  const mnx = Math.min(...quad.map((q) => q[0])), mxx = Math.max(...quad.map((q) => q[0])), mny = Math.min(...quad.map((q) => q[1])), mxy = Math.max(...quad.map((q) => q[1]));
  const fit = Math.min(1, (W * 0.96) / (mxx - mnx), (H * 0.96) / (mxy - mny));
  const qcx = (mnx + mxx) / 2, qcy = (mny + mxy) / 2;
  quad = quad.map(([a, b]) => [qcx + (a - qcx) * fit, qcy + (b - qcy) * fit]);
  const sx0 = Math.max(0, W * 0.02 - Math.min(...quad.map((q) => q[0]))) - Math.max(0, Math.max(...quad.map((q) => q[0])) - W * 0.98);
  const sy0 = Math.max(0, H * 0.02 - Math.min(...quad.map((q) => q[1]))) - Math.max(0, Math.max(...quad.map((q) => q[1])) - H * 0.98);
  quad = quad.map(([a, b]) => [a + sx0, b + sy0]);
  x.save();
  x.beginPath(); quad.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.closePath();
  const pg = x.createLinearGradient(quad[0][0], quad[0][1], quad[2][0], quad[2][1]);
  const pb = 238 + r() * 14, pe = pb - 8 - r() * 27;
  pg.addColorStop(0, `rgb(${pb},${pb - 2},${pb - 7})`); pg.addColorStop(1, `rgb(${pe},${pe - 2},${pe - 6})`);
  x.fillStyle = pg; x.fill(); x.clip();
  // Inhalt: Text, ggf. dunkler Kopf/Foto am Rand
  // Inhalt im Koordinatensystem des Blatts (Text läuft parallel zu den Blatträndern)
  const qx = quad.reduce((a, q) => a + q[0], 0) / 4, qy = quad.reduce((a, q) => a + q[1], 0) / 4;
  x.translate(qx, qy); x.rotate(ang); x.scale(fit, fit);
  const bx = -pw / 2, by = -ph / 2;
  x.fillStyle = '#222';
  for (let i = 0; i < 30; i++) x.fillRect(bx + pw * 0.12, by + ph * 0.18 + i * ph * 0.025, pw * (0.5 + r() * 0.3), ph * 0.008);
  if (r() < 0.35) { x.fillStyle = `hsl(${r() * 360},50%,30%)`; x.fillRect(bx - 50, by - 50, pw + 100, ph * 0.12 + 50); }
  if (r() < 0.25) { x.fillStyle = '#333'; x.fillRect(bx + pw * 0.55, by + ph * 0.55, pw * 0.5, ph * 0.3); }
  x.restore();
  // Schatten (Hand/Handy) über einem Teil
  if (r() < 0.5) { x.fillStyle = `rgba(0,0,0,${0.15 + r() * 0.2})`; x.beginPath(); const sx = r() * W, sy = r() * H; x.ellipse(sx, sy, 300 + r() * 400, 200 + r() * 300, r() * 3, 0, 7); x.fill(); }
  // Vignette, Rauschen, Unschärfe
  const vg = x.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.95); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${0.2 + r() * 0.3})`); x.fillStyle = vg; x.fillRect(0, 0, W, H);
  const id = x.getImageData(0, 0, W, H), d = id.data; const amp = 6 + r() * 10;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * amp; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(id, 0, 0);
  const out = document.createElement('canvas'); out.width = W; out.height = H; const ox = out.getContext('2d');
  ox.filter = `blur(${(0.5 + r() * 1.2).toFixed(1)}px)`; ox.drawImage(c, 0, 0);
  return { canvas: out, quad, kind };
}
// Szene ohne Dokument
function makeEmpty(seed) { const s = makeScene(seed, ['wood', 'carpet', 'cloth', 'tiles', 'dark', 'light'][seed % 6]); return s; }

async function bench(detector, seeds) {
  const res = [];
  for (const seed of seeds) {
    const { canvas, quad, kind } = makeScene(seed);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
    const img = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0);
    const t0 = performance.now();
    const q = detector(c);
    const ms = performance.now() - t0;
    const diag = Math.hypot(c.width, c.height);
    let err = null;
    if (q) err = Math.max(...q.map((p, i) => Math.hypot(p[0] * c.width - quad[i][0], p[1] * c.height - quad[i][1]))) / diag * 100;
    res.push({ seed, kind, found: !!q, err, ms });
  }
  return res;
}
