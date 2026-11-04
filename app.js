'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const MAX_DIM = 3000;
  const A4W = 595.28, A4H = 841.89;
  const QUALITY = {
    high: { dim: 3000, q: 0.9 },
    medium: { dim: 2000, q: 0.78 },
    low: { dim: 1400, q: 0.62 },
  };
  const FILTERS = [
    ['document', 'Dokument'],
    ['original', 'Original'],
    ['gray', 'Graustufen'],
    ['bw', 'S/W'],
  ];

  // ---------- Einstellungen ----------
  const DEFAULTS = { filter: 'document', autoCrop: true, autoPdf: true, format: 'a4', quality: 'medium' };
  const settings = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('dokscan.settings') || '{}') }; }
    catch { return { ...DEFAULTS }; }
  })();
  const saveSettings = () => { try { localStorage.setItem('dokscan.settings', JSON.stringify(settings)); } catch { /* egal */ } };

  // ---------- Speicher (IndexedDB, optional) ----------
  const DB = (() => {
    let dbp = null;
    const open = () => {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          const r = indexedDB.open('dokscan', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('pages', { keyPath: 'id' });
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        }).catch(() => null);
      }
      return dbp;
    };
    const run = async (mode, fn) => {
      try {
        const db = await open();
        if (!db) return undefined;
        return await new Promise((resolve, reject) => {
          const t = db.transaction('pages', mode);
          const req = fn(t.objectStore('pages'));
          t.oncomplete = () => resolve(req && req.result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        });
      } catch (e) { console.warn('Speichern nicht möglich', e); return undefined; }
    };
    return {
      all: () => run('readonly', (s) => s.getAll()),
      put: (rec) => run('readwrite', (s) => s.put(rec)),
      del: (id) => run('readwrite', (s) => s.delete(id)),
      clear: () => run('readwrite', (s) => s.clear()),
    };
  })();

  // ---------- Zustand ----------
  /** @type {Array<any>} */
  let pages = [];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const record = (p, order) => ({
    id: p.id, order, created: p.created, original: p.original,
    rotation: p.rotation, corners: p.corners, filter: p.filter,
    processed: p.processed, pw: p.pw, ph: p.ph, thumb: p.thumb,
  });
  const persist = (p) => { const i = pages.indexOf(p); if (i >= 0) DB.put(record(p, i)); };
  const persistAll = () => pages.forEach(persist);

  function urlFor(p, key) {
    const blob = p[key];
    const cache = key + 'Url';
    if (!blob) return null;
    if (!p[cache] || p[cache + 'Of'] !== blob) {
      if (p[cache]) URL.revokeObjectURL(p[cache]);
      p[cache] = URL.createObjectURL(blob);
      p[cache + 'Of'] = blob;
    }
    return p[cache];
  }
  function dropUrls(p) {
    for (const k of ['thumbUrl', 'processedUrl']) if (p[k]) URL.revokeObjectURL(p[k]);
  }

  // ---------- Verarbeitung (Warteschlange) ----------
  const queue = [];
  let busy = false;
  let idleWaiters = [];
  const whenIdle = () => (!busy && !queue.length ? Promise.resolve() : new Promise((r) => idleWaiters.push(r)));
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function schedule(p) {
    p.rev = (p.rev || 0) + 1;
    p.pending = true;
    if (!queue.includes(p)) queue.push(p);
    renderCard(p);
    if (editor.page === p) updatePreview();
    runQueue();
  }

  async function runQueue() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const p = queue.shift();
      if (!pages.includes(p)) continue;
      const rev = p.rev;
      await tick();
      try {
        const result = await processPage(p);
        if (p.rev !== rev) continue; // wurde inzwischen geändert und neu eingereiht
        Object.assign(p, result, { pending: false, error: false });
      } catch (e) {
        console.error(e);
        if (p.rev === rev) { p.pending = false; p.error = true; }
      }
      renderCard(p);
      if (editor.page === p) updatePreview();
      persist(p);
    }
    busy = false;
    idleWaiters.splice(0).forEach((r) => r());
  }

  async function processPage(p) {
    const img = await Img.load(p.original);
    let c = Img.draw(img, MAX_DIM);
    const r = Img.rotate(c, p.rotation);
    if (r !== c) { Img.release(c); c = r; }
    if (!Img.isFull(p.corners)) {
      const w = Img.warp(c, p.corners, MAX_DIM);
      Img.release(c); c = w;
    }
    Img.filter(c, p.filter);
    const processed = await Img.toBlob(c, 'image/jpeg', 0.9);
    const t = Img.draw(c, 420);
    const thumb = await Img.toBlob(t, 'image/jpeg', 0.8);
    const res = { processed, thumb, pw: c.width, ph: c.height };
    Img.release(t); Img.release(c);
    return res;
  }

  async function addFromCanvas(c, hint) {
    let corners = Img.FULL.map((x) => x.slice());
    if (settings.autoCrop) {
      try { corners = Img.detect(c) || hint || corners; } catch (e) { console.warn(e); }
    }
    const original = await Img.toBlob(c, 'image/jpeg', 0.92);
    const p = { id: uid(), created: Date.now(), original, rotation: 0, corners, filter: settings.filter, processed: null, thumb: null };
    pages.push(p);
    renderGrid();
    persist(p);
    schedule(p);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return p;
  }

  async function addFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name));
    if (!list.length) return 0;
    let ok = 0;
    for (const f of list) {
      try {
        const img = await Img.load(f);
        const c = Img.draw(img, MAX_DIM);
        await addFromCanvas(c);
        Img.release(c);
        ok++;
      } catch (e) {
        console.error(e);
        toast(`„${f.name}“ konnte nicht gelesen werden.`);
      }
    }
    return ok;
  }

  // ---------- Übersicht ----------
  const grid = $('#pageGrid');

  function renderGrid() {
    grid.textContent = '';
    pages.forEach((p, i) => grid.appendChild(makeCard(p, i)));
    const n = pages.length;
    $('#empty').hidden = n > 0;
    $('#gridHint').hidden = n < 2;
    $('#btnPdf').disabled = n === 0;
    $('#btnNew').hidden = n === 0;
    $('#docInfo').textContent = n === 0 ? 'Keine Seiten' : n === 1 ? '1 Seite' : `${n} Seiten`;
  }

  function makeCard(p, i) {
    const li = document.createElement('li');
    li.className = 'card';
    li.dataset.id = p.id;
    li.innerHTML =
      `<button class="card-open" type="button"><img alt=""><span class="spinner"></span><span class="card-err">Fehler</span></button>` +
      `<span class="card-num"></span>` +
      `<span class="drag" role="button" tabindex="-1" aria-label="Verschieben"><svg class="ic"><use href="#i-grip"/></svg></span>`;
    fillCard(li, p, i);
    return li;
  }

  function fillCard(li, p, i) {
    li.querySelector('.card-num').textContent = String(i + 1);
    li.querySelector('.card-open').setAttribute('aria-label', `Seite ${i + 1} bearbeiten`);
    const url = urlFor(p, 'thumb');
    const img = li.querySelector('img');
    if (url && img.getAttribute('src') !== url) img.src = url;
    img.hidden = !url;
    li.classList.toggle('loading', !!p.pending);
    li.classList.toggle('error', !!p.error);
  }

  function renderCard(p) {
    const li = grid.querySelector(`li[data-id="${p.id}"]`);
    if (li) fillCard(li, p, pages.indexOf(p));
  }

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.card-open');
    if (!btn) return;
    const p = pages.find((x) => x.id === btn.closest('li').dataset.id);
    if (p) openEditor(p);
  });

  // Umsortieren per Ziehen am Griff
  grid.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag');
    if (!handle) return;
    e.preventDefault();
    const li = handle.closest('li');
    li.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    const main = $('#overview');
    let lastY = e.clientY;
    let scrollTimer = null;
    const autoScroll = () => {
      const r = main.getBoundingClientRect();
      const edge = 70;
      let dy = 0;
      if (lastY < r.top + edge) dy = -12; else if (lastY > r.bottom - edge) dy = 12;
      if (dy) main.scrollTop += dy;
    };
    scrollTimer = setInterval(autoScroll, 16);
    const move = (ev) => {
      lastY = ev.clientY;
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = el && el.closest('#pageGrid > li');
      if (!target || target === li) return;
      const items = [...grid.children];
      if (items.indexOf(li) < items.indexOf(target)) target.after(li); else target.before(li);
    };
    const end = () => {
      clearInterval(scrollTimer);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      li.classList.remove('dragging');
      const order = [...grid.children].map((x) => x.dataset.id);
      const changed = order.some((id, i) => pages[i].id !== id);
      if (changed) {
        pages = order.map((id) => pages.find((p) => p.id === id));
        persistAll();
      }
      [...grid.children].forEach((x, i) => fillCard(x, pages[i], i));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });

  // ---------- Bildschirme & Zurück-Taste ----------
  let screen = null;
  function openScreen(name) {
    if (screen) closeScreenNow(screen);
    screen = name;
    $('#' + name).hidden = false;
    document.body.classList.add('screen-open');
    try { history.pushState({ screen: name }, ''); } catch { /* egal */ }
  }
  function closeScreen() {
    if (!screen) return;
    if (history.state && history.state.screen === screen) history.back();
    else { const s = screen; screen = null; closeScreenNow(s); }
  }
  function closeScreenNow(name) {
    $('#' + name).hidden = true;
    document.body.classList.remove('screen-open');
    if (name === 'camera') onCameraClosed();
    if (name === 'editor') onEditorClosed();
  }
  window.addEventListener('popstate', () => {
    if (!screen) return;
    const s = screen;
    screen = null;
    closeScreenNow(s);
  });

  // ---------- Kamera ----------
  const video = $('#video');
  const cam = { stream: null, track: null, added: 0, torch: false, done: false, shooting: false };

  function setCamMsg(text, showFallback) {
    $('#camMsg').hidden = !text;
    $('#camMsgText').textContent = text || '';
    $('#camFallback').hidden = !showFallback;
  }

  function updateCamUi() {
    $('#camDone').disabled = cam.added === 0;
    $('#camCount').textContent = String(cam.added);
    $('#camLast').hidden = cam.added === 0;
    const page = `Seite ${pages.length + 1}`;
    $('#camHint').textContent = !settings.autoCrop ? page : live.quad ? `${page} · Rand erkannt` : `${page} · Dokument suchen …`;
  }

  // Live-Randerkennung im Kamerabild
  const live = { timer: null, quad: null, miss: 0 };
  function startLive() {
    stopLive();
    if (settings.autoCrop) live.timer = setInterval(liveTick, 250);
  }
  function stopLive() {
    clearInterval(live.timer);
    live.timer = null;
    live.quad = null;
    live.miss = 0;
    drawLive();
  }
  function liveTick() {
    if (!video.videoWidth || cam.shooting || document.hidden) return;
    let q = null;
    try { q = Img.detect(video, 160); } catch { q = null; }
    if (q) {
      live.miss = 0;
      live.quad = live.quad ? live.quad.map((p, i) => [p[0] * 0.4 + q[i][0] * 0.6, p[1] * 0.4 + q[i][1] * 0.6]) : q;
    } else if (++live.miss > 3) {
      live.quad = null;
    }
    drawLive();
  }
  function drawLive() {
    const svg = $('#camQuad'), poly = $('#camQuadPoly');
    const found = !!live.quad && !!video.videoWidth;
    $('#camera').classList.toggle('doc-found', found);
    updateCamUi();
    if (!found) { poly.removeAttribute('points'); return; }
    const r = svg.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(r.width / vw, r.height / vh);
    const ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
    svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    poly.setAttribute('points', live.quad.map(([x, y]) => `${(ox + x * vw * s).toFixed(1)},${(oy + y * vh * s).toFixed(1)}`).join(' '));
  }

  async function startStream() {
    stopStream();
    setCamMsg('Kamera wird gestartet …', false);
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
      });
    } catch (e) {
      console.warn(e);
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setCamMsg(denied
        ? 'Kein Zugriff auf die Kamera. Erlaube den Zugriff in den Browser-Einstellungen oder nutze die Kamera-App.'
        : 'Die Kamera konnte nicht gestartet werden. Du kannst stattdessen die Kamera-App verwenden.', true);
      return;
    }
    if (screen !== 'camera') { stopStream(); return; }
    cam.track = cam.stream.getVideoTracks()[0];
    video.srcObject = cam.stream;
    try { await video.play(); } catch { /* autoplay */ }
    setCamMsg('', false);
    startLive();
    const caps = cam.track && cam.track.getCapabilities ? cam.track.getCapabilities() : {};
    $('#camTorch').hidden = !caps.torch;
    cam.torch = false;
    $('#camTorch').setAttribute('aria-pressed', 'false');
  }

  function stopStream() {
    stopLive();
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    cam.track = null;
    video.srcObject = null;
  }

  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#fileCapture').click();
      return;
    }
    cam.added = 0;
    cam.done = false;
    updateCamUi();
    openScreen('camera');
    startStream();
  }

  function onCameraClosed() {
    stopStream();
    const auto = cam.done && cam.added > 0 && settings.autoPdf;
    cam.added = 0;
    if (auto) setTimeout(() => openPdf(true), 50);
  }

  async function shoot() {
    if (!video.videoWidth || cam.shooting) return;
    cam.shooting = true;
    const flash = $('#camFlash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    if (navigator.vibrate) navigator.vibrate(15);
    try {
      const c = Img.draw(video, MAX_DIM);
      const t = Img.draw(c, 160);
      const img = $('#camLast img');
      img.src = t.toDataURL('image/jpeg', 0.7);
      Img.release(t);
      cam.added++;
      updateCamUi();
      await addFromCanvas(c, live.quad && live.quad.map((p) => p.slice()));
      Img.release(c);
      updateCamUi();
    } catch (e) {
      console.error(e);
      toast('Aufnahme fehlgeschlagen.');
    } finally {
      cam.shooting = false;
    }
  }

  $('#btnScan').addEventListener('click', openCamera);
  $('#camShutter').addEventListener('click', shoot);
  $('#camClose').addEventListener('click', () => { cam.done = false; closeScreen(); });
  $('#camDone').addEventListener('click', () => { cam.done = true; closeScreen(); });
  $('#camLast').addEventListener('click', () => { cam.done = false; closeScreen(); });
  $('#camFallback').addEventListener('click', () => { cam.done = false; closeScreen(); $('#fileCapture').click(); });
  $('#camTorch').addEventListener('click', async () => {
    if (!cam.track) return;
    try {
      cam.torch = !cam.torch;
      await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] });
      $('#camTorch').setAttribute('aria-pressed', String(cam.torch));
    } catch { cam.torch = false; toast('Licht wird nicht unterstützt.'); }
  });
  document.addEventListener('keydown', (e) => {
    if (screen === 'camera' && (e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); shoot(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (screen !== 'camera') return;
    if (document.hidden) stopStream(); else startStream();
  });

  $('#fileCapture').addEventListener('change', async (e) => {
    const n = await addFiles(e.target.files);
    e.target.value = '';
    if (n) toast('Seite hinzugefügt. Tippe auf „Scannen“ für die nächste.');
  });
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (e) => {
    const n = await addFiles(e.target.files);
    e.target.value = '';
    if (n) toast(n === 1 ? '1 Bild importiert.' : `${n} Bilder importiert.`);
  });

  // ---------- Editor ----------
  const editor = { page: null, crop: null };

  function buildChips(container, current, onPick) {
    container.textContent = '';
    for (const [key, label] of FILTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.value = key;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(key === current));
      b.textContent = label;
      b.addEventListener('click', () => onPick(key));
      container.appendChild(b);
    }
  }
  const markChips = (container, value) => container.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === value)));

  function openEditor(p) {
    editor.page = p;
    buildChips($('#filterChips'), p.filter, (f) => {
      if (editor.page.filter === f) return;
      editor.page.filter = f;
      markChips($('#filterChips'), f);
      schedule(editor.page);
    });
    openScreen('editor');
    showCropUi(false);
    updateEditor();
  }

  function updateEditor() {
    const p = editor.page;
    if (!p) return;
    const i = pages.indexOf(p);
    $('#edTitle').textContent = `Seite ${i + 1} von ${pages.length}`;
    $('#edMovePrev').disabled = i <= 0;
    $('#edMoveNext').disabled = i >= pages.length - 1;
    markChips($('#filterChips'), p.filter);
    updatePreview();
  }

  function updatePreview() {
    const p = editor.page;
    if (!p) return;
    const url = urlFor(p, 'processed');
    const img = $('#edPreview');
    if (url && img.getAttribute('src') !== url) img.src = url;
    img.hidden = !url;
    $('#edSpinner').hidden = !p.pending;
    $('#edPreviewWrap').classList.toggle('busy', !!p.pending);
  }

  function onEditorClosed() {
    if (editor.crop) endCrop();
    editor.page = null;
  }

  function movePage(delta) {
    const p = editor.page;
    const i = pages.indexOf(p), j = i + delta;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    persistAll();
    renderGrid();
    updateEditor();
    toast(`Jetzt Seite ${j + 1}`);
  }

  function rotatePage(steps) {
    const p = editor.page;
    for (let k = 0; k < ((steps % 4) + 4) % 4; k++) p.corners = Img.rotateCornersCW(p.corners);
    p.rotation = (((p.rotation + steps * 90) % 360) + 360) % 360;
    schedule(p);
  }

  $('#edBack').addEventListener('click', closeScreen);
  $('#edMovePrev').addEventListener('click', () => movePage(-1));
  $('#edMoveNext').addEventListener('click', () => movePage(1));
  $('#edRotL').addEventListener('click', () => rotatePage(-1));
  $('#edRotR').addEventListener('click', () => rotatePage(1));
  $('#edDelete').addEventListener('click', () => {
    const p = editor.page;
    if (!p || !confirm(`Seite ${pages.indexOf(p) + 1} löschen?`)) return;
    pages = pages.filter((x) => x !== p);
    DB.del(p.id);
    persistAll();
    dropUrls(p);
    renderGrid();
    closeScreen();
  });

  // ---------- Zuschnitt ----------
  const cropCanvas = $('#cropCanvas');
  const cropWrap = $('#cropWrap');
  const loupe = $('#loupe');

  function showCropUi(on) {
    $('#edPreviewWrap').hidden = on;
    cropWrap.hidden = !on;
    $('#edTools').hidden = on;
    $('#cropTools').hidden = !on;
  }

  async function startCrop() {
    const p = editor.page;
    if (!p) return;
    try {
      const img = await Img.load(p.original);
      const base = Img.draw(img, 1600);
      const c = Img.rotate(base, p.rotation);
      if (c !== base) Img.release(base);
      cropCanvas.width = c.width;
      cropCanvas.height = c.height;
      cropCanvas.getContext('2d').drawImage(c, 0, 0);
      Img.release(c);
      editor.crop = { corners: p.corners.map((x) => x.slice()), dw: 0, dh: 0, drag: -1 };
      showCropUi(true);
      layoutCrop();
    } catch (e) {
      console.error(e);
      toast('Bild konnte nicht geladen werden.');
    }
  }

  function endCrop() {
    editor.crop = null;
    showCropUi(false);
    loupe.hidden = true;
  }

  function layoutCrop() {
    const cr = editor.crop;
    if (!cr) return;
    const r = $('#edStage').getBoundingClientRect();
    const pad = 22;
    const s = Math.min((r.width - 2 * pad) / cropCanvas.width, (r.height - 2 * pad) / cropCanvas.height);
    cr.dw = Math.max(1, cropCanvas.width * s);
    cr.dh = Math.max(1, cropCanvas.height * s);
    cr.scale = s;
    cropWrap.style.width = cr.dw + 'px';
    cropWrap.style.height = cr.dh + 'px';
    $('#cropSvg').setAttribute('viewBox', `0 0 ${cr.dw} ${cr.dh}`);
    drawCrop();
  }

  function drawCrop() {
    const cr = editor.crop;
    if (!cr) return;
    const pts = cr.corners.map(([x, y]) => [x * cr.dw, y * cr.dh]);
    const poly = pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
    $('#cropEdge').setAttribute('points', poly);
    $('#cropShade').setAttribute('d', `M0 0H${cr.dw}V${cr.dh}H0Z M${pts.map((p) => p.join(' ')).join(' L')}Z`);
    const g = $('#cropHandles');
    if (g.childElementCount !== 4) {
      g.innerHTML = '<circle r="13"/><circle r="13"/><circle r="13"/><circle r="13"/>';
    }
    [...g.children].forEach((c, i) => {
      c.setAttribute('cx', pts[i][0]);
      c.setAttribute('cy', pts[i][1]);
      c.classList.toggle('active', i === cr.drag);
    });
    cropWrap.classList.toggle('invalid', !Img.isConvex(cr.corners));
  }

  function drawLoupe(nx, ny, clientX, clientY) {
    const size = 120;
    const zoom = 2.5;
    const cx = nx * cropCanvas.width, cy = ny * cropCanvas.height;
    const R = size / 2 / (editor.crop.scale * zoom);
    const lc = loupe.getContext('2d');
    const k = loupe.width / size;
    lc.save();
    lc.clearRect(0, 0, loupe.width, loupe.height);
    lc.fillStyle = '#000';
    lc.fillRect(0, 0, loupe.width, loupe.height);
    lc.imageSmoothingEnabled = true;
    lc.drawImage(cropCanvas, cx - R, cy - R, 2 * R, 2 * R, 0, 0, loupe.width, loupe.height);
    lc.strokeStyle = 'rgba(255,255,255,.95)';
    lc.lineWidth = 1.5 * k;
    lc.beginPath();
    lc.moveTo(loupe.width / 2, loupe.height / 2 - 14 * k); lc.lineTo(loupe.width / 2, loupe.height / 2 + 14 * k);
    lc.moveTo(loupe.width / 2 - 14 * k, loupe.height / 2); lc.lineTo(loupe.width / 2 + 14 * k, loupe.height / 2);
    lc.stroke();
    lc.restore();
    const wr = cropWrap.getBoundingClientRect();
    const lx = clientX - wr.left - size / 2;
    let ly = clientY - wr.top - size - 56;
    if (clientY - size - 56 < 8) ly = clientY - wr.top + 56;
    loupe.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
    loupe.hidden = false;
  }

  cropWrap.addEventListener('pointerdown', (e) => {
    const cr = editor.crop;
    if (!cr) return;
    const r = cropWrap.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best = -1, bestD = Infinity;
    cr.corners.forEach(([x, y], i) => {
      const d = Math.hypot(x * cr.dw - px, y * cr.dh - py);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (bestD > 64) return;
    e.preventDefault();
    cropWrap.setPointerCapture(e.pointerId);
    cr.drag = best;
    cr.offX = cr.corners[best][0] * cr.dw - px;
    cr.offY = cr.corners[best][1] * cr.dh - py;
    drawCrop();
    drawLoupe(cr.corners[best][0], cr.corners[best][1], e.clientX + cr.offX, e.clientY + cr.offY);
  });
  cropWrap.addEventListener('pointermove', (e) => {
    const cr = editor.crop;
    if (!cr || cr.drag < 0) return;
    const r = cropWrap.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (e.clientX - r.left + cr.offX) / cr.dw));
    const ny = Math.min(1, Math.max(0, (e.clientY - r.top + cr.offY) / cr.dh));
    cr.corners[cr.drag] = [nx, ny];
    drawCrop();
    drawLoupe(nx, ny, r.left + nx * cr.dw, r.top + ny * cr.dh);
  });
  const endDrag = () => {
    const cr = editor.crop;
    if (!cr) return;
    cr.drag = -1;
    loupe.hidden = true;
    drawCrop();
  };
  cropWrap.addEventListener('pointerup', endDrag);
  cropWrap.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', layoutCrop);

  $('#edCrop').addEventListener('click', startCrop);
  $('#cropCancel').addEventListener('click', endCrop);
  $('#cropFull').addEventListener('click', () => { editor.crop.corners = Img.FULL.map((x) => x.slice()); drawCrop(); });
  $('#cropAuto').addEventListener('click', () => {
    const q = Img.detect(cropCanvas);
    if (q) { editor.crop.corners = q; drawCrop(); }
    else toast('Kein Dokumentrand erkannt – bitte Ecken manuell setzen.');
  });
  $('#cropApply').addEventListener('click', () => {
    const cr = editor.crop;
    if (!Img.isConvex(cr.corners)) { toast('Die Ecken bilden kein gültiges Viereck.'); return; }
    const p = editor.page;
    p.corners = cr.corners.map((x) => x.slice());
    endCrop();
    schedule(p);
  });

  // ---------- PDF ----------
  const pdfDialog = $('#pdfDialog');
  const pdfState = { blob: null, url: null, busy: false };

  function defaultName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `Scan_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  }
  function fileName() {
    const raw = ($('#pdfName').value || '').trim().replace(/\.pdf$/i, '');
    const clean = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120);
    return (clean || defaultName()) + '.pdf';
  }
  function fmtSize(b) {
    if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
    return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  }
  function setRadio(name, value) {
    pdfDialog.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.checked = r.value === value; });
  }
  const getRadio = (name) => (pdfDialog.querySelector(`input[name="${name}"]:checked`) || {}).value;

  function resetPdfResult() {
    if (pdfState.url) URL.revokeObjectURL(pdfState.url);
    pdfState.blob = null;
    pdfState.url = null;
    $('#pdfResult').hidden = true;
    $('#pdfGenerate').hidden = false;
    $('#pdfError').hidden = true;
  }

  function openPdf(auto) {
    if (!pages.length) return;
    resetPdfResult();
    $('#pdfName').value = defaultName();
    setRadio('format', settings.format);
    setRadio('quality', settings.quality);
    $('#pdfProgress').hidden = true;
    if (!pdfDialog.open) pdfDialog.showModal();
    if (auto) generatePdf();
  }

  async function buildPdf(format, qualityKey, onProgress) {
    const preset = QUALITY[qualityKey] || QUALITY.medium;
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      onProgress(i, pages.length);
      await tick();
      if (!p.processed) throw new Error(`Seite ${i + 1} konnte nicht verarbeitet werden.`);
      let blob = p.processed, w = p.pw, h = p.ph;
      if (Math.max(w, h) > preset.dim || preset.q < 0.9) {
        const img = await Img.load(p.processed);
        const c = Img.draw(img, preset.dim);
        w = c.width; h = c.height;
        blob = await Img.toBlob(c, 'image/jpeg', preset.q);
        Img.release(c);
      }
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      let pageW, pageH;
      if (format === 'image') {
        const k = A4H / Math.max(w, h);
        pageW = w * k; pageH = h * k;
      } else {
        const portrait = h >= w;
        pageW = portrait ? A4W : A4H;
        pageH = portrait ? A4H : A4W;
      }
      const s = Math.min(pageW / w, pageH / h);
      const iw = w * s, ih = h * s;
      out.push({ jpeg, pageWidth: pageW, pageHeight: pageH, x: (pageW - iw) / 2, y: (pageH - ih) / 2, w: iw, h: ih });
    }
    onProgress(pages.length, pages.length);
    return PDFWriter.build(out, { title: fileName().replace(/\.pdf$/, ''), producer: 'DokScan' });
  }

  async function generatePdf() {
    if (pdfState.busy) return;
    pdfState.busy = true;
    resetPdfResult();
    settings.format = getRadio('format') || 'a4';
    settings.quality = getRadio('quality') || 'medium';
    saveSettings();
    $('#pdfGenerate').disabled = true;
    $('#pdfProgress').hidden = false;
    const bar = $('#pdfProgressBar');
    const text = $('#pdfProgressText');
    bar.style.width = '0%';
    try {
      if (busy || queue.length) {
        text.textContent = 'Seiten werden noch bearbeitet …';
        await whenIdle();
      }
      const blob = await buildPdf(settings.format, settings.quality, (i, n) => {
        bar.style.width = `${Math.round((i / n) * 100)}%`;
        text.textContent = i < n ? `Seite ${i + 1} von ${n} …` : 'PDF wird zusammengefügt …';
      });
      pdfState.blob = blob;
      pdfState.url = URL.createObjectURL(blob);
      $('#pdfResName').textContent = fileName();
      $('#pdfResMeta').textContent = `${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} · ${fmtSize(blob.size)}`;
      $('#pdfShare').hidden = !canShareFile(blob);
      $('#pdfResult').hidden = false;
      $('#pdfGenerate').hidden = true;
    } catch (e) {
      console.error(e);
      $('#pdfError').textContent = e.message || 'PDF konnte nicht erstellt werden.';
      $('#pdfError').hidden = false;
    } finally {
      $('#pdfProgress').hidden = true;
      $('#pdfGenerate').disabled = false;
      pdfState.busy = false;
    }
  }

  function pdfFile(blob) {
    try { return new File([blob], fileName(), { type: 'application/pdf' }); } catch { return null; }
  }
  function canShareFile(blob) {
    const f = pdfFile(blob);
    try { return !!(f && navigator.canShare && navigator.canShare({ files: [f] })); } catch { return false; }
  }

  $('#btnPdf').addEventListener('click', () => openPdf(false));
  $('#pdfGenerate').addEventListener('click', generatePdf);
  pdfDialog.addEventListener('change', (e) => { if (e.target.type === 'radio' && pdfState.blob) resetPdfResult(); });
  $('#pdfName').addEventListener('input', () => { if (pdfState.blob) $('#pdfResName').textContent = fileName(); });
  $('#pdfShare').addEventListener('click', async () => {
    const f = pdfFile(pdfState.blob);
    if (!f) return;
    try { await navigator.share({ files: [f], title: f.name }); }
    catch (e) { if (e && e.name !== 'AbortError') toast('Teilen nicht möglich – nutze „Speichern“.'); }
  });
  $('#pdfDownload').addEventListener('click', () => {
    if (!pdfState.url) return;
    const a = document.createElement('a');
    a.href = pdfState.url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  $('#pdfOpen').addEventListener('click', () => {
    if (!pdfState.url) return;
    const w = window.open(pdfState.url, '_blank');
    if (!w) location.href = pdfState.url;
  });
  pdfDialog.addEventListener('click', (e) => { if (e.target === pdfDialog) pdfDialog.close(); });

  // ---------- Einstellungen ----------
  const setDialog = $('#settingsDialog');
  $('#btnSettings').addEventListener('click', () => {
    buildChips($('#setFilter'), settings.filter, (f) => { settings.filter = f; saveSettings(); markChips($('#setFilter'), f); });
    $('#setAutoCrop').checked = settings.autoCrop;
    $('#setAutoPdf').checked = settings.autoPdf;
    $('#setClear').disabled = pages.length === 0;
    setDialog.showModal();
  });
  $('#setAutoCrop').addEventListener('change', (e) => { settings.autoCrop = e.target.checked; saveSettings(); });
  $('#setAutoPdf').addEventListener('change', (e) => { settings.autoPdf = e.target.checked; saveSettings(); });
  setDialog.addEventListener('click', (e) => { if (e.target === setDialog) setDialog.close(); });

  async function clearAll() {
    if (!pages.length) return false;
    if (!confirm(`Alle ${pages.length} Seiten löschen und ein neues Dokument beginnen?`)) return false;
    pages.forEach(dropUrls);
    pages = [];
    queue.length = 0;
    await DB.clear();
    renderGrid();
    return true;
  }
  $('#setClear').addEventListener('click', async () => { if (await clearAll()) setDialog.close(); });
  $('#btnNew').addEventListener('click', clearAll);

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // Bilder per Drag & Drop (Desktop)
  document.addEventListener('dragover', (e) => { if (!screen) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    if (screen || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const n = await addFiles(e.dataTransfer.files);
    if (n) toast(n === 1 ? '1 Bild importiert.' : `${n} Bilder importiert.`);
  });

  // ---------- Start ----------
  async function init() {
    renderGrid();
    const recs = await DB.all();
    if (Array.isArray(recs) && recs.length) {
      recs.sort((a, b) => a.order - b.order);
      pages = recs.map((r) => ({ ...r, pending: false, error: false }));
      renderGrid();
      pages.filter((p) => !p.processed || !p.thumb).forEach(schedule);
    }
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  init();

  // Für Tests
  window.DokScan = { get pages() { return pages; }, whenIdle, addFiles, buildPdf, settings };
})();
