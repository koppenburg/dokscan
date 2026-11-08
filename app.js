'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const MAX_DIM = 3000;
  const A4W = 595.28, A4H = 841.89;
  const FILTERS = [
    ['document', 'Dokument'],
    ['original', 'Original'],
    ['gray', 'Graustufen'],
    ['bw', 'S/W'],
  ];

  // ---------- Einstellungen ----------
  const IS_IPAD = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const DEFAULTS = { filter: 'document', autoCrop: true, autoPdf: true, format: 'a4', quality: 'medium', wideFov: IS_IPAD, camDevice: '', zoom: null, autoShoot: true, ocr: true, blurWarn: true, orient: 'auto', margin: 0, maxSize: 0, autoName: true, libSort: 'updated', libFilter: 'all' };
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
          r.onsuccess = () => {
            const db = r.result;
            // Verbindung verloren (iOS nach dem Hintergrund) oder neuere Version in anderem Tab → neu öffnen
            db.onclose = () => { if (dbp === mine) dbp = null; };
            db.onversionchange = () => { db.close(); if (dbp === mine) dbp = null; };
            resolve(db);
          };
          r.onerror = () => reject(r.error);
          r.onblocked = () => console.warn('Datenbank wird von einem anderen Tab blockiert');
        }).catch((e) => { console.warn('Datenbank nicht verfügbar', e); dbp = null; return null; });
        const mine = dbp;
      }
      return dbp;
    };
    const tx = (db, store, mode, fn) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(Array.isArray(store) ? store[0] : store));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new DOMException('Abgebrochen', 'AbortError'));
    });
    const run = async (store, mode, fn) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const db = await open();
          if (!db) { if (mode === 'readwrite') storageFailed(null); return undefined; }
          return await tx(db, store, mode, fn);
        } catch (e) {
          // geschlossene Verbindung: einmal neu verbinden und wiederholen
          if (attempt === 0 && e && (e.name === 'InvalidStateError' || e.name === 'UnknownError' || e.name === 'TransactionInactiveError')) { dbp = null; continue; }
          console.warn('Speichern nicht möglich', e);
          if (mode === 'readwrite') storageFailed(e);
          return undefined;
        }
      }
      return undefined;
    };
    return {
      pagesOf: (docId) => run('pages', 'readonly', (s) => s.index('docId').getAll(docId)),
      put: (rec) => run('pages', 'readwrite', (s) => s.put(rec)),
      putMany: (recs) => run('pages', 'readwrite', (s) => { for (const r of recs) s.put(r); }),
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
      /** Dokument samt Seiten in einer Transaktion löschen. */
      delDocAll: (id) => run(['docs', 'pages'], 'readwrite', (s) => {
        const t = s.transaction;
        t.objectStore('docs').delete(id);
        const ps = t.objectStore('pages');
        ps.index('docId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (ev) => {
          const cur = ev.target.result;
          if (cur) { ps.delete(cur.primaryKey); cur.continue(); }
        };
      }),
    };
  })();

  // Speicherfehler sichtbar machen (sonst wären die Seiten nach dem Neuladen still verloren)
  let storageWarnAt = 0;
  function storageFailed(e) {
    const now = Date.now();
    if (now - storageWarnAt < 15000) return;
    storageWarnAt = now;
    const full = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    const msg = !e ? 'Speichern nicht möglich: Dieser Browser erlaubt keinen Speicher (privater Modus?). Seiten gehen beim Schließen verloren.'
      : full ? 'Gerätespeicher voll – Seiten konnten nicht gespeichert werden. Bitte Platz schaffen oder Dokumente löschen.'
        : 'Speichern fehlgeschlagen – bitte die App neu laden, bevor du weiterscannst.';
    setTimeout(() => toast(msg, null, 9000), 0);
  }

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
    processed: p.processed, pw: p.pw, ph: p.ph, thumb: p.thumb, procKey: p.procKey, ocr: p.ocr, blur: p.blur, pdfText: p.pdfText || null,
    bright: p.bright || 0, contrast: p.contrast || 0,
  });
  const persist = (p) => {
    if (p.deleted || !p.docId) return;
    DB.put(record(p));
    touchDoc(p.docId);
  };
  /** Reihenfolge der Seiten des offenen Dokuments übernehmen und speichern (eine Transaktion). */
  const persistAll = () => {
    const recs = [];
    pages.forEach((p, i) => { p.order = i; if (!p.deleted && p.docId) recs.push(record(p)); });
    if (recs.length) DB.putMany(recs);
    if (currentDoc) touchDoc(currentDoc.id);
  };
  // Reihenfolge neuer Seiten: wächst immer (auch wenn das Dokument gerade nicht offen ist)
  let lastOrder = 0;
  const nextOrder = () => (lastOrder = Math.max(lastOrder + 1, Date.now()));

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
    if (!docs.some((d) => d.id === docId)) return; // gelöscht
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
    const sig = list.map((p) => p.id + ':' + (p.procKey || p.order)).join('|');
    const text = list.map((p) => (p.ocr && p.ocr.text) || '').filter(Boolean).join('\n\n');
    // „Geändert“ nur bei echten Änderungen (Seiten, Reihenfolge, Bearbeitung) – nicht beim bloßen Öffnen/Erkennen
    if (d.sig !== sig || d.pageCount !== list.length) d.updated = Date.now();
    d.sig = sig;
    d.pageCount = list.length;
    d.thumb = (list[0] && list[0].thumb) || null;
    d.text = text;
    applyAutoName(d, list[0]);
    updateLetterMeta(d, list[0]);
    if (docs.includes(d)) DB.putDoc(d);
    renderLibrary();
    if (currentDoc === d) renderDocHeader();
  }

  /** Briefdatum, Absender, Art und erkannte Fristen aus dem Text (für Sortierung, Schlagwort-Vorschläge, Fristen). */
  function updateLetterMeta(d, first) {
    const firstText = first && first.ocr ? first.ocr.text : '';
    const key = `${(d.text || '').length}:${first && first.ocr ? first.ocr.key : '-'}`;
    if (d.metaKey === key) return false;
    d.metaKey = key;
    let info = null, found = [];
    try { info = d.text ? DocName.letterInfo(d.text, { firstPage: firstText }) : null; } catch (e) { info = null; }
    try { found = d.text ? DocName.deadlines(d.text, { letterDate: info && info.date }) : []; } catch (e) { found = []; }
    d.letter = info;
    d.autoDeadlines = found;
    return true;
  }

  // ---------- Fristen ----------
  const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  /** Alle Fristen eines Dokuments (erkannte ohne ausgeblendete + eigene), mit Status. */
  function docDeadlines(d) {
    const hidden = d.dlHidden || {}, done = d.dlDone || {};
    const list = (d.autoDeadlines || []).filter((x) => !hidden[x.id]).concat(d.manualDeadlines || []);
    return list.map((x) => ({ ...x, done: !!done[x.id] }))
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  }
  /** Nächste offene Frist (überfällige zuerst), sonst null. */
  const nextDeadline = (d) => docDeadlines(d).find((x) => !x.done) || null;
  const daysUntil = (iso) => Math.round((new Date(iso + 'T00:00:00') - new Date(todayIso() + 'T00:00:00')) / 86400000);
  function fmtDay(iso, withWeekday) {
    const d = new Date(iso + 'T00:00:00');
    const p = (n) => String(n).padStart(2, '0');
    const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()];
    return `${withWeekday ? wd + ', ' : ''}${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }
  function relDays(iso) {
    const n = daysUntil(iso);
    return n === 0 ? 'heute' : n === 1 ? 'morgen' : n === -1 ? 'gestern' : n > 0 ? `in ${n} Tagen` : `seit ${-n} Tagen überfällig`;
  }
  const dlUrgency = (x) => (x.done ? 'done' : daysUntil(x.date) < 0 ? 'over' : daysUntil(x.date) <= 7 ? 'soon' : 'later');
  const dlPhrase = (x) => (x.label === 'Termin' ? 'Termin am' : x.label === 'Gültig bis' ? 'Gültig bis' : x.label === 'Abbuchung' ? 'Abbuchung am' : x.label === 'Vertragsende' ? 'Vertragsende' : `${x.label} bis`);

  /**
   * Automatischer Name aus dem erkannten Text („2026-11-05 Finanzamt Musterstadt Bescheid“),
   * solange das Dokument nicht von Hand benannt wurde. Gibt true zurück, wenn sich der Name geändert hat.
   */
  function applyAutoName(d, first) {
    if (!settings.autoName || d.named) return false;
    // Name hängt an der ersten Seite: nur neu bestimmen, wenn sich deren Text geändert hat
    const key = first ? (first.ocr && first.ocr.key) || '' : null;
    if (key !== null && d.autoKey === key) return false;
    if (key === null && d.autoKey !== undefined) return false; // beim Start: schon ausgewertet
    if (first && !key) return false; // Text der ersten Seite noch nicht erkannt
    let name = null;
    try {
      const s = DocName.suggest(d.text || '', { firstPage: first && first.ocr ? first.ocr.text : '', created: d.created });
      name = s && s.name;
    } catch (e) { console.warn('Benennung:', e); }
    d.autoKey = key || '';
    if (name) {
      if (d.name === name && d.auto) return false;
      d.name = name;
      d.auto = true;
      return true;
    }
    if (d.auto) { d.name = docDefaultName(d.created); d.auto = false; return true; }
    return false;
  }
  function autoNameAll() {
    for (const d of docs) if (applyAutoName(d)) DB.putDoc(d);
    renderLibrary();
    if (currentDoc) renderDocHeader();
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
  /** Alle Schlagwörter der Ablage (alphabetisch). */
  const allTags = () => [...new Set(docs.flatMap((d) => d.tags || []))].sort((a, b) => a.localeCompare(b, 'de'));
  const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const letterDay = (d) => (d.letter && d.letter.date) || null;
  function sortedDocs(list, mode) {
    const byUpdated = (a, b) => b.updated - a.updated;
    const dayOf = (d) => letterDay(d) || new Date(d.created).toISOString().slice(0, 10);
    if (mode === 'letter') return list.sort((a, b) => dayOf(b).localeCompare(dayOf(a)) || byUpdated(a, b));
    if (mode === 'sender') {
      const key = (d) => (d.letter && d.letter.sender) || '';
      return list.sort((a, b) => (!key(a) - !key(b)) || key(a).localeCompare(key(b), 'de') || dayOf(b).localeCompare(dayOf(a)));
    }
    if (mode === 'name') return list.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
    return list.sort(byUpdated);
  }
  function groupOf(d, mode) {
    if (mode === 'letter') {
      const day = letterDay(d) || new Date(d.created).toISOString().slice(0, 10);
      return `${MONTHS_DE[+day.slice(5, 7) - 1]} ${day.slice(0, 4)}`;
    }
    if (mode === 'sender') return (d.letter && d.letter.sender) || 'Ohne erkannten Absender';
    return null;
  }

  function renderLibFilter() {
    const box = $('#libFilter');
    const tags = allTags();
    const nDl = docs.filter((d) => nextDeadline(d)).length;
    if (settings.libFilter.startsWith('tag:') && !tags.includes(settings.libFilter.slice(4))) settings.libFilter = 'all';
    if (settings.libFilter === 'deadlines' && !nDl) settings.libFilter = 'all';
    const items = [['all', 'Alle']];
    if (nDl) items.push(['deadlines', `Fristen (${nDl})`]);
    for (const t of tags) items.push(['tag:' + t, t]);
    box.textContent = '';
    for (const [key, label] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (key === 'deadlines' ? ' chip-dl' : key.startsWith('tag:') ? ' chip-tag' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(settings.libFilter === key));
      b.textContent = label;
      b.addEventListener('click', () => { settings.libFilter = key; saveSettings(); renderLibrary(); });
      box.appendChild(b);
    }
    $('#libSort').value = settings.libSort;
    // Filter nur zeigen, wenn es etwas zu filtern gibt
    $('#libFilter').hidden = items.length < 2;
  }

  function renderLibrary() {
    const q = norm($('#libSearch').value.trim());
    renderLibFilter();
    const f = settings.libFilter;
    let list = docs.slice();
    if (f === 'deadlines') list = list.filter((d) => nextDeadline(d));
    else if (f.startsWith('tag:')) list = list.filter((d) => (d.tags || []).includes(f.slice(4)));
    const mode = f === 'deadlines' ? 'deadlines' : settings.libSort;
    if (mode === 'deadlines') list.sort((a, b) => (nextDeadline(a).date + (nextDeadline(a).time || '')).localeCompare(nextDeadline(b).date + (nextDeadline(b).time || '')));
    else sortedDocs(list, mode);
    docList.textContent = '';
    let shown = 0, lastGroup = null;
    for (const d of list) {
      let snip = '';
      if (q) {
        const extra = [...(d.tags || []), d.letter && d.letter.sender, d.letter && d.letter.kind].filter(Boolean).join(' ');
        const inName = norm(d.name).includes(q) || norm(extra).includes(q);
        snip = snippet(d.text || '', q);
        if (!inName && !snip) continue;
      }
      shown++;
      const group = groupOf(d, mode);
      if (group && group !== lastGroup) {
        lastGroup = group;
        const gh = document.createElement('li');
        gh.className = 'lib-group';
        const h = document.createElement('h3');
        h.textContent = group;
        gh.appendChild(h);
        docList.appendChild(gh);
      }
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
      const pagesTxt = d.pageCount === 1 ? '1 Seite' : `${d.pageCount} Seiten`;
      const when = (mode === 'letter' || mode === 'sender') && letterDay(d) ? `Brief vom ${fmtDay(letterDay(d))}` : fmtDate(d.updated);
      info.textContent = `${pagesTxt} · ${when}`;
      meta.append(name, info);
      const nd = nextDeadline(d);
      let dlText = '';
      if (nd) {
        const badge = document.createElement('span');
        badge.className = `dl-badge ${dlUrgency(nd)}`;
        dlText = `${dlPhrase(nd)} ${fmtDay(nd.date)}${nd.time ? ' ' + nd.time + ' Uhr' : ''} (${relDays(nd.date)})`;
        badge.innerHTML = '<svg class="ic"><use href="#i-clock"/></svg>';
        const short = fmtDay(nd.date).slice(0, nd.date.slice(0, 4) === todayIso().slice(0, 4) ? 6 : 10);
        badge.append(`${dlPhrase(nd)} ${short}${nd.time ? ' ' + nd.time : ''} · ${relDays(nd.date)}`);
        meta.append(badge);
      }
      if (d.tags && d.tags.length) {
        const tg = document.createElement('span');
        tg.className = 'doc-tags';
        for (const t of d.tags) { const c = document.createElement('span'); c.className = 'tag'; c.textContent = t; tg.appendChild(c); }
        meta.append(tg);
      }
      if (snip) {
        const sn = document.createElement('span');
        sn.className = 'doc-snippet';
        highlight(sn, snip, q);
        meta.append(sn);
      }
      open.append(thumbEl, meta);
      open.setAttribute('aria-label', `${d.name}, ${pagesTxt}, ${when}${dlText ? ', ' + dlText : ''}${d.tags && d.tags.length ? ', Schlagwörter: ' + d.tags.join(', ') : ''} – öffnen`);
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
    $('#libTools').hidden = n < 2 && !allTags().length;
    $('#libNoHits').hidden = !(n && !shown);
    $('#libNoHits').textContent = q ? 'Keine Treffer.' : 'Keine Dokumente in dieser Auswahl.';
    $('#libInfo').textContent = n === 0 ? 'Keine Dokumente' : n === 1 ? '1 Dokument' : `${n} Dokumente`;
    updateHomeHint();
  }
  $('#libSort').addEventListener('change', (e) => { settings.libSort = e.target.value; saveSettings(); renderLibrary(); });

  function renderDocHeader() {
    const d = currentDoc;
    $('#docName').textContent = d ? d.name : 'Neues Dokument';
    const n = pages.length;
    $('#docInfo').textContent = n === 0 ? 'Keine Seiten' : n === 1 ? '1 Seite' : `${n} Seiten`;
    $('#docTitle').setAttribute('aria-label', `${d ? d.name : 'Neues Dokument'}, ${$('#docInfo').textContent} – umbenennen`);
    renderDocMeta();
  }

  /** Fristen und Schlagwörter oben in der Dokumentansicht. */
  function renderDocMeta() {
    const d = currentDoc;
    const bar = $('#docMetaBar');
    bar.hidden = !d || !pages.length;
    if (!d) return;
    const ul = $('#dlList');
    ul.textContent = '';
    for (const x of docDeadlines(d)) {
      const li = document.createElement('li');
      li.className = `dl-item ${dlUrgency(x)}`;
      const txt = document.createElement('div');
      txt.className = 'dl-text';
      const b = document.createElement('b');
      b.textContent = `${dlPhrase(x)} ${fmtDay(x.date, true)}${x.time ? ', ' + x.time + ' Uhr' : ''}`;
      const sub = document.createElement('span');
      sub.className = 'muted small';
      sub.textContent = x.done ? 'Erledigt' : `${relDays(x.date)}${x.approx ? ' · berechnet, bitte prüfen' : ''}${x.source === 'manual' ? ' · eigene Frist' : ''}`;
      txt.append(b, sub);
      if (x.snippet) { li.title = x.snippet; }
      const acts = document.createElement('div');
      acts.className = 'dl-acts';
      const mk = (icon, label, fn, cls) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-btn' + (cls ? ' ' + cls : '');
        btn.setAttribute('aria-label', label);
        btn.title = label;
        btn.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg>`;
        btn.addEventListener('click', fn);
        return btn;
      };
      if (!x.done) acts.append(mk('i-cal', 'In den Kalender', () => addToCalendar(d, x)));
      acts.append(mk(x.done ? 'i-undo' : 'i-check', x.done ? 'Wieder öffnen' : 'Erledigt', () => toggleDone(d, x)));
      acts.append(mk('i-pencil', 'Bearbeiten', () => editDeadline(d, x)));
      li.append(txt, acts);
      ul.appendChild(li);
    }
    ul.hidden = !ul.children.length;
    const tagBox = $('#docTags');
    tagBox.textContent = '';
    for (const t of d.tags || []) { const c = document.createElement('span'); c.className = 'tag'; c.textContent = t; tagBox.appendChild(c); }
    tagBox.hidden = !(d.tags && d.tags.length);
  }
  function saveDocMeta(d) {
    DB.putDoc(d);
    renderLibrary();
    if (currentDoc === d) renderDocMeta();
  }
  function toggleDone(d, x) {
    d.dlDone = { ...(d.dlDone || {}) };
    if (d.dlDone[x.id]) delete d.dlDone[x.id]; else d.dlDone[x.id] = true;
    saveDocMeta(d);
    toast(d.dlDone[x.id] ? `${x.label} als erledigt markiert.` : `${x.label} wieder offen.`);
  }

  // Frist hinzufügen / bearbeiten
  const dlDialog = $('#dlDialog');
  let dlEdit = null; // { doc, item|null }
  function editDeadline(d, x) {
    dlEdit = { doc: d, item: x || null };
    $('#dlTitle').textContent = x ? 'Frist bearbeiten' : 'Frist hinzufügen';
    $('#dlLabel').value = x ? x.label : '';
    $('#dlDate').value = x ? x.date : '';
    $('#dlTime').value = x && x.time ? x.time : '';
    $('#dlRemove').hidden = !x;
    $('#dlError').hidden = true;
    dlDialog.showModal();
  }
  $('#dlAdd').addEventListener('click', () => { if (currentDoc) editDeadline(currentDoc, null); });
  function saveDeadline() {
    const { doc: d, item: x } = dlEdit || {};
    if (!d) return;
    const date = $('#dlDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { $('#dlError').textContent = 'Bitte ein Datum wählen.'; $('#dlError').hidden = false; return; }
    const label = $('#dlLabel').value.replace(/\s+/g, ' ').trim() || 'Frist';
    const time = $('#dlTime').value || null;
    const manual = (d.manualDeadlines || []).slice();
    if (x && x.source === 'manual') manual.splice(manual.findIndex((m) => m.id === x.id), 1);
    else if (x) d.dlHidden = { ...(d.dlHidden || {}), [x.id]: true }; // erkannte Frist durch eigene ersetzen
    manual.push({ id: 'm-' + uid(), date, time, label, snippet: x ? x.snippet : '', approx: false, source: 'manual' });
    d.manualDeadlines = manual;
    dlDialog.close();
    saveDocMeta(d);
  }
  $('#dlSave').addEventListener('click', saveDeadline);
  $('#dlForm').addEventListener('submit', (e) => { e.preventDefault(); saveDeadline(); });
  $('#dlRemove').addEventListener('click', () => {
    const { doc: d, item: x } = dlEdit || {};
    if (!d || !x) return;
    if (x.source === 'manual') d.manualDeadlines = (d.manualDeadlines || []).filter((m) => m.id !== x.id);
    else d.dlHidden = { ...(d.dlHidden || {}), [x.id]: true };
    dlDialog.close();
    saveDocMeta(d);
    toast('Frist entfernt.', {
      label: 'Rückgängig',
      onClick: () => {
        if (x.source === 'manual') d.manualDeadlines = (d.manualDeadlines || []).concat([{ ...x, done: undefined }]);
        else { d.dlHidden = { ...(d.dlHidden || {}) }; delete d.dlHidden[x.id]; }
        saveDocMeta(d);
      },
    });
  });

  // Kalendereintrag (.ics) mit Erinnerung
  function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function icsFold(line) {
    const out = [];
    let cur = '', bytes = 0;
    for (const ch of line) {
      const b = new TextEncoder().encode(ch).length;
      if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function buildIcs(d, x) {
    const ymd = x.date.replace(/-/g, '');
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const summary = `${x.label === 'Termin' ? 'Termin' : x.label}: ${d.name}`;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DokScan//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      `UID:${d.id}-${x.id.replace(/[^\w-]/g, '')}@dokscan`, `DTSTAMP:${now}`];
    if (x.time) {
      const [hh, mm] = x.time.split(':').map(Number);
      const end = new Date(+x.date.slice(0, 4), +x.date.slice(5, 7) - 1, +x.date.slice(8, 10), hh + 1, mm);
      const p = (n) => String(n).padStart(2, '0');
      lines.push(`DTSTART:${ymd}T${p(hh)}${p(mm)}00`, `DTEND:${end.getFullYear()}${p(end.getMonth() + 1)}${p(end.getDate())}T${p(end.getHours())}${p(end.getMinutes())}00`);
    } else {
      const next = new Date(+x.date.slice(0, 4), +x.date.slice(5, 7) - 1, +x.date.slice(8, 10) + 1);
      const p = (n) => String(n).padStart(2, '0');
      lines.push(`DTSTART;VALUE=DATE:${ymd}`, `DTEND;VALUE=DATE:${next.getFullYear()}${p(next.getMonth() + 1)}${p(next.getDate())}`, 'TRANSP:TRANSPARENT');
    }
    lines.push(`SUMMARY:${icsEscape(summary)}`, `DESCRIPTION:${icsEscape((x.snippet ? `„${x.snippet}“\n\n` : '') + 'Dokument in DokScan: ' + d.name)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(summary)}`,
      // Erinnerung: bei Terminen 2 Stunden vorher, bei Fristen 3 Tage vorher um 9 Uhr
      x.time ? 'TRIGGER:-PT2H' : 'TRIGGER:-P2DT15H', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }
  function addToCalendar(d, x) {
    const ics = buildIcs(d, x);
    const name = `${x.label} ${x.date}.ics`.replace(/[\\/:*?"<>|]+/g, '-');
    const file = new File([ics], name, { type: 'text/calendar' });
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    // iPad/iPhone: Safari zeigt Kalendereinträge direkt zum Hinzufügen an; sonst als Datei speichern
    if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) a.target = '_blank';
    else a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Kalendereintrag erstellt – mit Erinnerung vorher.');
  }

  // Schlagwörter
  const tagDialog = $('#tagDialog');
  let tagDoc = null;
  function tagSuggestions(d) {
    const out = [];
    const L = d.letter || {};
    if (L.sender) out.push(L.sender);
    const k = DocName.kindBase(L.kind);
    if (k) out.push(k);
    if (L.date) out.push(L.date.slice(0, 4));
    return [...new Set(out)].filter((t) => !(d.tags || []).includes(t));
  }
  function renderTagDialog() {
    const d = tagDoc;
    const all = [...new Set(allTags().concat(d.tags || []))].sort((a, b) => a.localeCompare(b, 'de'));
    const box = $('#tagAll');
    box.textContent = '';
    for (const t of all) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('aria-pressed', String((d.tags || []).includes(t)));
      b.textContent = t;
      b.addEventListener('click', () => toggleTag(t));
      box.appendChild(b);
    }
    $('#tagNone').hidden = all.length > 0;
    const sug = tagSuggestions(d).filter((t) => !all.includes(t));
    const sb = $('#tagSuggest');
    sb.textContent = '';
    for (const t of sug) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-suggest';
      b.textContent = '+ ' + t;
      b.setAttribute('aria-label', `Schlagwort „${t}“ hinzufügen`);
      b.addEventListener('click', () => toggleTag(t));
      sb.appendChild(b);
    }
    $('#tagSuggestWrap').hidden = !sug.length;
  }
  function toggleTag(t) {
    const d = tagDoc;
    const tags = new Set(d.tags || []);
    if (tags.has(t)) tags.delete(t); else tags.add(t);
    d.tags = [...tags].sort((a, b) => a.localeCompare(b, 'de'));
    saveDocMeta(d);
    renderTagDialog();
  }
  function showTags(d) {
    tagDoc = d;
    $('#tagInput').value = '';
    renderTagDialog();
    tagDialog.showModal();
  }
  function addTagFromInput() {
    const v = $('#tagInput').value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!v || !tagDoc) return;
    if (!(tagDoc.tags || []).includes(v)) toggleTag(v);
    $('#tagInput').value = '';
    $('#tagInput').focus();
  }
  $('#tagAdd').addEventListener('click', addTagFromInput);
  $('#tagForm').addEventListener('submit', (e) => { e.preventDefault(); addTagFromInput(); });
  $('#tagDone').addEventListener('click', () => { addTagFromInput(); tagDialog.close(); });
  $('#docTagsEdit').addEventListener('click', () => { if (currentDoc) showTags(currentDoc); });

  /** Dokument öffnen (Seiten aus dem Speicher laden) und Dokumentansicht zeigen. */
  async function openDoc(d) {
    if (currentDoc !== d || !pages.length) {
      pages.forEach(dropUrls);
      currentDoc = d;
      const token = (openDoc.token = (openDoc.token || 0) + 1);
      const recs = ((await DB.pagesOf(d.id)) || []).sort((a, b) => a.order - b.order);
      if (token !== openDoc.token || currentDoc !== d) return; // inzwischen anderes Dokument geöffnet
      const loaded = recs.map((r) => inflight.get(r.id) || { ...r, pending: false, error: false });
      // Seiten, die während des Ladens hinzugekommen sind, behalten
      const extra = pages.filter((p) => p.docId === d.id && !loaded.some((q) => q.id === p.id));
      pages = loaded.concat(extra).filter((p) => !p.deleted);
    }
    renderGrid();
    $('#overview').scrollTop = 0;
    if (topScreen() !== 'docview') openScreen('docview');
    pages.filter((p) => (!p.processed || !p.thumb) && !p.pending).forEach(schedule);
    if (settings.ocr) pages.forEach((p) => { if (p.processed && p.procKey && !(p.ocr && p.ocr.key === p.procKey)) ensureOcr(p).catch(() => {}); });
  }

  function onDocClosed() {
    setSelecting(false);
    pages.forEach(dropUrls);
    pages = [];
    currentDoc = null;
    renderLibrary();
  }

  async function deleteDoc(d) {
    const n = d.pageCount;
    if (!confirm(`„${d.name}“${n ? ` mit ${n === 1 ? '1 Seite' : `${n} Seiten`}` : ''} löschen?`)) return false;
    docs = docs.filter((x) => x !== d);
    clearTimeout(docTimers.get(d.id)); docTimers.delete(d.id);
    for (const p of inflight.values()) if (p.docId === d.id) p.deleted = true;
    if (currentDoc === d) pages.forEach((p) => { p.deleted = true; });
    await DB.delDocAll(d.id);
    if (currentDoc === d) {
      if (topScreen() === 'docview') closeScreen();
      else { pages.forEach(dropUrls); pages = []; currentDoc = null; }
    }
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
    let auto = null;
    try { auto = DocName.suggest(d.text || '', { created: d.created }); } catch { auto = null; }
    if (auto && !sug.includes(auto.name)) sug.unshift(auto.name);
    if (sug.length > 4) sug.length = 4;
    $('#nameAutoHint').hidden = !(d.auto && !d.named);
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
    d.auto = false;
    if (!v) { delete d.autoKey; applyAutoName(d); } // leer = wieder automatisch benennen
    d.updated = Date.now();
    DB.putDoc(d);
    nameDialog.close();
    renaming = null;
    renderLibrary();
    if (currentDoc === d) renderDocHeader();
  }
  $('#nameSave').addEventListener('click', saveRename);
  // Eingabetaste („Fertig“ auf der iPad-Tastatur) speichert den Namen
  $('#nameForm').addEventListener('submit', (e) => { e.preventDefault(); saveRename(); });
  // Schließen-Knöpfe sind keine Absende-Knöpfe (sonst würde die Eingabetaste den Dialog verwerfen)
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
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
  $('#menuTags').addEventListener('click', () => { docMenu.close(); showTags(menuDoc); });
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
    for (const k of ['thumbUrl', 'processedUrl']) {
      if (p[k]) URL.revokeObjectURL(p[k]);
      delete p[k]; delete p[k + 'Of'];
    }
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
        if (p.camSession && p.camSession === cam.session && blurLevel(p) && topScreen() === 'camera') warnBlurInCamera(p);
        if (settings.ocr && !p.deleted) ensureOcr(p).catch(() => {}); // Text im Hintergrund erkennen
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
    async function detect(videoEl, size, prev) {
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
      const r = await w.call({ type: 'live', bitmap, size, prev: prev || null }, 5000, [bitmap]);
      return r.ok ? r.result : null;
    }
    /** Kamerabild als JPEG speichern – in diesem Thread, damit ein Foto nicht auf die Seitenverarbeitung wartet. */
    async function encodeFrame(videoEl, maxDim) {
      if (!window.createImageBitmap || !(await w.init())) return null;
      let bitmap;
      try { bitmap = await createImageBitmap(videoEl); } catch { return null; }
      const r = await w.call({ type: 'encode', bitmap, maxDim }, 30000, [bitmap]);
      return r.ok ? r.result : null;
    }
    return { detect, init: w.init, encodeFrame };
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
    /** Bild verkleinern/komprimieren (im Worker, sonst im Hauptthread). */
    async function reencode(blob, dim, q) {
      if (await init()) {
        const r = await call({ type: 'reencode', blob, dim, q }, 60000);
        if (r.ok) return r.result;
      }
      const img = await Img.load(blob);
      const c = Img.draw(img, dim);
      const out = { blob: await Img.toBlob(c, 'image/jpeg', q), w: c.width, h: c.height };
      Img.release(c);
      return out;
    }
    /** Entzerrte Seite ohne Filter als Canvas in Vorschaugröße (für die Regler). */
    async function prepareView(job) {
      if (await init()) {
        const r = await call({ ...job, type: 'prepare' }, 60000);
        if (r.ok) {
          const img = await Img.load(r.result.blob);
          const c = Img.draw(img, job.maxDim);
          Img.release(img);
          return c;
        }
      }
      return (await Img.prepare(job)).c;
    }
    return { run, init, encodeFrame, reencode, prepareView };
  })();

  async function processPage(p) {
    const res = await Proc.run({
      original: p.original, rotation: p.rotation, corners: p.corners, filter: p.filter,
      adjust: { b: p.bright || 0, c: p.contrast || 0 }, autoDetect: !!p.autoDetect, maxDim: MAX_DIM,
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

  function addFromCanvas(c, hint, doc) {
    return track(Img.toBlob(c, 'image/jpeg', 0.92).then((original) => addOriginal(original, hint, { doc })));
  }

  /** Dokument, in das gerade aufgenommen/importiert wird (wird bei Bedarf angelegt). */
  const targetDoc = () => currentDoc || (currentDoc = newDoc());
  const docAlive = (d) => !!d && docs.includes(d);

  /**
   * Neue Seite anlegen. opts.doc legt das Zieldokument fest (beim Start des Imports/der Aufnahme
   * bestimmt), damit Seiten nicht in einem inzwischen geöffneten anderen Dokument landen.
   */
  function addOriginal(original, hint, opts = {}) {
    // Ränder: vorläufig aus der Live-Erkennung, genau erkannt wird im Hintergrund auf dem vollen Bild
    const corners = (settings.autoCrop && hint) || Img.FULL.map((x) => x.slice());
    const doc = opts.doc || targetDoc();
    if (!docAlive(doc)) return null; // Dokument wurde inzwischen gelöscht
    const p = {
      id: uid(), docId: doc.id, order: nextOrder(), created: Date.now(), original, rotation: 0, corners,
      filter: opts.filter || settings.filter, processed: null, thumb: null,
      autoDetect: opts.autoDetect != null ? opts.autoDetect : settings.autoCrop,
      pdfText: opts.pdfText || null,
    };
    if (doc === currentDoc) { pages.push(p); renderGrid(); }
    persist(p);
    schedule(p);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return p;
  }

  /** Ersetzt das Foto einer Seite (Neu aufnehmen); Position, Filter und Dokument bleiben. */
  function replacePage(p, original, hint) {
    const prev = { original: p.original, rotation: p.rotation, corners: p.corners, autoDetect: p.autoDetect, processed: p.processed, thumb: p.thumb, pw: p.pw, ph: p.ph, procKey: p.procKey, ocr: p.ocr, blur: p.blur, pdfText: p.pdfText, filter: p.filter, bright: p.bright || 0, contrast: p.contrast || 0 };
    Object.assign(p, {
      original, rotation: 0,
      corners: (settings.autoCrop && hint) || Img.FULL.map((x) => x.slice()),
      autoDetect: settings.autoCrop,
      processed: null, thumb: null, procKey: null, ocr: null, blur: null, pdfText: null, error: false,
    });
    persist(p);
    schedule(p);
    const i = pages.indexOf(p) + 1;
    toast(`Seite ${i} wurde neu aufgenommen.`, {
      label: 'Rückgängig',
      onClick: () => {
        if (p.deleted) return;
        // Filter/Helligkeit, die nach dem Neu-Aufnehmen geändert wurden, bleiben erhalten
        const keep = { filter: p.filter, bright: p.bright || 0, contrast: p.contrast || 0 };
        const same = keep.filter === prev.filter && keep.bright === prev.bright && keep.contrast === prev.contrast;
        Object.assign(p, prev, keep, { error: false });
        p.rev = (p.rev || 0) + 1; // laufende Verarbeitung des neuen Fotos verwerfen
        queue.splice(0, queue.length, ...queue.filter((x) => x !== p));
        p.pending = false;
        if (same) { persist(p); releaseInflight(p); } else schedule(p); // altes Foto mit aktuellem Filter neu aufbereiten
        renderCard(p);
        if (editor.page === p) { updatePreview(); markChips($('#filterChips'), p.filter); }
        toast('Vorheriges Foto wiederhergestellt.');
      },
    });
  }

  /** PDF importieren: jede Seite als Bild (ohne Zuschnitt, Filter „Original“), vorhandener Text wird übernommen. */
  async function addPdf(file, doc) {
    let n = 0, total = 0;
    const gen = PdfImport.pages(file, {
      askPassword: (wrong) => prompt(wrong ? 'Falsches Passwort. Bitte erneut eingeben:' : `„${file.name}“ ist passwortgeschützt. Passwort:`),
      onStart: (t) => {
        total = t;
        if (t > 200 && !confirm(`Das PDF hat ${t} Seiten. Wirklich alle importieren?`)) throw Object.assign(new Error('Import abgebrochen'), { cancelled: true });
      },
    });
    toast('PDF wird geöffnet …');
    for await (const pg of gen) {
      if (!docAlive(doc)) { toast('Import abgebrochen – Dokument wurde gelöscht.'); break; }
      const job = Promise.resolve(addOriginal(pg.blob, null, {
        doc, autoDetect: false, filter: 'original',
        pdfText: pg.text ? { ...pg.text, w: pg.w, h: pg.h } : null,
      }));
      if (!(await track(job))) break;
      n++;
      toast(`PDF wird importiert: Seite ${n} von ${total} …`);
    }
    return n;
  }

  let importing = 0; // laufende Importe (Service-Worker-Neuladen wartet darauf)
  async function addFiles(files, doc) {
    const all = [...files];
    const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name);
    const list = all.filter((f) => isImage(f) || PdfImport.isPdf(f));
    if (!list.length) return 0;
    doc = doc || targetDoc();
    let ok = 0, i = 0;
    const images = list.filter((f) => !PdfImport.isPdf(f)).length;
    importing++;
    try {
    for (const f of list) {
      if (!docAlive(doc)) break;
      if (!PdfImport.isPdf(f) && images > 1) toast(`Foto ${++i} von ${images} wird importiert …`, null, 60000);
      if (PdfImport.isPdf(f)) {
        try { ok += await addPdf(f, doc); }
        catch (e) {
          console.error(e);
          toast(e.cancelled ? 'PDF-Import abgebrochen.'
            : /geladen/.test(e.message || '') ? e.message + (navigator.onLine ? '.' : ' – beim ersten Mal ist eine Internetverbindung nötig.')
              : `„${f.name}“ konnte nicht gelesen werden.`, null, 5000);
        }
        continue;
      }
      try {
        const img = await Img.load(f);
        const c = Img.draw(img, MAX_DIM);
        const p = await addFromCanvas(c, null, doc);
        Img.release(c);
        if (p) ok++;
      } catch (e) {
        console.error(e);
        toast(`„${f.name}“ konnte nicht gelesen werden.`);
      }
    }
    } finally { importing--; }
    if (images > 1) toast(ok === 1 ? '1 Seite importiert.' : `${ok} Seiten importiert.`);
    return ok;
  }

  // ---------- Unschärfe ----------
  // Kalibriert an Testseiten: ≤ 0,46 gut lesbar, ab ~0,5 sichtbar unscharf, ab ~0,6 schwer lesbar
  const BLUR_WARN = 0.5, BLUR_BAD = 0.6;
  const blurLevel = (p) => (!settings.blurWarn || p.blur == null ? 0 : p.blur >= BLUR_BAD ? 2 : p.blur >= BLUR_WARN ? 1 : 0);

  // ---------- Texterkennung ----------
  /** Liefert den erkannten Text der aktuellen Seitenversion (aus Cache oder neu erkannt). */
  function ensureOcr(p, onProgress) {
    const key = p.procKey;
    if (p.deleted) return Promise.reject(new Error('Seite wurde gelöscht.'));
    if (!p.processed || !key) return Promise.reject(new Error('Seite ist noch nicht fertig verarbeitet.'));
    if (p.ocr && p.ocr.key === key) return Promise.resolve(p.ocr);
    // Seite aus einem PDF mit Text: Text direkt übernehmen (exakt, ohne Texterkennung), solange
    // die Seite weder gedreht noch zugeschnitten wurde
    if (p.pdfText && !p.rotation && Img.isFull(p.corners) && p.pw) {
      const sx = p.pw / p.pdfText.w, sy = p.ph / p.pdfText.h;
      const words = p.pdfText.words.map(([s, x0, y0, x1, y1, b, lh]) => [s, x0 * sx, y0 * sy, x1 * sx, y1 * sy, b * sy, lh * sy]);
      const ocr = { key, text: p.pdfText.text, words, fromPdf: true };
      p.ocr = ocr;
      persist(p);
      return Promise.resolve(ocr);
    }
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
    $('#docSelect').hidden = n < 2;
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
      `<span class="card-num"></span><span class="card-blur" hidden><svg class="ic"><use href="#i-warn"/></svg>unscharf</span>` +
      `<span class="drag" role="button" tabindex="-1" aria-label="Verschieben"><svg class="ic"><use href="#i-grip"/></svg></span>` +
      `<span class="card-check"><svg class="ic"><use href="#i-check"/></svg></span>`;
    fillCard(li, p, i);
    return li;
  }

  function fillCard(li, p, i) {
    li.querySelector('.card-num').textContent = String(i + 1);
    const lvlA = p.pending ? 0 : blurLevel(p);
    const open = li.querySelector('.card-open');
    open.setAttribute('aria-label', `Seite ${i + 1}${p.error ? ', Fehler' : ''}${lvlA ? ', unscharf' : ''}${p.pending ? ', wird bearbeitet' : ''} – ${sel.on ? 'auswählen' : 'bearbeiten'}`);
    if (sel.on) open.setAttribute('aria-pressed', String(sel.ids.has(p.id))); else open.removeAttribute('aria-pressed');
    const url = urlFor(p, 'thumb');
    const img = li.querySelector('img');
    if (url && img.getAttribute('src') !== url) img.src = url;
    img.hidden = !url;
    li.classList.toggle('loading', !!p.pending);
    li.classList.toggle('error', !!p.error);
    li.classList.toggle('selected', sel.ids.has(p.id));
    const lvl = p.pending ? 0 : blurLevel(p);
    const badge = li.querySelector('.card-blur');
    badge.hidden = !lvl;
    badge.classList.toggle('bad', lvl === 2);
  }

  function renderCard(p) {
    const li = grid.querySelector(`li[data-id="${p.id}"]`);
    if (li) fillCard(li, p, pages.indexOf(p));
  }

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.card-open');
    if (!btn) return;
    const p = pages.find((x) => x.id === btn.closest('li').dataset.id);
    if (!p) return;
    if (sel.on) { if (sel.ids.has(p.id)) sel.ids.delete(p.id); else sel.ids.add(p.id); renderSelection(); return; }
    openEditor(p);
  });

  // ---------- Mehrere Seiten auswählen und gemeinsam bearbeiten ----------
  const sel = { on: false, ids: new Set() };
  const selectedPages = () => pages.filter((p) => sel.ids.has(p.id));
  function setSelecting(on) {
    sel.on = on && pages.length > 0;
    sel.ids.clear();
    $('#docview').classList.toggle('selecting', sel.on);
    if (sel.on) buildChips($('#selFilter'), null, applyFilterToSelection);
    renderSelection();
  }
  function renderSelection() {
    grid.querySelectorAll(':scope > li').forEach((li, i) => { li.classList.toggle('selected', sel.ids.has(li.dataset.id)); if (pages[i]) fillCard(li, pages[i], i); });
    const n = sel.ids.size;
    $('#selCount').textContent = n === 0 ? 'Seiten auswählen' : n === 1 ? '1 Seite ausgewählt' : `${n} Seiten ausgewählt`;
    $('#selAll').textContent = n === pages.length && n > 0 ? 'Keine' : 'Alle';
    for (const id of ['#selRotL', '#selRotR', '#selDelete']) $(id).disabled = n === 0;
    $('#selFilter').querySelectorAll('.chip').forEach((b) => { b.disabled = n === 0; });
    // gemeinsamer Filter der Auswahl hervorheben
    const fs = new Set(selectedPages().map((p) => p.filter));
    markChips($('#selFilter'), fs.size === 1 ? [...fs][0] : null);
  }
  function applyFilterToSelection(f) {
    const list = selectedPages();
    if (!list.length) return;
    for (const p of list) if (p.filter !== f) { p.filter = f; schedule(p); }
    renderSelection();
    const label = (FILTERS.find(([k]) => k === f) || [f, f])[1];
    toast(`Filter „${label}“ für ${list.length === 1 ? '1 Seite' : `${list.length} Seiten`}.`);
  }
  $('#docSelect').addEventListener('click', () => setSelecting(true));
  $('#selDone').addEventListener('click', () => setSelecting(false));
  $('#selAll').addEventListener('click', () => {
    if (sel.ids.size === pages.length) sel.ids.clear(); else pages.forEach((p) => sel.ids.add(p.id));
    renderSelection();
  });
  $('#selRotL').addEventListener('click', () => { selectedPages().forEach((p) => rotatePageBy(p, -1)); });
  $('#selRotR').addEventListener('click', () => { selectedPages().forEach((p) => rotatePageBy(p, 1)); });
  /** Seiten löschen – mit „Rückgängig“ statt Rückfrage. */
  function deletePages(list) {
    if (!list.length) return;
    const doc = currentDoc;
    const removed = list.map((p) => ({ p, i: pages.indexOf(p) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
    for (const { p } of removed) { p.deleted = true; DB.del(p.id); dropUrls(p); }
    pages = pages.filter((p) => !p.deleted);
    persistAll();
    if (doc) touchDoc(doc.id);
    renderGrid();
    const n = removed.length;
    toast(n === 1 ? `Seite ${removed[0].i + 1} gelöscht.` : `${n} Seiten gelöscht.`, {
      label: 'Rückgängig',
      onClick: () => {
        if (currentDoc !== doc || !docAlive(doc)) { toast('Rückgängig nicht mehr möglich.'); return; }
        for (const { p, i } of removed) {
          p.deleted = false;
          pages.splice(Math.min(i, pages.length), 0, p);
          if (!p.processed || p.pending) { p.pending = false; schedule(p); }
        }
        persistAll();
        renderGrid();
        if (sel.on) renderSelection();
        toast(n === 1 ? 'Seite wiederhergestellt.' : `${n} Seiten wiederhergestellt.`);
      },
    });
  }
  $('#selDelete').addEventListener('click', () => {
    const list = selectedPages();
    if (!list.length) return;
    deletePages(list);
    setSelecting(pages.length > 0);
  });

  // Umsortieren per Ziehen am Griff. Die Zeiger-Erfassung liegt auf dem Raster (nicht auf dem Griff),
  // weil die Karte beim Verschieben im DOM umgehängt wird und der Griff sonst die Erfassung verliert.
  let dragging = null;
  grid.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag');
    if (!handle || sel.on || dragging || e.button > 0) return;
    e.preventDefault();
    const li = handle.closest('li');
    const pid = e.pointerId;
    li.classList.add('dragging');
    try { grid.setPointerCapture(pid); } catch { /* egal */ }
    const main = $('#overview');
    let lastX = e.clientX, lastY = e.clientY;
    const reorderAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      const target = el && el.closest('#pageGrid > li');
      if (!target || target === li) return;
      const items = [...grid.children];
      if (items.indexOf(li) < items.indexOf(target)) target.after(li); else target.before(li);
    };
    const autoScroll = () => {
      const r = main.getBoundingClientRect();
      const edge = 70;
      let dy = 0;
      if (lastY < r.top + edge) dy = -12; else if (lastY > r.bottom - edge) dy = 12;
      if (dy) { main.scrollTop += dy; reorderAt(lastX, lastY); } // auch bei ruhendem Finger weiter einsortieren
    };
    const scrollTimer = setInterval(autoScroll, 16);
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      ev.preventDefault();
      lastX = ev.clientX; lastY = ev.clientY;
      reorderAt(lastX, lastY);
    };
    const end = (ev) => {
      if (ev && ev.pointerId !== undefined && ev.pointerId !== pid) return;
      if (!dragging) return;
      dragging = null;
      clearInterval(scrollTimer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      grid.removeEventListener('lostpointercapture', end);
      try { grid.releasePointerCapture(pid); } catch { /* egal */ }
      li.classList.remove('dragging');
      const order = [...grid.children].map((x) => x.dataset.id);
      const changed = order.length === pages.length && order.some((id, i) => pages[i].id !== id);
      if (changed) {
        const next = order.map((id) => pages.find((p) => p.id === id));
        if (next.every(Boolean)) { pages = next; persistAll(); }
      }
      renderGrid(); // Nummern und Reihenfolge immer aus dem Modell
    };
    dragging = { li };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    grid.addEventListener('lostpointercapture', end);
  });

  // ---------- Bildschirme & Zurück-Taste ----------
  // Ansichten liegen als Stapel übereinander: Ablage → Dokument → Editor/Kamera
  const stack = [];
  const topScreen = () => stack[stack.length - 1] || null;
  const openers = new Map(); // Ansicht → Element, das sie geöffnet hat (Fokus zurück beim Schließen)
  /** Nur die oberste Ansicht ist bedienbar (Tastatur/VoiceOver erreichen nichts dahinter). */
  function syncInert() {
    const top = topScreen();
    $('#app').inert = !!top;
    for (const n of ['docview', 'camera', 'editor']) $('#' + n).inert = n !== top;
    // sichtbarer Hinweis an die neue Ansicht anpassen (z. B. von der Kamera zurück in den Editor)
    const t = $('#toast');
    if (t.classList.contains('show') && t.parentNode === document.body) requestAnimationFrame(() => { t.style.bottom = toastBottom(); });
  }
  function openScreen(name) {
    if (stack.includes(name)) return;
    openers.set(name, document.activeElement);
    stack.push(name);
    const el = $('#' + name);
    el.hidden = false;
    el.style.zIndex = String(10 + stack.length); // zuletzt geöffnete Ansicht liegt oben
    document.body.classList.add('screen-open');
    syncInert();
    // Fokus in die neue Ansicht (Überschrift bzw. erstes Bedienelement)
    const target = el.querySelector('h2[tabindex], [data-autofocus]') || el.querySelector('button:not([hidden]):not(:disabled)');
    if (target) setTimeout(() => { try { target.focus({ preventScroll: true }); } catch { /* egal */ } }, 0);
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
    syncInert();
    const back = openers.get(name);
    openers.delete(name);
    if (back && back.isConnected && !back.closest('[inert]')) setTimeout(() => { try { back.focus({ preventScroll: true }); } catch { /* egal */ } }, 0);
    if (name === 'camera') onCameraClosed();
    if (name === 'editor') onEditorClosed();
    if (name === 'docview') onDocClosed();
  }
  window.addEventListener('popstate', (e) => {
    const depth = (e.state && e.state.dokscan) || 0;
    // Zurück (Taste/Wischgeste) bei offenem Dialog: nur den Dialog schließen, die Ansicht bleibt
    const open = [...document.querySelectorAll('dialog[open]')];
    if (open.length && stack.length > depth) {
      open.forEach((d) => d.close());
      try { history.pushState({ dokscan: stack.length }, ''); } catch { /* egal */ }
      return;
    }
    while (stack.length > depth) popScreen();
  });

  // ---------- Kamera ----------
  const video = $('#video');
  const cam = { stream: null, track: null, added: 0, torch: false, done: false, shooting: false, startGen: 0 };

  function setCamMsg(text, showFallback) {
    $('#camMsg').hidden = !text;
    $('#camMsgText').textContent = text || '';
    $('#camFallback').hidden = !showFallback;
  }

  function updateCamUi() {
    $('#camDone').disabled = false;
    $('#camCount').textContent = String(cam.added);
    const page = cam.retake ? `Seite ${pages.indexOf(cam.retake) + 1} neu` : `Seite ${pages.length + 1}`;
    $('#camDone').hidden = !!cam.retake;
    $('#camLast').hidden = cam.added === 0 || !!cam.retake;
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
  const LIVE_MIN_INTERVAL = 70;   // ms zwischen zwei Erkennungen (≈ 14/s; spart Akku)
  const LIVE_IDLE_INTERVAL = 160; // nach einer Aufnahme (Warten auf die nächste Seite) seltener
  const LIVE_HOLD_MS = 450;       // so lange bleibt der Rahmen nach Aussetzern stehen
  const live = { on: false, gen: 0, quad: null, shown: null, sig: null, lastSeen: 0, jump: null, raf: 0, found: false, useWorker: null };

  function startLive() {
    stopLive();
    if (!settings.autoCrop) return;
    live.on = true;
    // pro Kamera-Sitzung neu versuchen, den Hintergrund-Thread zu nutzen
    if (live.useWorker === false) live.useWorker = null;
    live.fails = 0;
    live.dim = '';
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
      if (!video.videoWidth || cam.shooting || document.hidden || (cam.track && cam.track.muted)) { await sleep(120); continue; }
      if (video.readyState < 2) { await sleep(60); continue; } // noch kein Bild
      // Gerät gedreht → Seitenverhältnis des Videos ändert sich: alter Rahmen passt nicht mehr
      const dim = video.videoWidth + 'x' + video.videoHeight;
      if (dim !== live.dim) {
        if (live.dim) { live.quad = null; live.shown = null; live.jump = null; resetAuto(); }
        live.dim = dim;
      }
      const t0 = performance.now();
      let res = null;
      if (live.useWorker) {
        res = await LiveW.detect(video, 192, live.quad);
        if (res) live.fails = 0;
        else if (++live.fails >= 5) { live.useWorker = false; live.sig = null; } // erst nach mehreren Fehlern auf den Hauptthread
      }
      if (!res) {
        let q = null;
        try { q = Img.detect(video, 160, true, live.quad); } catch { q = null; }
        res = { quad: q, sig: null };
      }
      if (!live.on || live.gen !== gen) break;
      onDetection(res.quad, res.sig);
      const cost = performance.now() - t0;
      // im Hauptthread mehr Pause lassen, damit die Bedienung flüssig bleibt
      const every = auto.waiting ? LIVE_IDLE_INTERVAL : LIVE_MIN_INTERVAL;
      await sleep(live.useWorker ? Math.max(0, every - cost) : Math.max(every, 120, cost * 1.5));
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
    if (!found) { if (poly.hasAttribute('points')) { poly.removeAttribute('points'); poly.dataset.pts = ''; } return; }
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!liveBox || liveBox.vw !== vw || liveBox.vh !== vh) {
      const r = svg.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      liveBox = { vw, vh, s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2 };
      svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    }
    const { s, ox, oy } = liveBox;
    const pts = q.map(([x, y]) => `${(ox + x * vw * s).toFixed(1)},${(oy + y * vh * s).toFixed(1)}`).join(' ');
    if (pts !== poly.dataset.pts) { poly.dataset.pts = pts; poly.setAttribute('points', pts); } // nur bei Änderung
  }

  async function startStream() {
    stopStream();
    // Zähler: überholte Starts (schnelles Umschalten, kurz in den Hintergrund) beenden ihren Strom selbst
    const gen = ++cam.startGen;
    setCamMsg('Kamera wird gestartet …', false);
    // „Weites Sichtfeld“: 4:3-Format in mittlerer Auflösung – iPads schneiden bei sehr hohen Auflösungen das Bild zu.
    const res = settings.wideFov
      ? { width: { ideal: 1920 }, height: { ideal: 1440 }, aspectRatio: { ideal: 4 / 3 } }
      : { width: { ideal: 4096 }, height: { ideal: 3072 } };
    const byFacing = { facingMode: { ideal: 'environment' }, ...res };
    let stream = null;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: settings.camDevice ? { deviceId: { exact: settings.camDevice }, ...res } : byFacing,
        });
      } catch (e) {
        if (!settings.camDevice || e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
        settings.camDevice = ''; // gespeicherte Kamera gibt es nicht mehr
        saveSettings();
        if (gen !== cam.startGen) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: byFacing });
      }
    } catch (e) {
      if (gen !== cam.startGen) return;
      console.warn(e);
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      if (denied) cam.denied = true; // für diese Sitzung merken: nächstes Mal gleich die Kamera-App
      setCamMsg(denied
        ? (/iPad|iPhone|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1
          ? 'Kein Zugriff auf die Kamera. Erlaube ihn unter Einstellungen › Safari › Kamera (oder „aA“ › Website-Einstellungen) – oder nutze die Kamera-App.'
          : 'Kein Zugriff auf die Kamera. Erlaube den Zugriff in den Browser-Einstellungen oder nutze die Kamera-App.')
        : 'Die Kamera konnte nicht gestartet werden. Du kannst stattdessen die Kamera-App verwenden.', true);
      return;
    }
    if (gen !== cam.startGen || topScreen() !== 'camera' || document.hidden) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    cam.stream = stream;
    cam.track = stream.getVideoTracks()[0];
    watchTrack(cam.track, gen);
    video.srcObject = stream;
    try { await video.play(); } catch { /* autoplay */ }
    if (gen !== cam.startGen) return;
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

  /** Unterbrechungen der Kamera (Split View, Anruf, andere App) anzeigen und danach neu starten. */
  function watchTrack(track, gen) {
    const current = () => gen === cam.startGen && cam.track === track && topScreen() === 'camera';
    track.onmute = () => { if (current()) { setCamMsg('Kamera pausiert – z. B. durch Split View, einen Anruf oder eine andere App.', false); resetAuto(); } };
    track.onunmute = () => { if (current()) setCamMsg('', false); };
    track.onended = () => {
      if (!current()) return;
      setCamMsg('Die Kamera wurde unterbrochen. Sie wird neu gestartet …', false);
      setTimeout(() => { if (current() && !document.hidden) startStream(); }, 800);
    };
  }

  function stopStream() {
    cam.startGen++;
    stopLive();
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    cam.track = null;
    video.srcObject = null;
  }

  /** Kamera öffnen; fromLibrary = neues Dokument anlegen (erst beim ersten Foto). */
  /** Kamera öffnen; fromLibrary = neues Dokument anlegen (erst beim ersten Foto); retake = Seite ersetzen. */
  function openCamera(fromLibrary, retake = null) {
    cam.retake = retake;
    cam.retakeStay = false;
    cam.session = uid();
    cam.newDoc = !retake && !!fromLibrary;
    if (cam.newDoc) { pages.forEach(dropUrls); pages = []; currentDoc = null; renderGrid(); }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || cam.denied) {
      useCameraApp();
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
    const wasRetake = !!cam.retake && !cam.retakeStay;
    cam.retake = null;
    cam.retakeStay = false;
    cam.session = null;
    if (wasRetake) { cam.added = 0; return; }
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

  /** Hinweis in der Kamera: letzte Aufnahme unscharf → direkt neu aufnehmen (Kamera bleibt offen). */
  function warnBlurInCamera(p) {
    if (cam.retake) return;
    const i = pages.indexOf(p) + 1;
    if (!i) return;
    toast(`Seite ${i} wirkt unscharf.`, {
      label: 'Neu aufnehmen',
      onClick: () => {
        if (topScreen() !== 'camera' || !pages.includes(p)) return;
        cam.retake = p;
        cam.retakeStay = true;
        auto.waiting = false; // dieselbe Seite darf sofort wieder automatisch ausgelöst werden
        resetAuto();
        updateCamUi();
      },
    });
  }

  async function shoot() {
    if (!video.videoWidth || cam.shooting) return;
    cam.shooting = true;
    if (!auto.waiting) { resetAuto(); auto.waiting = true; try { auto.sig = signature(); } catch { auto.sig = null; } }
    const flash = $('#camFlash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    if (navigator.vibrate) navigator.vibrate(15);
    const hint = live.quad && live.quad.map((p) => p.slice());
    const retake = cam.retake;
    // neues Foto: als neue Seite anhängen – oder beim Neu-Aufnehmen die Seite ersetzen
    const stay = cam.retakeStay;
    const session = cam.session;
    const doc = retake ? null : targetDoc();
    const deliver = (original) => {
      if (retake) { if (!retake.deleted) { replacePage(retake, original, hint); retake.camSession = session; } }
      else { const np = addOriginal(original, hint, { doc }); if (np) np.camSession = session; }
    };
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
        const enc = (await LiveW.encodeFrame(video, MAX_DIM)) || (await Proc.encodeFrame(video, MAX_DIM));
        if (enc) {
          showThumb(enc.thumb);
          deliver(enc.original);
          return;
        }
        const c = Img.draw(video, MAX_DIM);
        const t = Img.draw(c, 160);
        const thumbBlob = Img.toBlob(t, 'image/jpeg', 0.7);
        const original = await Img.toBlob(c, 'image/jpeg', 0.92);
        Img.release(c);
        showThumb(await thumbBlob);
        Img.release(t);
        deliver(original);
      })());
      updateCamUi();
      // Neu aufnehmen aus dem Editor: zurück zum Editor; aus der Kamera-Warnung: weiter fotografieren
      if (retake && stay) { cam.retake = null; cam.retakeStay = false; updateCamUi(); }
      else if (retake && topScreen() === 'camera') closeScreen();
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
  // Kamera-App des Geräts: was beim Öffnen der Kamera gewollt war, gilt auch für das Foto von dort
  let pendingCapture = null;
  function useCameraApp() {
    pendingCapture = { retake: cam.retake, newDoc: cam.newDoc };
    $('#fileCapture').click();
  }
  $('#camFallback').addEventListener('click', () => {
    const intent = { retake: cam.retake, newDoc: cam.newDoc };
    cam.done = false;
    cam.newDoc = false; // nicht beim Schließen ein leeres Dokument öffnen
    closeScreen();
    pendingCapture = intent;
    $('#fileCapture').click();
  });
  $('#camTorch').addEventListener('click', async () => {
    if (!cam.track) return;
    try {
      cam.torch = !cam.torch;
      await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] });
      $('#camTorch').setAttribute('aria-pressed', String(cam.torch));
    } catch { cam.torch = false; toast('Licht wird nicht unterstützt.'); }
  });
  document.addEventListener('keydown', (e) => {
    if (topScreen() !== 'camera' || e.repeat || !(e.code === 'Space' || e.code === 'Enter')) return;
    if (e.target && e.target.closest && e.target.closest('button, input, select, textarea, a, [role="button"]')) return; // Knopf bedienen
    e.preventDefault();
    shoot();
  });
  document.addEventListener('visibilitychange', () => {
    if (topScreen() !== 'camera') return;
    if (document.hidden) stopStream(); else startStream();
  });

  // Importieren: aus der Ablage → neues Dokument, aus einem Dokument → anhängen
  let importNewDoc = false;
  async function importInto(files, newDocument) {
    if (!files || !files.length) return 0;
    files = [...files];
    if (newDocument) { pages.forEach(dropUrls); pages = []; currentDoc = null; }
    // Zieldokument jetzt festlegen: Seiten landen dort, auch wenn inzwischen ein anderes geöffnet wird
    const doc = targetDoc();
    const firstPdf = files.find((f) => PdfImport.isPdf(f));
    // Dateiname übernehmen – außer bei Namen wie „Scan_0001.pdf“, dann automatisch benennen
    if (newDocument && firstPdf && !doc.named && !(settings.autoName && DocName.isGenericName(firstPdf.name))) {
      doc.name = firstPdf.name.replace(/\.pdf$/i, '').slice(0, 120) || doc.name;
      doc.named = true;
      doc.auto = false;
      DB.putDoc(doc);
    }
    // neues Dokument gleich öffnen, die Seiten erscheinen nach und nach
    if (newDocument) await openDoc(doc);
    const n = await addFiles(files, doc);
    if (!n && newDocument) removeEmptyDoc(doc);
    return n;
  }
  /** Leeres, eben angelegtes Dokument wieder entfernen (Import fehlgeschlagen/abgebrochen). */
  async function removeEmptyDoc(d) {
    if (!docAlive(d)) return;
    const recs = (await DB.pagesOf(d.id)) || [];
    if (recs.length || pages.some((p) => p.docId === d.id && !p.deleted)) return;
    docs = docs.filter((x) => x !== d);
    DB.delDocAll(d.id);
    if (currentDoc === d) {
      if (topScreen() === 'docview') closeScreen();
      else { pages = []; currentDoc = null; }
    }
    renderLibrary();
  }
  $('#fileCapture').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])]; // Kopie: das Zurücksetzen leert die Liste
    e.target.value = '';
    const intent = pendingCapture || { retake: cam.retake, newDoc: cam.newDoc };
    pendingCapture = null;
    cam.retake = null;
    if (intent.retake && files.length) {
      const p = intent.retake;
      if (p.deleted) return;
      try {
        const img = await Img.load(files[0]);
        const c = Img.draw(img, MAX_DIM);
        const original = await track(Img.toBlob(c, 'image/jpeg', 0.92));
        Img.release(c);
        replacePage(p, original, null);
      } catch (err) { console.error(err); toast('Foto konnte nicht gelesen werden.'); }
      return;
    }
    if (!files.length) return;
    const n = await importInto(files, intent.newDoc);
    cam.newDoc = false;
    if (n) toast('Seite hinzugefügt. Für die nächste Seite wieder auf die Kamera tippen.');
  });
  $('#btnImport').addEventListener('click', () => { importNewDoc = false; $('#fileImport').click(); });
  $('#libImport').addEventListener('click', () => { importNewDoc = true; $('#fileImport').click(); });
  $('#fileImport').addEventListener('change', async (e) => {
    const n = await importInto(e.target.files, importNewDoc);
    e.target.value = '';
    if (n) toast(n === 1 ? '1 Seite importiert.' : `${n} Seiten importiert.`);
  });

  // ---------- Editor ----------
  const editor = { page: null, crop: null };
  const adj = { on: false, loading: false, b: 0, c: 0, base: null, filtered: null, mode: null, raf: 0, token: 0 };

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

  /** Zur vorherigen/nächsten Seite blättern (Pfeile am Bildrand, Wischen, Pfeiltasten). */
  function goToPage(delta) {
    const p = editor.page;
    if (!p || editor.crop || adj.on) return;
    const j = pages.indexOf(p) + delta;
    if (j < 0 || j >= pages.length) return;
    editor.page = pages[j];
    updateEditor();
  }
  function updateNav(busy) {
    const i = pages.indexOf(editor.page);
    const off = busy || !!editor.crop || adj.on || i < 0;
    $('#edPrev').hidden = off || i <= 0;
    $('#edNext').hidden = off || i >= pages.length - 1;
  }
  $('#edPrev').addEventListener('click', () => goToPage(-1));
  $('#edNext').addEventListener('click', () => goToPage(1));
  {
    let sx = null, sy = 0;
    const stage = $('#edPreviewWrap');
    stage.addEventListener('pointerdown', (e) => { if (e.isPrimary) { sx = e.clientX; sy = e.clientY; } });
    stage.addEventListener('pointerup', (e) => {
      if (sx === null) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) goToPage(dx < 0 ? 1 : -1);
    });
    stage.addEventListener('pointercancel', () => { sx = null; });
    stage.addEventListener('dragstart', (e) => e.preventDefault()); // Bild nicht als Datei ziehen
  }
  document.addEventListener('keydown', (e) => {
    if (topScreen() !== 'editor' || document.querySelector('dialog[open]')) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') goToPage(-1);
    else if (e.key === 'ArrowRight') goToPage(1);
  });

  function updateEditor() {
    const p = editor.page;
    if (!p) return;
    const i = pages.indexOf(p);
    $('#edTitle').textContent = `Seite ${i + 1} von ${pages.length}`;
    updateNav();
    $('#edMovePrev').disabled = i <= 0;
    $('#edMoveNext').disabled = i >= pages.length - 1;
    markChips($('#filterChips'), p.filter);
    markAdjust(p);
    updatePreview();
  }

  function updatePreview() {
    const p = editor.page;
    if (!p) return;
    const url = urlFor(p, 'processed');
    const img = $('#edPreview');
    if (url && img.getAttribute('src') !== url) img.src = url;
    img.hidden = !url || adj.on;
    $('#edSpinner').hidden = !p.pending && !adj.loading;
    $('#edAdjust').disabled = !p.processed;
    const lvl = p.pending ? 0 : blurLevel(p);
    $('#edBlur').hidden = !lvl || !!editor.crop || adj.on;
    $('#edBlurText').textContent = lvl === 2 ? 'Foto ist unscharf – Text schwer lesbar.' : 'Foto wirkt unscharf.';
    $('#edPreviewWrap').classList.toggle('busy', !!p.pending);
  }

  function onEditorClosed() {
    if (editor.crop) endCrop();
    if (adj.on) endAdjust('cancel');
    editor.page = null;
  }

  // ---------- Helligkeit und Kontrast ----------
  function markAdjust(p) {
    const on = !!(p && ((p.bright || 0) || (p.contrast || 0)));
    const btn = $('#edAdjust');
    btn.classList.toggle('on', on);
    btn.title = on ? `Helligkeit ${fmtAdj(p.bright || 0)}, Kontrast ${fmtAdj(p.contrast || 0)}` : 'Helligkeit und Kontrast';
  }
  const fmtAdj = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');
  function setAdjValues(b, c) {
    adj.b = b; adj.c = c;
    $('#adjBright').value = String(b);
    $('#adjContrast').value = String(c);
    $('#adjBrightVal').textContent = fmtAdj(b);
    $('#adjContrastVal').textContent = fmtAdj(c);
    queueAdjRender();
  }
  async function startAdjust() {
    const p = editor.page;
    if (!p || !p.processed || editor.crop || adj.on) return;
    const token = ++adj.token;
    adj.on = true;
    adj.mode = p.filter;
    $('#edTools').hidden = true;
    $('#adjTools').hidden = false;
    updateNav(true);
    $('#edRetake').hidden = $('#edDelete').hidden = true;
    setAdjValues(p.bright || 0, p.contrast || 0);
    adj.loading = true;
    updatePreview();
    $('#edPreview').hidden = false; // bis die Vorschau bereitsteht, das bisherige Bild zeigen
    try {
      const c = await Proc.prepareView({ original: p.original, rotation: p.rotation, corners: p.corners, autoDetect: false, maxDim: 1200 });
      if (token !== adj.token || !adj.on) { Img.release(c); return; }
      adj.base = c;
      adj.filtered = null;
      if (adj.mode !== 'bw') {
        // Filter einmal anwenden; die Regler ändern dann nur noch die Tonwertkurve (schnell)
        const f = Img.canvas(c.width, c.height);
        f.getContext('2d').drawImage(c, 0, 0);
        Img.filter(f, adj.mode);
        adj.filtered = f.getContext('2d').getImageData(0, 0, f.width, f.height);
        Img.release(f);
      }
      const cv = $('#adjCanvas');
      cv.width = c.width; cv.height = c.height;
      renderAdjust();
      cv.hidden = false;
      $('#edPreview').hidden = true;
    } catch (e) {
      console.error(e);
      if (token === adj.token) { toast('Vorschau nicht möglich.'); endAdjust('cancel'); }
    } finally {
      if (token === adj.token) { adj.loading = false; $('#edSpinner').hidden = !(editor.page && editor.page.pending); }
    }
  }
  function queueAdjRender() {
    if (adj.raf || !adj.base) return;
    adj.raf = requestAnimationFrame(() => { adj.raf = 0; renderAdjust(); });
  }
  function renderAdjust() {
    if (!adj.base) return;
    const cv = $('#adjCanvas');
    const x = cv.getContext('2d');
    const a = { b: adj.b, c: adj.c };
    if (adj.filtered) {
      const out = x.createImageData(adj.filtered.width, adj.filtered.height);
      Img.adjustData(adj.filtered.data, out.data, a);
      x.putImageData(out, 0, 0);
    } else {
      const t = Img.canvas(adj.base.width, adj.base.height);
      t.getContext('2d').drawImage(adj.base, 0, 0);
      Img.finish(t, adj.mode, a);
      x.drawImage(t, 0, 0);
      Img.release(t);
    }
  }
  /** mode: 'cancel' | 'apply' | 'all' (auf alle Seiten des Dokuments) */
  function endAdjust(mode) {
    const p = editor.page;
    const b = adj.b, c = adj.c;
    adj.on = false; adj.loading = false; adj.token++;
    if (adj.raf) { cancelAnimationFrame(adj.raf); adj.raf = 0; }
    Img.release(adj.base);
    adj.base = null; adj.filtered = null;
    const cv = $('#adjCanvas');
    cv.hidden = true; cv.width = 0; cv.height = 0;
    $('#adjTools').hidden = true;
    $('#edTools').hidden = false;
    updateNav();
    $('#edRetake').hidden = $('#edDelete').hidden = false;
    if (p && mode === 'apply' && ((p.bright || 0) !== b || (p.contrast || 0) !== c)) {
      p.bright = b; p.contrast = c;
      schedule(p);
    } else if (p && mode === 'all') {
      const prev = new Map(pages.map((q) => [q, [q.bright || 0, q.contrast || 0]]));
      let n = 0;
      for (const q of pages) {
        if ((q.bright || 0) === b && (q.contrast || 0) === c) continue;
        q.bright = b; q.contrast = c;
        schedule(q);
        n++;
      }
      toast(n ? `Auf ${pages.length === 1 ? 'die Seite' : `alle ${pages.length} Seiten`} angewendet.` : 'Alle Seiten haben bereits diese Einstellung.', n ? {
        label: 'Rückgängig',
        onClick: () => {
          for (const [q, [pb, pc]] of prev) {
            if (q.deleted || ((q.bright || 0) === pb && (q.contrast || 0) === pc)) continue;
            q.bright = pb; q.contrast = pc;
            schedule(q);
          }
          if (editor.page) markAdjust(editor.page);
        },
      } : undefined);
    }
    if (p) { markAdjust(p); updatePreview(); }
  }
  $('#edAdjust').addEventListener('click', startAdjust);
  $('#adjBright').addEventListener('input', (e) => setAdjValues(+e.target.value, adj.c));
  $('#adjContrast').addEventListener('input', (e) => setAdjValues(adj.b, +e.target.value));
  // Doppeltippen auf einen Regler setzt ihn zurück
  $('#adjBright').addEventListener('dblclick', () => setAdjValues(0, adj.c));
  $('#adjContrast').addEventListener('dblclick', () => setAdjValues(adj.b, 0));
  $('#adjReset').addEventListener('click', () => setAdjValues(0, 0));
  $('#adjCancel').addEventListener('click', () => endAdjust('cancel'));
  $('#adjApply').addEventListener('click', () => endAdjust('apply'));
  $('#adjAll').addEventListener('click', () => endAdjust('all'));

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

  function rotatePage(steps) { rotatePageBy(editor.page, steps); }
  function rotatePageBy(p, steps) {
    // automatische Randerkennung bleibt: sie läuft nach dem Drehen auf dem gedrehten Bild
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

  $('#edRetake').addEventListener('click', () => { if (editor.page) openCamera(false, editor.page); });
  $('#edBlurRetake').addEventListener('click', () => { if (editor.page) openCamera(false, editor.page); });
  $('#edBack').addEventListener('click', closeScreen);
  $('#edMovePrev').addEventListener('click', () => movePage(-1));
  $('#edMoveNext').addEventListener('click', () => movePage(1));
  $('#edRotL').addEventListener('click', () => rotatePage(-1));
  $('#edRotR').addEventListener('click', () => rotatePage(1));
  $('#edDelete').addEventListener('click', () => {
    const p = editor.page;
    if (!p) return;
    closeScreen();
    deletePages([p]);
  });

  // ---------- Zuschnitt ----------
  const cropCanvas = $('#cropCanvas');
  const cropWrap = $('#cropWrap');
  const loupe = $('#loupe');

  function showCropUi(on) {
    if (on) $('#edBlur').hidden = true;
    $('#edPreviewWrap').hidden = on;
    cropWrap.hidden = !on;
    $('#edTools').hidden = on;
    $('#cropTools').hidden = !on;
    updateNav(on);
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
    updatePreview();
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
    const lx = Math.max(-wr.left + 4, Math.min(window.innerWidth - wr.left - size - 4, clientX - wr.left - size / 2));
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
  const pdfState = { blob: null, url: null, busy: false, ocr: true };

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
    setRadio('orient', settings.orient);
    setRadio('margin', String(settings.margin));
    setRadio('maxsize', String(settings.maxSize));
    $('#pdfOcr').checked = settings.ocr;
    pdfState.ocr = settings.ocr;
    $('#pdfLock').checked = false;
    $('#pdfPw').value = '';
    $('#pdfPw').type = 'password';
    $('#pdfPwField').hidden = true;
    // aufgeklappt, wenn vom Standard abweichend
    $('#pdfMore').open = settings.orient !== 'auto' || settings.margin !== 0 || settings.maxSize !== 0;
    updatePdfOptionUi();
    $('#pdfProgress').hidden = true;
    updatePdfBlurNote();
    if (!pdfDialog.open) pdfDialog.showModal();
    if (auto) generatePdf();
  }

  function readPdfOptions() {
    settings.format = getRadio('format') || 'a4';
    settings.quality = getRadio('quality') || 'medium';
    settings.orient = getRadio('orient') || 'auto';
    settings.margin = Number(getRadio('margin') || 0);
    settings.maxSize = Number(getRadio('maxsize') || 0);
    pdfState.ocr = $('#pdfOcr').checked; // nur für dieses PDF – die Einstellung „Texterkennung“ bleibt
    saveSettings();
  }
  function updatePdfOptionUi() {
    const fixed = (getRadio('format') || 'a4') !== 'image';
    $('#pdfOrientField').classList.toggle('disabled', !fixed);
    $('#pdfMarginField').classList.toggle('disabled', !fixed);
    const orientLabel = { auto: 'Ausrichtung automatisch', portrait: 'Hochformat', landscape: 'Querformat' }[getRadio('orient') || 'auto'];
    const m = Number(getRadio('margin') || 0), mx = Number(getRadio('maxsize') || 0);
    const parts = fixed ? [orientLabel, m ? `Rand ${m} mm` : 'ohne Rand'] : ['Seite wie Foto'];
    parts.push(mx ? `max. ${mx} MB` : 'ohne Größengrenze');
    $('#pdfMoreSummary').textContent = parts.join(' · ');
  }

  function updatePdfBlurNote() {
    const nums = pages.map((p, i) => (blurLevel(p) ? i + 1 : 0)).filter(Boolean);
    $('#pdfBlur').hidden = !nums.length;
    if (nums.length) $('#pdfBlurText').textContent = nums.length === 1 ? `Seite ${nums[0]} wirkt unscharf.` : `Seiten ${nums.join(', ')} wirken unscharf.`;
  }

  // Seitengrößen in pt (1 pt = 1/72 Zoll)
  const PAGE_SIZES = { a4: [595.28, 841.89], a5: [419.53, 595.28], letter: [612, 792] };
  const MM = 72 / 25.4;
  // Stufen für Auflösung (längste Seite in px) und JPEG-Qualität – von groß nach klein
  const LADDER = [[3000, 0.9], [2400, 0.84], [2000, 0.78], [1700, 0.72], [1400, 0.65], [1200, 0.58], [1000, 0.52], [850, 0.46], [700, 0.42]];
  const QUALITY_LEVEL = { high: 0, medium: 2, low: 4 };

  /** Position des Fotos auf der PDF-Seite (pt) nach Format, Ausrichtung und Rand. */
  function pageLayout(w, h, o) {
    let pageW, pageH, m = 0;
    if (o.format === 'image' || !PAGE_SIZES[o.format]) {
      const k = A4H / Math.max(w, h);
      pageW = w * k; pageH = h * k;
    } else {
      const [sw, sh] = PAGE_SIZES[o.format];
      const portrait = o.orient === 'portrait' || (o.orient !== 'landscape' && h >= w);
      pageW = portrait ? sw : sh;
      pageH = portrait ? sh : sw;
      m = (o.margin || 0) * MM;
    }
    const bw = pageW - 2 * m, bh = pageH - 2 * m;
    const s = Math.min(bw / w, bh / h);
    const iw = w * s, ih = h * s;
    return { pageW, pageH, x: (pageW - iw) / 2, y: (pageH - ih) / 2, iw, ih };
  }

  /**
   * PDF aus den Seiten des offenen Dokuments.
   * opts: { format: a4|a5|letter|image, orient: auto|portrait|landscape, margin (mm), quality: high|medium|low,
   *         maxBytes (0 = ohne Grenze), ocr }
   * Mit maxBytes werden die Bilder schrittweise verkleinert, bis das PDF passt (oder die kleinste Stufe erreicht ist).
   */
  async function buildPdf(opts, onProgress) {
    // ältere Aufrufform: buildPdf(format, quality, onProgress, withOcr)
    if (typeof opts === 'string') { const a = arguments; opts = { format: a[0], quality: a[1], ocr: !!a[3] }; onProgress = a[2]; }
    const o = { format: 'a4', orient: 'auto', margin: 0, quality: 'medium', maxBytes: 0, ocr: false, ...opts };
    onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    const n = pages.length;
    let ocrFailed = false;
    // 1) Texterkennung (falls gewünscht) – unabhängig von der Bildgröße
    for (let i = 0; i < n; i++) {
      const p = pages[i];
      if (!p.processed) throw new Error(`Seite ${i + 1} konnte nicht verarbeitet werden.`);
      if (o.ocr && !ocrFailed) {
        onProgress(i, n);
        try { await ensureOcr(p, (m) => onProgress(i, n, ocrStatus(m))); }
        catch (e) { console.warn(e); ocrFailed = true; }
      }
    }
    // 2) Bilder in einer Stufe kodieren und PDF zusammensetzen
    const encodeAt = async (level, label) => {
      const [dim, q] = LADDER[level];
      const imgs = [];
      for (let i = 0; i < n; i++) {
        const p = pages[i];
        onProgress(i, n, label ? { text: label, progress: i / n, recognizing: false } : null);
        await tick();
        if (level === 0 && Math.max(p.pw, p.ph) <= dim) imgs.push({ blob: p.processed, w: p.pw, h: p.ph });
        else imgs.push(await Proc.reencode(p.processed, dim, q));
      }
      const out = [];
      for (let i = 0; i < n; i++) {
        const p = pages[i], im = imgs[i];
        const L = pageLayout(im.w, im.h, o);
        const text = o.ocr && p.ocr && p.ocr.key === p.procKey ? textLayer(p, L.x, L.y, L.iw / p.pw) : null;
        out.push({ jpeg: new Uint8Array(await im.blob.arrayBuffer()), pageWidth: L.pageW, pageHeight: L.pageH, x: L.x, y: L.y, w: L.iw, h: L.ih, text });
      }
      return PDFWriter.build(out, { title: fileName().replace(/\.pdf$/, ''), producer: 'DokScan', password: o.password || null });
    };
    let level = QUALITY_LEVEL[o.quality] != null ? QUALITY_LEVEL[o.quality] : 2;
    let blob = await encodeAt(level);
    // 3) Auf Zielgröße bringen: geschätzte Stufe anspringen, bei Bedarf weiter verkleinern
    const target = o.maxBytes ? o.maxBytes * 0.97 : 0;
    const qf = (q) => 0.25 + q;
    while (target && blob.size > target && level < LADDER.length - 1) {
      const [d0, q0] = LADDER[level];
      let next = level + 1;
      while (next < LADDER.length - 1) {
        const [d, q] = LADDER[next];
        const predicted = blob.size * (d / d0) ** 2 * (qf(q) / qf(q0));
        if (predicted <= target * 0.92) break;
        next++;
      }
      level = next;
      blob = await encodeAt(level, `Datei wird auf unter ${fmtSize(o.maxBytes)} verkleinert …`);
    }
    onProgress(n, n);
    blob.ocrFailed = ocrFailed;
    blob.level = level;
    blob.fitsTarget = !o.maxBytes || blob.size <= o.maxBytes;
    return blob;
  }

  async function generatePdf() {
    if (pdfState.busy) return;
    pdfState.busy = true;
    resetPdfResult();
    readPdfOptions();
    $('#pdfGenerate').disabled = true;
    $('#pdfProgress').hidden = false;
    const bar = $('#pdfProgressBar');
    const text = $('#pdfProgressText');
    bar.style.width = '0%';
    try {
      const password = $('#pdfLock').checked ? $('#pdfPw').value : '';
      if ($('#pdfLock').checked && password.length < 4) throw new Error('Bitte ein Passwort mit mindestens 4 Zeichen eingeben.');
      if (!isIdle()) {
        const total = pages.length;
        const upd = () => {
          const left = pages.filter((p) => p.pending || !p.processed).length;
          text.textContent = left ? `Seiten werden noch bearbeitet … (${total - left} von ${total} fertig)` : 'Seiten werden noch bearbeitet …';
          bar.style.width = `${Math.round((total - left) / Math.max(1, total) * 30)}%`;
        };
        upd();
        const iv = setInterval(upd, 400);
        try { await whenIdle(); } finally { clearInterval(iv); }
      }
      if (!pages.length) throw new Error('Das Dokument hat keine Seiten.');
      const blob = await buildPdf({
        format: settings.format, orient: settings.orient, margin: settings.margin,
        quality: settings.quality, maxBytes: settings.maxSize * 1024 * 1024, ocr: pdfState.ocr, password,
      }, (i, n, ocr) => {
        const part = ocr && ocr.recognizing ? ocr.progress : 0;
        bar.style.width = `${Math.round(((i + part) / n) * 100)}%`;
        if (ocr && !ocr.recognizing) text.textContent = ocr.text;
        else if (ocr) text.textContent = `Texterkennung Seite ${i + 1} von ${n} …`;
        else text.textContent = i < n ? `Seite ${i + 1} von ${n} …` : 'PDF wird zusammengefügt …';
      });
      pdfState.blob = blob;
      updatePdfBlurNote();
      pdfState.url = URL.createObjectURL(blob);
      $('#pdfResName').textContent = fileName();
      $('#pdfResMeta').textContent = `${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} · ${fmtSize(blob.size)}` +
        (pdfState.ocr ? (blob.ocrFailed ? ' · ohne Texterkennung (nicht verfügbar)' : ' · durchsuchbar') : '') +
        (settings.maxSize ? (blob.fitsTarget ? ` · unter ${settings.maxSize} MB` : ` · ${settings.maxSize} MB nicht erreichbar`) : '') +
        (password ? ' · passwortgeschützt' : '');
      $('#pdfShare').hidden = !canShareFile(blob);
      $('#pdfResult').hidden = false;
      $('#pdfGenerate').hidden = true;
      // Ergebnis mit „Teilen/Speichern“ sichtbar machen
      $('#pdfMore').open = false;
      requestAnimationFrame(() => $('#pdfResult').scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
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
  // Eingabetaste in Dateiname/Passwort: PDF erstellen statt den Dialog zu schließen
  $('#pdfForm').addEventListener('submit', (e) => { e.preventDefault(); });
  for (const id of ['#pdfName', '#pdfPw']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      e.target.blur();
      if (!pdfState.busy) generatePdf();
    });
  }
  $('#pdfLock').addEventListener('change', () => {
    $('#pdfPwField').hidden = !$('#pdfLock').checked;
    if ($('#pdfLock').checked) setTimeout(() => $('#pdfPw').focus(), 50);
  });
  $('#pdfPw').addEventListener('input', () => { if (pdfState.blob) resetPdfResult(); });
  $('#pdfPwShow').addEventListener('click', () => {
    const show = $('#pdfPw').type === 'password';
    $('#pdfPw').type = show ? 'text' : 'password';
    $('#pdfPwShow').setAttribute('aria-pressed', String(show));
    $('#pdfPwShow').setAttribute('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
  });
  pdfDialog.addEventListener('change', (e) => {
    if (e.target.id === 'pdfLock' && pdfState.blob) resetPdfResult();
    if (e.target.type === 'radio') updatePdfOptionUi();
    if ((e.target.type === 'radio' || e.target.id === 'pdfOcr') && pdfState.blob) resetPdfResult();
  });
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
    $('#setBlurWarn').checked = settings.blurWarn;
    $('#setAutoName').checked = settings.autoName;
    syncSettingDeps();
    refreshStorageInfo();
    setDialog.showModal();
  });
  function syncSettingDeps() {
    const on = settings.autoCrop;
    $('#setAutoShoot').disabled = !on;
    $('#setAutoShoot').closest('label').classList.toggle('disabled', !on);
  }
  $('#setAutoCrop').addEventListener('change', (e) => { settings.autoCrop = e.target.checked; saveSettings(); syncSettingDeps(); });
  $('#setAutoPdf').addEventListener('change', (e) => { settings.autoPdf = e.target.checked; saveSettings(); });
  $('#setWideFov').addEventListener('change', (e) => { settings.wideFov = e.target.checked; saveSettings(); });
  $('#setAutoName').addEventListener('change', (e) => {
    settings.autoName = e.target.checked;
    saveSettings();
    if (settings.autoName) { docs.forEach((d) => { if (!d.named) delete d.autoKey; }); autoNameAll(); }
  });
  $('#setAutoShoot').addEventListener('change', (e) => { settings.autoShoot = e.target.checked; saveSettings(); });
  $('#setBlurWarn').addEventListener('change', (e) => { settings.blurWarn = e.target.checked; saveSettings(); renderGrid(); });
  $('#setOcr').addEventListener('change', (e) => {
    settings.ocr = e.target.checked;
    saveSettings();
    if (settings.ocr) pages.forEach((p) => { if (p.processed) ensureOcr(p).catch(() => {}); });
  });
  setDialog.addEventListener('click', (e) => { if (e.target === setDialog) setDialog.close(); });


  // ---------- Datensicherung ----------
  const isoDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  /** Datei teilen (iOS: „In Dateien sichern“) oder herunterladen. */
  async function shareOrDownload(file) {
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return true; }
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  }
  async function refreshStorageInfo() {
    const el = $('#storageInfo');
    const parts = ['Alle Dokumente werden nur auf diesem Gerät gespeichert.'];
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage, quota } = await navigator.storage.estimate();
        if (usage != null) parts.push(`Belegt: ${fmtSize(usage)}${quota ? ` von ${fmtSize(quota)}` : ''}.`);
      }
      if (navigator.storage && navigator.storage.persisted) {
        parts.push((await navigator.storage.persisted()) ? 'Der Speicher ist vor automatischem Löschen geschützt.' : 'Der Browser darf die Daten bei Platzmangel oder längerer Nichtnutzung löschen – bitte regelmäßig sichern.');
      }
    } catch { /* egal */ }
    let last = 0;
    try { last = Number(localStorage.getItem('dokscan.lastBackup') || 0); } catch { /* egal */ }
    parts.push(last ? `Letzte Sicherung: ${fmtDate(last)}.` : 'Noch keine Sicherung.');
    el.textContent = parts.join(' ');
  }
  $('#backupSave').addEventListener('click', async () => {
    const btn = $('#backupSave');
    if (!docs.length) { toast('Die Ablage ist leer.'); return; }
    btn.disabled = true;
    try {
      toast('Sicherung wird vorbereitet …', null, 60000);
      await whenIdle();
      const res = await Backup.create(docs.slice(), async (id) => {
        const recs = (await DB.pagesOf(id)) || [];
        return recs.map((r) => (inflight.has(r.id) ? record(inflight.get(r.id)) : r));
      }, (i, n) => { if (i % 10 === 0 || i === n) toast(`Sicherung wird erstellt … ${Math.round((i / n) * 100)} %`, null, 60000); });
      const file = new File([res.blob], `DokScan-Sicherung-${isoDay(Date.now())}.zip`, { type: 'application/zip' });
      const summary = `${res.docs === 1 ? '1 Dokument' : `${res.docs} Dokumente`}, ${res.pages === 1 ? '1 Seite' : `${res.pages} Seiten`} · ${fmtSize(file.size)}`;
      // Teilen braucht eine frische Nutzeraktion → eigener Knopf
      toast(`Sicherung fertig (${summary}).`, {
        label: 'Speichern',
        onClick: async () => {
          if (await shareOrDownload(file)) {
            try { localStorage.setItem('dokscan.lastBackup', String(Date.now())); } catch { /* egal */ }
            refreshStorageInfo();
          }
        },
      }, 60000);
    } catch (e) {
      console.error(e);
      toast(`Sicherung fehlgeschlagen: ${e.message || e}`, null, 7000);
    } finally { btn.disabled = false; }
  });
  $('#backupLoad').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      toast('Sicherung wird gelesen …', null, 60000);
      const data = await Backup.read(f);
      const known = new Set(docs.map((d) => d.id));
      const fresh = data.docs.filter((d) => !known.has(d.id));
      const ids = new Set(fresh.map((d) => d.id));
      const freshPages = data.pages.filter((p) => ids.has(p.docId));
      const skipped = data.docs.length - fresh.length;
      if (!fresh.length) { toast('Alle Dokumente dieser Sicherung sind bereits vorhanden.', null, 5000); return; }
      const msg = `${fresh.length === 1 ? '1 Dokument' : `${fresh.length} Dokumente`} mit ${freshPages.length === 1 ? '1 Seite' : `${freshPages.length} Seiten`} wiederherstellen?`
        + (skipped ? `\n${skipped} ${skipped === 1 ? 'ist' : 'sind'} bereits vorhanden und ${skipped === 1 ? 'wird' : 'werden'} übersprungen.` : '');
      if (!confirm(msg)) { toast('Wiederherstellen abgebrochen.'); return; }
      for (let i = 0; i < freshPages.length; i += 20) await DB.putMany(freshPages.slice(i, i + 20));
      for (const d of fresh) { docs.push(d); await DB.putDoc(d); }
      renderLibrary();
      setDialog.close();
      toast(`${fresh.length === 1 ? '1 Dokument' : `${fresh.length} Dokumente`} wiederhergestellt.`, null, 4000);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Die Sicherung konnte nicht gelesen werden.', null, 7000);
    }
  });

  // Hinweis für Safari ohne Home-Bildschirm: Daten können sonst gelöscht werden
  function updateHomeHint() {
    let closed = false;
    try { closed = localStorage.getItem('dokscan.homeHint') === 'closed'; } catch { /* egal */ }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    $('#homeHint').hidden = closed || !ios || standalone || docs.length === 0;
  }
  $('#homeHintClose').addEventListener('click', () => {
    try { localStorage.setItem('dokscan.homeHint', 'closed'); } catch { /* egal */ }
    updateHomeHint();
  });

  // ---------- Toast ----------
  let toastTimer = null;
  let toastHandler = null;
  /** Kurzer Hinweis; optional mit Aktion, z. B. { label: 'Rückgängig', onClick } */
  function toast(msg, action, ms) {
    const t = $('#toast');
    const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
    if (t.parentNode !== host) host.appendChild(t);
    $('#toastText').textContent = msg;
    const btn = $('#toastAction');
    toastHandler = action ? action.onClick : null;
    btn.hidden = !action;
    if (action) btn.textContent = action.label;
    // nichts verdecken: über der Werkzeugleiste der aktuellen Ansicht, in Dialogen am oberen Rand
    t.classList.toggle('top', host !== document.body);
    t.style.bottom = host !== document.body ? '' : toastBottom();
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); toastHandler = null; }, ms || (action ? 6000 : 2800));
  }
  function toastBottom() {
    const top = topScreen();
    if (top === 'camera') return 'calc(env(safe-area-inset-bottom) + 190px)';
    const root = top ? $('#' + top) : $('#app');
    const bars = [...root.querySelectorAll('.bottombar, .ed-tools, .sel-tools, .blur-note')].filter((el) => el.getClientRects().length);
    if (!bars.length) return '';
    const y = Math.min(...bars.map((el) => el.getBoundingClientRect().top));
    return `${Math.max(16, Math.round(window.innerHeight - y + 12))}px`;
  }
  // Dialog geschlossen → Hinweis zurück in die Seite
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => {
    const t = $('#toast');
    if (t.parentNode === d) document.body.appendChild(t);
  }));
  $('#toastAction').addEventListener('click', () => {
    const f = toastHandler;
    toastHandler = null;
    $('#toast').classList.remove('show');
    if (f) f();
  });

  // Bilder per Drag & Drop (Desktop)
  const dropTarget = () => (!stack.length ? 'library' : topScreen() === 'docview' ? 'doc' : null);
  document.addEventListener('dragover', (e) => { if (dropTarget()) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    const target = dropTarget();
    if (!target || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const n = await importInto(e.dataTransfer.files, target === 'library');
    if (n) toast(n === 1 ? '1 Seite importiert.' : `${n} Seiten importiert.`);
  });

  // ---------- Start ----------
  async function init() {
    Proc.init();
    renderLibrary();
    // Zurück-Taste: nach einem Neuladen gibt es keine offenen Ansichten mehr
    try { history.replaceState({ dokscan: 0 }, ''); } catch { /* egal */ }
    const stored = (await DB.docs()) || [];
    // Dokumente, die während des Ladens angelegt wurden, behalten
    docs = stored.concat(docs.filter((d) => !stored.some((x) => x.id === d.id)));
    // Altlast: Seiten-Metadaten des übernommenen Dokuments einmal nachziehen
    const legacy = docs.find((d) => d.id === LEGACY_DOC);
    if (legacy && !legacy.thumb) refreshDocMeta(LEGACY_DOC);
    autoNameAll(); // ältere, noch nicht benannte Dokumente
    for (const d of docs) if (d.metaKey === undefined && d.text && updateLetterMeta(d, null)) DB.putDoc(d);
    renderLibrary();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      // Neue Version aktiv → neu laden, sobald nichts offen ist (Seiten sind gespeichert)
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        const tryReload = () => {
          // erst neu laden, wenn nichts offen ist und nichts mehr läuft (Import, Verarbeitung, Texterkennung, Speichern)
          const ocrBusy = [...inflight.values()].some((p) => p.ocrJob);
          if (stack.length || document.querySelector('dialog[open]') || !isIdle() || importing || ocrBusy || docTimers.size) { setTimeout(tryReload, 2000); return; }
          reloading = true;
          location.reload();
        };
        tryReload();
      });
      navigator.serviceWorker.register('sw.js').catch(() => {});
      // Texterkennung und PDF-Import im Hintergrund für die Offline-Nutzung vorladen (einmalig ~7 MB)
      const warm = () => {
        if (!settings.ocr || !navigator.onLine) return;
        navigator.serviceWorker.ready.then((reg) => { if (reg.active) reg.active.postMessage({ type: 'warm-vendor' }); }).catch(() => {});
      };
      setTimeout(warm, 8000);
      window.addEventListener('online', () => setTimeout(warm, 3000));
    }
  }
  init();

  // Für Tests
  window.DokScan = { backupFile: async () => (await Backup.create(docs.slice(), (id) => DB.pagesOf(id))).blob, get pages() { return pages; }, get docs() { return docs; }, get currentDoc() { return currentDoc; }, get liveCount() { return live.count || 0; }, whenIdle, addFiles, buildPdf, settings, workerReady: () => Proc.init(), ensureOcr, openDoc, importInto };
})();
