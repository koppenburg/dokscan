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
  const IS_IPAD = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const DEFAULTS = { filter: 'document', autoCrop: true, autoPdf: true, format: 'a4', quality: 'medium', wideFov: IS_IPAD, camDevice: '', zoom: null, autoShoot: true, ocr: true };
  const settings = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('dokscan.settings') || '{}') }; }
    catch { return { ...DEFAULTS }; }
  })();
  const saveSettings = () => { try { localStorage.setItem('dokscan.settings', JSON.stringify(settings)); } catch { /* egal */ } };

  // ---------- Speicher (IndexedDB, optional) ----------
  // Stores: "docs" (Dokumente der Ablage) und "pages" (Seiten, Index docId)
  const LEGACY_DOC = 'doc-legacy';
  const DB = (() => {
    let dbp = null;
    const open = () => {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          const r = indexedDB.open('dokscan', 2);
          r.onupgradeneeded = (e) => {
            const db = r.result;
            const tx = r.transaction;
            const pagesStore = e.oldVersion < 1 ? db.createObjectStore('pages', { keyPath: 'id' }) : tx.objectStore('pages');
            if (e.oldVersion < 2) {
              const docs = db.createObjectStore('docs', { keyPath: 'id' });
              pagesStore.createIndex('docId', 'docId');
              // Bisherige Seiten (aus der Version ohne Ablage) in ein Dokument übernehmen
              let count = 0, first = Infinity;
              pagesStore.openCursor().onsuccess = (ev) => {
                const cur = ev.target.result;
                if (cur) {
                  const v = cur.value;
                  v.docId = LEGACY_DOC;
                  if (v.created < first) first = v.created;
                  count++;
                  cur.update(v);
                  cur.continue();
                } else if (count) {
                  const t = isFinite(first) ? first : Date.now();
                  docs.put({ id: LEGACY_DOC, name: docDefaultName(t), created: t, updated: Date.now(), pageCount: count, thumb: null, text: '', named: false });
                }
              };
            }
          };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        }).catch(() => null);
      }
      return dbp;
    };
    const run = async (store, mode, fn) => {
      try {
        const db = await open();
        if (!db) return undefined;
        return await new Promise((resolve, reject) => {
          const t = db.transaction(store, mode);
          const req = fn(t.objectStore(store));
          t.oncomplete = () => resolve(req && req.result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        });
      } catch (e) { console.warn('Speichern nicht möglich', e); return undefined; }
    };
    return {
      pagesOf: (docId) => run('pages', 'readonly', (s) => s.index('docId').getAll(docId)),
      put: (rec) => run('pages', 'readwrite', (s) => s.put(rec)),
      del: (id) => run('pages', 'readwrite', (s) => s.delete(id)),
      delPagesOf: (docId) => run('pages', 'readwrite', (s) => {
        s.index('docId').openKeyCursor(IDBKeyRange.only(docId)).onsuccess = (ev) => {
          const cur = ev.target.result;
          if (cur) { s.delete(cur.primaryKey); cur.continue(); }
        };
      }),
      docs: () => run('docs', 'readonly', (s) => s.getAll()),
      putDoc: (doc) => run('docs', 'readwrite', (s) => s.put(doc)),
      delDoc: (id) => run('docs', 'readwrite', (s) => s.delete(id)),
    };
  })();

  function docDefaultName(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `Scan ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- Zustand ----------
  /** @type {Array<any>} */
  let pages = [];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const record = (p) => ({
    id: p.id, docId: p.docId, order: p.order, created: p.created, original: p.original,
    rotation: p.rotation, corners: p.corners, filter: p.filter, autoDetect: !!(p.autoDetect && !p.processed),
    processed: p.processed, pw: p.pw, ph: p.ph, thumb: p.thumb, procKey: p.procKey, ocr: p.ocr,
  });
  const persist = (p) => {
    if (p.deleted || !p.docId) return;
    DB.put(record(p));
    touchDoc(p.docId);
  };
  /** Reihenfolge der Seiten des offenen Dokuments übernehmen und speichern. */
  const persistAll = () => pages.forEach((p, i) => { p.order = i; persist(p); });

  // ---------- Ablage (Dokumente) ----------
  let docs = [];            // Metadaten aller Dokumente
  let currentDoc = null;    // geöffnetes Dokument (oder das, in das gerade gescannt wird)

  function newDoc() {
    const t = Date.now();
    const d = { id: 'doc-' + uid(), name: docDefaultName(t), created: t, updated: t, pageCount: 0, thumb: null, text: '', named: false };
    docs.push(d);
    DB.putDoc(d);
    return d;
  }

  const docTimers = new Map();
  /** Metadaten (Seitenzahl, Vorschau, Suchtext) eines Dokuments verzögert aktualisieren. */
  function touchDoc(docId) {
    clearTimeout(docTimers.get(docId));
    docTimers.set(docId, setTimeout(() => { docTimers.delete(docId); refreshDocMeta(docId); }, 400));
  }
  async function refreshDocMeta(docId) {
    const d = docs.find((x) => x.id === docId);
    if (!d) return;
    let list;
    if (currentDoc && currentDoc.id === docId) list = pages;
    else list = ((await DB.pagesOf(docId)) || []).map((r) => inflight.get(r.id) || r).sort((a, b) => a.order - b.order);
    list = list.filter((p) => !p.deleted);
    d.pageCount = list.length;
    d.thumb = (list[0] && list[0].thumb) || null;
    d.text = list.map((p) => (p.ocr && p.ocr.text) || '').filter(Boolean).join('\n\n');
    d.updated = Date.now();
    if (docs.includes(d)) DB.putDoc(d);
    renderLibrary();
    if (currentDoc === d) renderDocHeader();
  }

  const norm = (s) => (s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  function fmtDate(t) {
    const d = new Date(t), now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `heute, ${time}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `gestern, ${time}`;
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }
  /** Text mit hervorgehobenem Suchbegriff als DOM-Knoten (kein innerHTML). */
  function highlight(el, text, q) {
    el.textContent = '';
    if (!q) { el.textContent = text; return; }
    const nt = norm(text);
    let i = 0;
    // norm() verändert die Länge nur bei ß – für die Anzeige ausreichend genau
    for (;;) {
      const j = nt.indexOf(q, i);
      if (j < 0 || nt.length !== text.length) { el.append(text.slice(i)); break; }
      el.append(text.slice(i, j));
      const m = document.createElement('mark');
      m.textContent = text.slice(j, j + q.length);
      el.append(m);
      i = j + q.length;
    }
  }
  function snippet(text, q) {
    const nt = norm(text);
    const j = nt.indexOf(q);
    if (j < 0) return '';
    const a = Math.max(0, j - 40), b = Math.min(text.length, j + q.length + 60);
    return (a > 0 ? '… ' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? ' …' : '');
  }

  const docList = $('#docList');
  const libThumbs = new Map(); // docId → { blob, url }
  function renderLibrary() {
    const q = norm($('#libSearch').value.trim());
    const sorted = docs.slice().sort((a, b) => b.updated - a.updated);
    docList.textContent = '';
    let shown = 0;
    for (const d of sorted) {
      let snip = '';
      if (q) {
        const inName = norm(d.name).includes(q);
        snip = snippet(d.text || '', q);
        if (!inName && !snip) continue;
      }
      shown++;
      const li = document.createElement('li');
      li.className = 'doc-item';
      li.dataset.id = d.id;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'doc-open';
      let thumbEl;
      if (d.thumb) {
        let t = libThumbs.get(d.id);
        if (!t || t.blob !== d.thumb) {
          if (t) URL.revokeObjectURL(t.url);
          t = { blob: d.thumb, url: URL.createObjectURL(d.thumb) };
          libThumbs.set(d.id, t);
        }
        thumbEl = document.createElement('img');
        thumbEl.src = t.url;
        thumbEl.alt = '';
      } else {
        thumbEl = document.createElement('span');
        thumbEl.innerHTML = '<svg class="ic"><use href="#i-pdf"/></svg>';
      }
      thumbEl.classList.add('doc-thumb');
      const meta = document.createElement('span');
      meta.className = 'doc-meta';
      const name = document.createElement('b');
      highlight(name, d.name, q);
      const info = document.createElement('span');
      info.className = 'muted';
      info.textContent = `${d.pageCount === 1 ? '1 Seite' : `${d.pageCount} Seiten`} · ${fmtDate(d.updated)}`;
      meta.append(name, info);
      if (snip) {
        const sn = document.createElement('span');
        sn.className = 'doc-snippet';
        highlight(sn, snip, q);
        meta.append(sn);
      }
      open.append(thumbEl, meta);
      open.setAttribute('aria-label', `${d.name} öffnen`);
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'icon-btn doc-more';
      more.setAttribute('aria-label', `Aktionen für ${d.name}`);
      more.innerHTML = '<svg class="ic"><use href="#i-dots"/></svg>';
      li.append(open, more);
      docList.appendChild(li);
    }
    for (const [id, t] of libThumbs) if (!docs.some((d) => d.id === id)) { URL.revokeObjectURL(t.url); libThumbs.delete(id); }
    const n = docs.length;
    $('#empty').hidden = n > 0;
    $('#libSearchWrap').hidden = n === 0;
    $('#libNoHits').hidden = !(n && q && !shown);
    $('#libInfo').textContent = n === 0 ? 'Keine Dokumente' : n === 1 ? '1 Dokument' : `${n} Dokumente`;
  }

  function renderDocHeader() {
    const d = currentDoc;
    $('#docName').textContent = d ? d.name : 'Neues Dokument';
    const n = pages.length;
    $('#docInfo').textContent = n === 0 ? 'Keine Seiten' : n === 1 ? '1 Seite' : `${n} Seiten`;
  }

  /** Dokument öffnen (Seiten aus dem Speicher laden) und Dokumentansicht zeigen. */
  async function openDoc(d) {
    if (currentDoc !== d || !pages.length) {
      pages.forEach(dropUrls);
      currentDoc = d;
      const recs = ((await DB.pagesOf(d.id)) || []).sort((a, b) => a.order - b.order);
      pages = recs.map((r) => inflight.get(r.id) || { ...r, pending: false, error: false }).filter((p) => !p.deleted);
    }
    renderGrid();
    $('#overview').scrollTop = 0;
    if (topScreen() !== 'docview') openScreen('docview');
    pages.filter((p) => (!p.processed || !p.thumb) && !p.pending).forEach(schedule);
    if (settings.ocr) pages.forEach((p) => { if (p.processed && p.procKey && !(p.ocr && p.ocr.key === p.procKey)) ensureOcr(p).catch(() => {}); });
  }

  function onDocClosed() {
    pages.forEach(dropUrls);
    pages = [];
    currentDoc = null;
    renderLibrary();
  }

  async function deleteDoc(d) {
    const n = d.pageCount;
    if (!confirm(`„${d.name}“${n ? ` mit ${n === 1 ? '1 Seite' : `${n} Seiten`}` : ''} löschen?`)) return false;
    docs = docs.filter((x) => x !== d);
    for (const p of inflight.values()) if (p.docId === d.id) p.deleted = true;
    if (currentDoc === d) pages.forEach((p) => { p.deleted = true; });
    await DB.delPagesOf(d.id);
    await DB.delDoc(d.id);
    if (currentDoc === d && topScreen() === 'docview') closeScreen();
    renderLibrary();
    return true;
  }

  // Umbenennen (mit Vorschlägen aus dem erkannten Text)
  const nameDialog = $('#nameDialog');
  let renaming = null;
  function nameSuggestions(text) {
    const out = [];
    for (const raw of (text || '').split(/\n+/)) {
      const l = raw.replace(/\s+/g, ' ').trim();
      if (l.length < 4 || l.length > 60) continue;
      const letters = (l.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
      if (letters / l.length < 0.5) continue;
      if (!out.includes(l)) out.push(l);
      if (out.length >= 3) break;
    }
    return out;
  }
  function showRename(d) {
    renaming = d;
    $('#nameInput').value = d.name;
    const sug = nameSuggestions(d.text);
    const box = $('#nameSuggest');
    box.textContent = '';
    for (const s of sug) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = s;
      b.addEventListener('click', () => { $('#nameInput').value = s; $('#nameInput').focus(); });
      box.appendChild(b);
    }
    $('#nameSuggestWrap').hidden = !sug.length;
    nameDialog.showModal();
    setTimeout(() => { $('#nameInput').focus(); $('#nameInput').select(); }, 50);
  }
  function saveRename() {
    const d = renaming;
    if (!d) return;
    const v = $('#nameInput').value.replace(/\s+/g, ' ').trim();
    d.name = v || docDefaultName(d.created);
    d.named = !!v;
    d.updated = Date.now();
    DB.putDoc(d);
    nameDialog.close();
    renaming = null;
    renderLibrary();
    if (currentDoc === d) renderDocHeader();
  }
  $('#nameSave').addEventListener('click', saveRename);
  $('#nameForm').addEventListener('submit', (e) => { if (e.submitter && e.submitter.value === 'close') return; e.preventDefault(); saveRename(); });
  nameDialog.addEventListener('click', (e) => { if (e.target === nameDialog) nameDialog.close(); });

  // Aktionen aus der Ablage
  const docMenu = $('#docMenu');
  let menuDoc = null;
  docList.addEventListener('click', (e) => {
    const li = e.target.closest('.doc-item');
    if (!li) return;
    const d = docs.find((x) => x.id === li.dataset.id);
    if (!d) return;
    if (e.target.closest('.doc-more')) {
      menuDoc = d;
      $('#docMenuTitle').textContent = d.name;
      docMenu.showModal();
    } else if (e.target.closest('.doc-open')) {
      openDoc(d);
    }
  });
  docMenu.addEventListener('click', (e) => { if (e.target === docMenu) docMenu.close(); });
  $('#menuOpen').addEventListener('click', () => { docMenu.close(); openDoc(menuDoc); });
  $('#menuPdf').addEventListener('click', async () => { docMenu.close(); await openDoc(menuDoc); openPdf(false); });
  $('#menuRename').addEventListener('click', () => { docMenu.close(); showRename(menuDoc); });
  $('#menuDelete').addEventListener('click', async () => { docMenu.close(); await deleteDoc(menuDoc); });
  $('#libSearch').addEventListener('input', renderLibrary);
  $('#docBack').addEventListener('click', () => closeScreen());
  $('#docTitle').addEventListener('click', () => { if (currentDoc) showRename(currentDoc); });
  $('#docDelete').addEventListener('click', () => {
    if (currentDoc) deleteDoc(currentDoc);
    else closeScreen();
  });

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
  const adding = new Set(); // Aufnahmen/Importe, die noch gespeichert werden
  const isIdle = () => !busy && !queue.length && !adding.size;
  async function whenIdle() {
    while (!isIdle()) {
      if (adding.size) await Promise.allSettled([...adding]);
      if (busy || queue.length) await new Promise((r) => idleWaiters.push(r));
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // Seiten, die gerade verarbeitet/erkannt werden – beim erneuten Öffnen dasselbe Objekt verwenden
  const inflight = new Map();
  const releaseInflight = (p) => { if (!p.pending && !p.ocrJob) inflight.delete(p.id); };

  function schedule(p) {
    p.rev = (p.rev || 0) + 1;
    p.pending = true;
    inflight.set(p.id, p);
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
      if (p.deleted) { inflight.delete(p.id); continue; }
      const rev = p.rev;
      await tick();
      try {
        const result = await processPage(p);
        if (p.rev !== rev) continue; // wurde inzwischen geändert und neu eingereiht
        Object.assign(p, result, { pending: false, error: false, procKey: uid() });
        if (settings.ocr) ensureOcr(p).catch(() => {}); // Text im Hintergrund erkennen
      } catch (e) {
        console.error(e);
        if (p.rev === rev) { p.pending = false; p.error = true; }
      }
      renderCard(p);
      if (editor.page === p) updatePreview();
      persist(p);
      releaseInflight(p);
    }
    busy = false;
    idleWaiters.splice(0).forEach((r) => r());
  }

  // Bildverarbeitung im Hintergrund-Thread (Web Worker); Rückfall auf den Hauptthread, falls nicht verfügbar.
  /** Kleiner Client für einen Hintergrund-Thread (proc-worker.js). */
  function workerClient() {
    let worker = null, ready = null, seq = 0;
    const pending = new Map();
    const call = (job, timeout, transfer = []) => new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'Zeitüberschreitung' }); }, timeout);
      pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      worker.postMessage({ id, job }, transfer);
    });
    function init() {
      if (ready) return ready;
      ready = (async () => {
        if (!window.Worker || typeof OffscreenCanvas === 'undefined') return false;
        try { worker = new Worker('proc-worker.js'); } catch { return false; }
        worker.onmessage = (e) => { const cb = pending.get(e.data.id); if (cb) { pending.delete(e.data.id); cb(e.data); } };
        worker.onerror = () => { pending.forEach((cb) => cb({ ok: false, error: 'Worker-Fehler' })); pending.clear(); };
        const r = await call('ping', 5000);
        return !!r.ok;
      })();
      return ready;
    }
    return { init, call };
  }

  // Eigener Thread für die Live-Erkennung, damit sie nicht auf die Seitenverarbeitung warten muss
  const LiveW = (() => {
    const w = workerClient();
    let resizeOk = true;
    async function detect(videoEl, size) {
      if (!window.createImageBitmap || !(await w.init())) return null;
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      const s = Math.min(1, size / Math.max(vw, vh));
      let bitmap = null;
      if (resizeOk) {
        // bereits beim Kopieren verkleinern (schnell, auf der Grafikkarte)
        try { bitmap = await createImageBitmap(videoEl, { resizeWidth: Math.round(vw * s), resizeHeight: Math.round(vh * s), resizeQuality: 'low' }); }
        catch { resizeOk = false; }
      }
      if (!bitmap) {
        try { bitmap = await createImageBitmap(videoEl); } catch { return null; }
      }
      const r = await w.call({ type: 'live', bitmap, size }, 5000, [bitmap]);
      return r.ok ? r.result : null;
    }
    return { detect, init: w.init };
  })();

  const Proc = (() => {
    const { init, call } = workerClient();
    async function run(job) {
      if (await init()) {
        const r = await call(job, 90000);
        if (r.ok) return r.result;
        console.warn('Worker:', r.error);
      }
      return Img.processPage(job);
    }
    /** Kamerabild im Hintergrund als JPEG speichern; null, wenn nicht möglich (dann im Hauptthread). */
    async function encodeFrame(videoEl, maxDim) {
      if (!window.createImageBitmap || !(await init())) return null;
      let bitmap;
      try { bitmap = await createImageBitmap(videoEl); } catch { return null; }
      const r = await call({ type: 'encode', bitmap, maxDim }, 30000, [bitmap]);
      return r.ok ? r.result : null;
    }
    return { run, init, encodeFrame };
  })();

  async function processPage(p) {
    const res = await Proc.run({
      original: p.original, rotation: p.rotation, corners: p.corners, filter: p.filter,
      autoDetect: !!p.autoDetect, maxDim: MAX_DIM,
    });
    if (!p.autoDetect) delete res.corners;
    else res.autoDetect = false;
    return res;
  }

  /** Registriert eine laufende Aufnahme, damit die PDF-Erstellung darauf wartet. */
  function track(job) {
    adding.add(job);
    job.finally(() => adding.delete(job)).catch(() => {});
    return job;
  }

  function addFromCanvas(c, hint) {
    return track(Img.toBlob(c, 'image/jpeg', 0.92).then((original) => addOriginal(original, hint)));
  }

  function addOriginal(original, hint) {
    // Ränder: vorläufig aus der Live-Erkennung, genau erkannt wird im Hintergrund auf dem vollen Bild
    const corners = (settings.autoCrop && hint) || Img.FULL.map((x) => x.slice());
    if (!currentDoc) currentDoc = newDoc();
    const p = { id: uid(), docId: currentDoc.id, order: pages.length, created: Date.now(), original, rotation: 0, corners, filter: settings.filter, processed: null, thumb: null, autoDetect: settings.autoCrop };
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

  // ---------- Texterkennung ----------
  /** Liefert den erkannten Text der aktuellen Seitenversion (aus Cache oder neu erkannt). */
  function ensureOcr(p, onProgress) {
    const key = p.procKey;
    if (!p.processed || !key) return Promise.reject(new Error('Seite ist noch nicht fertig verarbeitet.'));
    if (p.ocr && p.ocr.key === key) return Promise.resolve(p.ocr);
    if (p.ocrJob && p.ocrJob.key === key) {
      if (onProgress) p.ocrJob.listeners.add(onProgress);
      return p.ocrJob.promise;
    }
    const listeners = new Set(onProgress ? [onProgress] : []);
    const promise = Ocr.recognize(p.processed, (m) => listeners.forEach((f) => f(m))).then((res) => {
      const ocr = { key, text: res.text, words: res.words };
      if (p.procKey === key) { p.ocr = ocr; persist(p); }
      return ocr;
    }).finally(() => { if (p.ocrJob && p.ocrJob.key === key) p.ocrJob = null; releaseInflight(p); });
    p.ocrJob = { key, promise, listeners };
    inflight.set(p.id, p);
    return promise;
  }

  function ocrStatus(m) {
    const st = {
      'loading tesseract core': 'Texterkennung wird geladen …',
      'initializing tesseract': 'Texterkennung wird gestartet …',
      'loading language traineddata': 'Sprachdaten werden geladen …',
      'initializing api': 'Texterkennung wird gestartet …',
      'recognizing text': 'Text wird erkannt …',
    }[m && m.status] || 'Texterkennung …';
    return { text: st, progress: m && typeof m.progress === 'number' ? m.progress : 0, recognizing: m && m.status === 'recognizing text' };
  }

  // Helvetica-Breiten über Arial messen (gleiche Laufweiten), um die Textebene passend zu skalieren
  const measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = '1000px Helvetica, Arial, sans-serif';
  const emWidth = (s) => measureCtx.measureText(s).width / 1000 || 0.5 * s.length;

  function textLayer(p, x, y, k) {
    if (!p.ocr || !p.ocr.words) return [];
    return p.ocr.words.map(([s, x0, y0, x1, y1, base, lineH]) => {
      const size = Math.max(1, Math.min((lineH || (y1 - y0)) * k * 0.82, (y1 - y0) * k * 1.6));
      const natural = emWidth(s) * size;
      const scale = natural > 0 ? Math.max(10, Math.min(1000, 100 * ((x1 - x0) * k) / natural)) : 100;
      return { s, x: x + x0 * k, y: y + (p.ph - base) * k, size, scale };
    });
  }

  // ---------- Übersicht ----------
  const grid = $('#pageGrid');

  function renderGrid() {
    grid.textContent = '';
    pages.forEach((p, i) => grid.appendChild(makeCard(p, i)));
    const n = pages.length;
    $('#docEmpty').hidden = n > 0;
    $('#gridHint').hidden = n < 2;
    $('#btnPdf').disabled = n === 0;
    renderDocHeader();
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
  // Ansichten liegen als Stapel übereinander: Ablage → Dokument → Editor/Kamera
  const stack = [];
  const topScreen = () => stack[stack.length - 1] || null;
  function openScreen(name) {
    if (stack.includes(name)) return;
    stack.push(name);
    $('#' + name).hidden = false;
    document.body.classList.add('screen-open');
    try { history.pushState({ dokscan: stack.length }, ''); } catch { /* egal */ }
  }
  function closeScreen() {
    if (!stack.length) return;
    if (history.state && history.state.dokscan === stack.length) history.back();
    else popScreen();
  }
  function popScreen() {
    const name = stack.pop();
    $('#' + name).hidden = true;
    if (!stack.length) document.body.classList.remove('screen-open');
    if (name === 'camera') onCameraClosed();
    if (name === 'editor') onEditorClosed();
    if (name === 'docview') onDocClosed();
  }
  window.addEventListener('popstate', (e) => {
    const depth = (e.state && e.state.dokscan) || 0;
    while (stack.length > depth) popScreen();
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
    $('#camDone').disabled = false;
    $('#camCount').textContent = String(cam.added);
    $('#camLast').hidden = cam.added === 0;
    const page = `Seite ${pages.length + 1}`;
    let hint = page;
    if (settings.autoCrop) {
      if (auto.waiting) hint = 'Nächste Seite auflegen …';
      else if (auto.armed) hint = `${page} · Ruhig halten …`;
      else hint = live.quad ? `${page} · Rand erkannt` : `${page} · Dokument suchen …`;
    }
    $('#camHint').textContent = hint;
    $('#camAuto').hidden = !settings.autoCrop;
    $('#camAuto').setAttribute('aria-pressed', String(!!settings.autoShoot));
  }

  // ---------- Automatisch auslösen ----------
  // Ist der Rand ~1,2 s lang ruhig erkannt, wird ausgelöst. Danach wird erst wieder ausgelöst,
  // wenn das Dokument kurz weg war (Seite umgeblättert) oder sich das Bild deutlich geändert hat.
  const AUTO_HOLD_MS = 1000;         // so lange muss das Dokument ruhig erkannt sein
  const AUTO_MOVE_TICK = 0.02;       // erlaubte Eckenbewegung zwischen zwei Messungen (Anteil der Bildgröße)
  const AUTO_MOVE_TOTAL = 0.035;     // erlaubte Abweichung über die ganze Haltezeit
  const auto = { since: 0, anchor: null, prev: null, waiting: false, sig: null, armed: false, lost: 0, miss: 0 };
  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = 24; sigCanvas.height = 24;
  function signature() {
    if (live.sig) return live.sig; // aus dem Live-Thread
    const x = sigCanvas.getContext('2d', { willReadFrequently: true });
    // aus dem bereits verkleinerten Bild der Live-Erkennung – das Kamerabild nicht ein zweites Mal auslesen
    x.drawImage(Img.lastFrame() || video, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    const s = new Float32Array(576);
    for (let i = 0; i < 576; i++) s[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return s;
  }
  const sigDiff = (a, b) => { let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length; };
  const cornerDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
  function resetAuto() {
    auto.since = 0; auto.anchor = null; auto.prev = null; auto.armed = false; auto.miss = 0;
    setArming(0);
  }
  function setArming(p) {
    const sh = $('#camShutter');
    sh.style.setProperty('--p', String(p));
    sh.classList.toggle('arming', p > 0);
    $('#camera').classList.toggle('arming', p > 0);
  }
  function autoTick(raw) {
    if (!settings.autoShoot || !settings.autoCrop || cam.shooting) { resetAuto(); return; }
    if (auto.waiting) {
      // erst wieder scharf schalten, wenn Dokument weg war oder Bild sich klar geändert hat
      // „Seite weg“ erst nach mindestens 0,5 s ohne Dokument (Umblättern), nicht bei kurzen Aussetzern
      const t = performance.now();
      if (raw) auto.lost = 0; else if (!auto.lost) auto.lost = t;
      if ((auto.lost && t - auto.lost >= 500) || (auto.sig && sigDiff(signature(), auto.sig) > 10)) { auto.waiting = false; auto.lost = 0; }
      resetAuto();
      return;
    }
    if (!raw) {
      // kurze Aussetzer der Erkennung (< 0,3 s) tolerieren
      if (!auto.miss) auto.miss = performance.now();
      else if (performance.now() - auto.miss > 300) resetAuto();
      return;
    }
    auto.miss = 0;
    const now = performance.now();
    if (!auto.prev || cornerDist(raw, auto.prev) > AUTO_MOVE_TICK || (auto.anchor && cornerDist(raw, auto.anchor) > AUTO_MOVE_TOTAL)) {
      auto.since = now;
      auto.anchor = raw;
    }
    auto.prev = raw;
    const progress = Math.min(1, (now - auto.since) / AUTO_HOLD_MS);
    auto.armed = progress > 0;
    setArming(progress);
    if (progress >= 1) {
      resetAuto();
      auto.waiting = true;
      auto.sig = signature();
      shoot();
    }
  }
  $('#camAuto').addEventListener('click', () => {
    settings.autoShoot = !settings.autoShoot;
    saveSettings();
    resetAuto();
    auto.waiting = false;
    updateCamUi();
    toast(settings.autoShoot ? 'Automatisch auslösen: an' : 'Automatisch auslösen: aus');
  });

  // Live-Randerkennung im Kamerabild
  // Erkennung läuft (wenn möglich) in einem eigenen Thread so oft wie möglich (max. ~20/s);
  // der Rahmen wird bei jedem Bildschirmbild weich zur zuletzt erkannten Position nachgeführt.
  const LIVE_MIN_INTERVAL = 50;   // ms zwischen zwei Erkennungen (≈ 20/s)
  const LIVE_HOLD_MS = 450;       // so lange bleibt der Rahmen nach Aussetzern stehen
  const live = { on: false, gen: 0, quad: null, shown: null, sig: null, lastSeen: 0, jump: null, raf: 0, found: false, useWorker: null };

  function startLive() {
    stopLive();
    if (!settings.autoCrop) return;
    live.on = true;
    const gen = ++live.gen;
    liveLoop(gen);
    live.raf = requestAnimationFrame(renderLive);
  }
  function stopLive() {
    resetAuto();
    auto.waiting = false;
    live.on = false;
    live.gen++;
    cancelAnimationFrame(live.raf);
    live.quad = null;
    live.shown = null;
    live.sig = null;
    live.jump = null;
    drawLive();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function liveLoop(gen) {
    if (live.useWorker === null) live.useWorker = await LiveW.init();
    while (live.on && live.gen === gen) {
      if (!video.videoWidth || cam.shooting || document.hidden) { await sleep(120); continue; }
      const t0 = performance.now();
      let res = null;
      if (live.useWorker) {
        res = await LiveW.detect(video, 192);
        if (!res) live.useWorker = false; // Rückfall auf den Hauptthread
      }
      if (!res) {
        let q = null;
        try { q = Img.detect(video, 160, true); } catch { q = null; }
        res = { quad: q, sig: null };
      }
      if (!live.on || live.gen !== gen) break;
      onDetection(res.quad, res.sig);
      const cost = performance.now() - t0;
      // im Hauptthread mehr Pause lassen, damit die Bedienung flüssig bleibt
      await sleep(live.useWorker ? Math.max(0, LIVE_MIN_INTERVAL - cost) : Math.max(120, cost * 1.5));
    }
  }

  function onDetection(q, sig) {
    const now = performance.now();
    live.count = (live.count || 0) + 1;
    if (sig) live.sig = sig;
    if (q) {
      if (live.quad && cornerDist(q, live.quad) > 0.08) {
        // großer Sprung: erst übernehmen, wenn er sich bestätigt (verhindert Flackern durch Fehlerkennungen)
        if (live.jump && cornerDist(q, live.jump) < 0.04) { live.quad = q; live.jump = null; }
        else live.jump = q;
      } else {
        // Ruhezone: winzige Abweichungen (Bildrauschen) ignorieren, damit der Rahmen still steht
        if (!live.quad || cornerDist(q, live.quad) > 0.006) live.quad = q;
        live.jump = null;
      }
      live.lastSeen = now;
    } else if (live.quad && now - live.lastSeen > LIVE_HOLD_MS) {
      live.quad = null;
      live.jump = null;
    }
    try { autoTick(q); } catch (e) { console.warn(e); }
    const found = !!live.quad;
    if (found !== live.found) { live.found = found; updateCamUi(); }
  }

  // Bei jedem Bildschirmbild weich nachführen (kein Ruckeln zwischen den Erkennungen)
  function renderLive() {
    if (!live.on) return;
    const t = live.quad;
    if (!t) live.shown = null;
    else if (!live.shown) live.shown = t.map((p) => p.slice());
    else live.shown = live.shown.map((p, i) => {
      // große Bewegung → schnell folgen, kleines Zittern → ruhig glätten
      const dx = t[i][0] - p[0], dy = t[i][1] - p[1];
      const a = Math.min(0.7, 0.2 + Math.hypot(dx, dy) * 12);
      return [p[0] + dx * a, p[1] + dy * a];
    });
    drawLive();
    live.raf = requestAnimationFrame(renderLive);
  }

  let liveBox = null;
  const measureLiveBox = () => { liveBox = null; };
  window.addEventListener('resize', measureLiveBox);
  function drawLive() {
    const svg = $('#camQuad'), poly = $('#camQuadPoly');
    const q = live.shown;
    const found = !!q && !!video.videoWidth;
    $('#camera').classList.toggle('doc-found', !!live.quad);
    if (!found) { if (poly.hasAttribute('points')) poly.removeAttribute('points'); return; }
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!liveBox || liveBox.vw !== vw || liveBox.vh !== vh) {
      const r = svg.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      liveBox = { vw, vh, s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2 };
      svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    }
    const { s, ox, oy } = liveBox;
    poly.setAttribute('points', q.map(([x, y]) => `${(ox + x * vw * s).toFixed(1)},${(oy + y * vh * s).toFixed(1)}`).join(' '));
  }

  async function startStream() {
    stopStream();
    setCamMsg('Kamera wird gestartet …', false);
    // „Weites Sichtfeld“: 4:3-Format in mittlerer Auflösung – iPads schneiden bei sehr hohen Auflösungen das Bild zu.
    const res = settings.wideFov
      ? { width: { ideal: 1920 }, height: { ideal: 1440 }, aspectRatio: { ideal: 4 / 3 } }
      : { width: { ideal: 4096 }, height: { ideal: 3072 } };
    const byFacing = { facingMode: { ideal: 'environment' }, ...res };
    try {
      try {
        cam.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: settings.camDevice ? { deviceId: { exact: settings.camDevice }, ...res } : byFacing,
        });
      } catch (e) {
        if (!settings.camDevice || e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
        settings.camDevice = ''; // gespeicherte Kamera gibt es nicht mehr
        saveSettings();
        cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: byFacing });
      }
    } catch (e) {
      console.warn(e);
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setCamMsg(denied
        ? 'Kein Zugriff auf die Kamera. Erlaube den Zugriff in den Browser-Einstellungen oder nutze die Kamera-App.'
        : 'Die Kamera konnte nicht gestartet werden. Du kannst stattdessen die Kamera-App verwenden.', true);
      return;
    }
    if (topScreen() !== 'camera') { stopStream(); return; }
    cam.track = cam.stream.getVideoTracks()[0];
    video.srcObject = cam.stream;
    try { await video.play(); } catch { /* autoplay */ }
    setCamMsg('', false);
    startLive();
    const caps = cam.track && cam.track.getCapabilities ? cam.track.getCapabilities() : {};
    $('#camTorch').hidden = !caps.torch;
    cam.torch = false;
    $('#camTorch').setAttribute('aria-pressed', 'false');
    setupZoom(caps);
    refreshCameras();
  }

  // ---------- Zoom ----------
  const fmtZoom = (z) => `${String(Math.round(z * 10) / 10).replace('.', ',')}×`;
  function setupZoom(caps) {
    const row = $('#camZoom');
    row.textContent = '';
    cam.zoomRange = null;
    const zc = caps && caps.zoom;
    if (!zc || !(zc.max > zc.min)) { row.hidden = true; return; }
    const min = zc.min, max = zc.max;
    cam.zoomRange = { min, max };
    const presets = [min];
    if (min < 0.95 && max >= 1) presets.push(1);
    if (max >= 2) presets.push(2);
    if (presets.length < 2) presets.push(Math.min(max, min * 2));
    for (const z of presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.zoom = String(z);
      b.setAttribute('role', 'radio');
      b.textContent = fmtZoom(z);
      b.addEventListener('click', () => { settings.zoom = z; saveSettings(); applyZoom(z); });
      row.appendChild(b);
    }
    row.hidden = false;
    // Standard: kleinster Zoom = größtes Sichtfeld
    const start = settings.zoom != null ? settings.zoom : min;
    applyZoom(Math.min(max, Math.max(min, start)));
  }
  let zoomBusy = false, zoomNext = null;
  async function applyZoom(z) {
    if (!cam.track || !cam.zoomRange) return;
    cam.zoom = z;
    $('#camZoom').querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-checked', String(Math.abs(Number(b.dataset.zoom) - z) < 0.05));
    });
    if (zoomBusy) { zoomNext = z; return; }
    zoomBusy = true;
    try { await cam.track.applyConstraints({ advanced: [{ zoom: z }] }); } catch (e) { console.warn(e); }
    zoomBusy = false;
    if (zoomNext != null) { const n = zoomNext; zoomNext = null; applyZoom(n); }
  }
  // Zoomen mit zwei Fingern
  const pinch = new Map();
  let pinchStart = null;
  const cameraEl = $('#camera');
  cameraEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    pinch.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch.size === 2 && cam.zoomRange) {
      const [a, b] = [...pinch.values()];
      pinchStart = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z: cam.zoom || cam.zoomRange.min };
    }
  });
  cameraEl.addEventListener('pointermove', (e) => {
    if (!pinch.has(e.pointerId)) return;
    pinch.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch.size !== 2 || !pinchStart || !cam.zoomRange) return;
    const [a, b] = [...pinch.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const z = Math.min(cam.zoomRange.max, Math.max(cam.zoomRange.min, pinchStart.z * d / pinchStart.d));
    applyZoom(z);
    $('#camHint').textContent = `Zoom ${fmtZoom(z)}`;
  });
  const pinchEnd = (e) => {
    pinch.delete(e.pointerId);
    if (pinch.size < 2 && pinchStart) {
      pinchStart = null;
      settings.zoom = cam.zoom;
      saveSettings();
      updateCamUi();
    }
  };
  cameraEl.addEventListener('pointerup', pinchEnd);
  cameraEl.addEventListener('pointercancel', pinchEnd);

  // ---------- Kamera wechseln ----------
  function cameraName(d, i) {
    const l = d.label || '';
    const map = [
      [/ultra ?wide|ultraweit/i, 'Ultraweitwinkel'],
      [/triple/i, 'Triple-Kamera'],
      [/dual wide/i, 'Dual-Weitwinkel'],
      [/dual/i, 'Dual-Kamera'],
      [/tele/i, 'Teleobjektiv'],
      [/wide|weitwinkel|back camera|rückkamera|rückseit/i, 'Weitwinkel'],
    ];
    for (const [re, name] of map) if (re.test(l)) return name;
    return l || `Kamera ${i + 1}`;
  }
  async function refreshCameras() {
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { /* egal */ }
    const front = /\bfront|vorder|facetime|selfie/i;
    let back = devs.filter((d) => !front.test(d.label));
    if (!back.length) back = devs;
    cam.devices = back;
    $('#camSwitch').hidden = back.length < 2;
  }
  $('#camSwitch').addEventListener('click', () => {
    const list = cam.devices || [];
    if (list.length < 2 || !cam.track) return;
    const curId = (cam.track.getSettings && cam.track.getSettings().deviceId) || settings.camDevice;
    const i = list.findIndex((d) => d.deviceId === curId);
    const next = list[(i + 1) % list.length];
    settings.camDevice = next.deviceId;
    settings.zoom = null;
    saveSettings();
    toast(cameraName(next, list.indexOf(next)));
    startStream();
  });

  function stopStream() {
    stopLive();
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    cam.track = null;
    video.srcObject = null;
  }

  /** Kamera öffnen; fromLibrary = neues Dokument anlegen (erst beim ersten Foto). */
  function openCamera(fromLibrary) {
    cam.newDoc = !!fromLibrary;
    if (cam.newDoc) { pages.forEach(dropUrls); pages = []; currentDoc = null; renderGrid(); }
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
    const fromLibrary = cam.newDoc;
    cam.newDoc = false;
    cam.added = 0;
    // nach dem Popstate ausführen, damit die neue Ansicht nicht gleich wieder geschlossen wird
    setTimeout(async () => {
      if (fromLibrary) {
        if (!currentDoc) return;
        await openDoc(currentDoc);
      }
      if (auto) openPdf(true);
    }, 50);
  }

  async function shoot() {
    if (!video.videoWidth || cam.shooting) return;
    cam.shooting = true;
    if (!auto.waiting) { resetAuto(); auto.waiting = true; try { auto.sig = signature(); } catch { auto.sig = null; } }
    const flash = $('#camFlash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    if (navigator.vibrate) navigator.vibrate(15);
    const hint = live.quad && live.quad.map((p) => p.slice());
    const img = $('#camLast img');
    const showThumb = (blob) => {
      if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      img.dataset.url = URL.createObjectURL(blob);
      img.src = img.dataset.url;
    };
    try {
      cam.added++;
      updateCamUi();
      await track((async () => {
        // bevorzugt im Hintergrund-Thread (blockiert die Bedienung nicht)
        const enc = await Proc.encodeFrame(video, MAX_DIM);
        if (enc) {
          showThumb(enc.thumb);
          addOriginal(enc.original, hint);
          return;
        }
        const c = Img.draw(video, MAX_DIM);
        const t = Img.draw(c, 160);
        const thumbBlob = Img.toBlob(t, 'image/jpeg', 0.7);
        const original = await Img.toBlob(c, 'image/jpeg', 0.92);
        Img.release(c);
        showThumb(await thumbBlob);
        Img.release(t);
        addOriginal(original, hint);
      })());
      updateCamUi();
    } catch (e) {
      console.error(e);
      toast('Aufnahme fehlgeschlagen.');
    } finally {
      cam.shooting = false;
    }
  }

  $('#btnScan').addEventListener('click', () => openCamera(false));
  $('#libScan').addEventListener('click', () => openCamera(true));
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
    if (topScreen() === 'camera' && (e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); shoot(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (topScreen() !== 'camera') return;
    if (document.hidden) stopStream(); else startStream();
  });

  // Importieren: aus der Ablage → neues Dokument, aus einem Dokument → anhängen
  let importNewDoc = false;
  async function importInto(files, newDocument) {
    if (!files || !files.length) return 0;
    if (newDocument) { pages.forEach(dropUrls); pages = []; currentDoc = null; }
    const n = await addFiles(files);
    if (n && newDocument && currentDoc) await openDoc(currentDoc);
    return n;
  }
  $('#fileCapture').addEventListener('change', async (e) => {
    const n = await importInto(e.target.files, cam.newDoc);
    cam.newDoc = false;
    e.target.value = '';
    if (n) toast('Seite hinzugefügt. Tippe auf „Scannen“ für die nächste.');
  });
  $('#btnImport').addEventListener('click', () => { importNewDoc = false; $('#fileImport').click(); });
  $('#libImport').addEventListener('click', () => { importNewDoc = true; $('#fileImport').click(); });
  $('#fileImport').addEventListener('change', async (e) => {
    const n = await importInto(e.target.files, importNewDoc);
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
    p.autoDetect = false;
    for (let k = 0; k < ((steps % 4) + 4) % 4; k++) p.corners = Img.rotateCornersCW(p.corners);
    p.rotation = (((p.rotation + steps * 90) % 360) + 360) % 360;
    schedule(p);
  }

  // Erkannten Text anzeigen und kopieren
  const textDialog = $('#textDialog');
  async function showText() {
    const p = editor.page;
    if (!p) return;
    const out = $('#textOut'), prog = $('#textProgress'), err = $('#textError');
    out.value = '';
    err.hidden = true;
    $('#textCopy').disabled = true;
    prog.hidden = false;
    $('#textProgressBar').style.width = '0%';
    $('#textProgressText').textContent = 'Seite wird vorbereitet …';
    textDialog.showModal();
    try {
      if (p.pending) await whenIdle();
      const ocr = await ensureOcr(p, (m) => {
        const st = ocrStatus(m);
        $('#textProgressText').textContent = st.text;
        $('#textProgressBar').style.width = `${Math.round((st.recognizing ? st.progress : 0) * 100)}%`;
      });
      out.value = ocr.text;
      $('#textCopy').disabled = !ocr.text;
    } catch (e) {
      console.error(e);
      err.textContent = 'Texterkennung nicht möglich: ' + (e.message || e);
      err.hidden = false;
    } finally {
      prog.hidden = true;
    }
  }
  $('#edText').addEventListener('click', showText);
  $('#textCopy').addEventListener('click', async () => {
    const t = $('#textOut').value;
    try { await navigator.clipboard.writeText(t); toast('Text kopiert.'); }
    catch { $('#textOut').select(); document.execCommand('copy'); toast('Text kopiert.'); }
  });
  textDialog.addEventListener('click', (e) => { if (e.target === textDialog) textDialog.close(); });

  $('#edBack').addEventListener('click', closeScreen);
  $('#edMovePrev').addEventListener('click', () => movePage(-1));
  $('#edMoveNext').addEventListener('click', () => movePage(1));
  $('#edRotL').addEventListener('click', () => rotatePage(-1));
  $('#edRotR').addEventListener('click', () => rotatePage(1));
  $('#edDelete').addEventListener('click', () => {
    const p = editor.page;
    if (!p || !confirm(`Seite ${pages.indexOf(p) + 1} löschen?`)) return;
    pages = pages.filter((x) => x !== p);
    p.deleted = true;
    DB.del(p.id);
    persistAll();
    touchDoc(p.docId);
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
    p.autoDetect = false;
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
    $('#pdfName').value = currentDoc ? currentDoc.name.replace(/:/g, '-') : defaultName();
    setRadio('format', settings.format);
    setRadio('quality', settings.quality);
    $('#pdfOcr').checked = settings.ocr;
    $('#pdfProgress').hidden = true;
    if (!pdfDialog.open) pdfDialog.showModal();
    if (auto) generatePdf();
  }

  async function buildPdf(format, qualityKey, onProgress, withOcr = false) {
    const preset = QUALITY[qualityKey] || QUALITY.medium;
    const out = [];
    let ocrFailed = false;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      onProgress(i, pages.length);
      await tick();
      if (!p.processed) throw new Error(`Seite ${i + 1} konnte nicht verarbeitet werden.`);
      if (withOcr && !ocrFailed) {
        try { await ensureOcr(p, (m) => onProgress(i, pages.length, ocrStatus(m))); }
        catch (e) { console.warn(e); ocrFailed = true; }
      }
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
      const x = (pageW - iw) / 2, y = (pageH - ih) / 2;
      const text = withOcr && p.ocr && p.ocr.key === p.procKey ? textLayer(p, x, y, iw / p.pw) : null;
      out.push({ jpeg, pageWidth: pageW, pageHeight: pageH, x, y, w: iw, h: ih, text });
    }
    onProgress(pages.length, pages.length);
    const blob = PDFWriter.build(out, { title: fileName().replace(/\.pdf$/, ''), producer: 'DokScan' });
    blob.ocrFailed = ocrFailed;
    return blob;
  }

  async function generatePdf() {
    if (pdfState.busy) return;
    pdfState.busy = true;
    resetPdfResult();
    settings.format = getRadio('format') || 'a4';
    settings.quality = getRadio('quality') || 'medium';
    settings.ocr = $('#pdfOcr').checked;
    saveSettings();
    $('#pdfGenerate').disabled = true;
    $('#pdfProgress').hidden = false;
    const bar = $('#pdfProgressBar');
    const text = $('#pdfProgressText');
    bar.style.width = '0%';
    try {
      if (!isIdle()) {
        text.textContent = 'Seiten werden noch bearbeitet …';
        await whenIdle();
      }
      const blob = await buildPdf(settings.format, settings.quality, (i, n, ocr) => {
        const part = ocr && ocr.recognizing ? ocr.progress : 0;
        bar.style.width = `${Math.round(((i + part) / n) * 100)}%`;
        if (ocr && !ocr.recognizing) text.textContent = ocr.text;
        else if (ocr) text.textContent = `Texterkennung Seite ${i + 1} von ${n} …`;
        else text.textContent = i < n ? `Seite ${i + 1} von ${n} …` : 'PDF wird zusammengefügt …';
      }, settings.ocr);
      pdfState.blob = blob;
      pdfState.url = URL.createObjectURL(blob);
      $('#pdfResName').textContent = fileName();
      $('#pdfResMeta').textContent = `${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} · ${fmtSize(blob.size)}` +
        (settings.ocr ? (blob.ocrFailed ? ' · ohne Texterkennung (nicht verfügbar)' : ' · durchsuchbar') : '');
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
  pdfDialog.addEventListener('change', (e) => { if ((e.target.type === 'radio' || e.target.id === 'pdfOcr') && pdfState.blob) resetPdfResult(); });
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
    $('#setWideFov').checked = settings.wideFov;
    $('#setAutoShoot').checked = settings.autoShoot;
    $('#setOcr').checked = settings.ocr;
    setDialog.showModal();
  });
  $('#setAutoCrop').addEventListener('change', (e) => { settings.autoCrop = e.target.checked; saveSettings(); });
  $('#setAutoPdf').addEventListener('change', (e) => { settings.autoPdf = e.target.checked; saveSettings(); });
  $('#setWideFov').addEventListener('change', (e) => { settings.wideFov = e.target.checked; saveSettings(); });
  $('#setAutoShoot').addEventListener('change', (e) => { settings.autoShoot = e.target.checked; saveSettings(); });
  $('#setOcr').addEventListener('change', (e) => {
    settings.ocr = e.target.checked;
    saveSettings();
    if (settings.ocr) pages.forEach((p) => { if (p.processed) ensureOcr(p).catch(() => {}); });
  });
  setDialog.addEventListener('click', (e) => { if (e.target === setDialog) setDialog.close(); });


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
  const dropTarget = () => (!stack.length ? 'library' : topScreen() === 'docview' ? 'doc' : null);
  document.addEventListener('dragover', (e) => { if (dropTarget()) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    const target = dropTarget();
    if (!target || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const n = await importInto(e.dataTransfer.files, target === 'library');
    if (n) toast(n === 1 ? '1 Bild importiert.' : `${n} Bilder importiert.`);
  });

  // ---------- Start ----------
  async function init() {
    Proc.init();
    renderLibrary();
    docs = (await DB.docs()) || [];
    // Altlast: Seiten-Metadaten des übernommenen Dokuments einmal nachziehen
    const legacy = docs.find((d) => d.id === LEGACY_DOC);
    if (legacy && !legacy.thumb) refreshDocMeta(LEGACY_DOC);
    renderLibrary();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      // Neue Version aktiv → neu laden, sobald nichts offen ist (Seiten sind gespeichert)
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        const tryReload = () => {
          if (stack.length || pdfDialog.open || setDialog.open || textDialog.open || nameDialog.open || docMenu.open || !isIdle()) { setTimeout(tryReload, 2000); return; }
          reloading = true;
          location.reload();
        };
        tryReload();
      });
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  init();

  // Für Tests
  window.DokScan = { get pages() { return pages; }, get docs() { return docs; }, get currentDoc() { return currentDoc; }, get liveCount() { return live.count || 0; }, whenIdle, addFiles, buildPdf, settings, workerReady: () => Proc.init(), ensureOcr, openDoc, importInto };
})();
