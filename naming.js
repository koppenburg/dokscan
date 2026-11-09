'use strict';
/**
 * Namensvorschlag aus dem Text eines Dokuments: „JJJJ-MM-TT Absender Dokumentart“,
 * z. B. „2026-11-05 Finanzamt Musterstadt Einkommensteuerbescheid“.
 * Reine Textauswertung ohne DOM (auch in Node testbar). Kommt mit OCR-Fehlern zurecht,
 * so gut es mit einfachen Regeln geht – im Zweifel wird lieber nichts vorgeschlagen.
 */
const DocName = (() => {
  const MONTHS = {
    januar: 1, jan: 1, jänner: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, mrz: 3, april: 4, apr: 4,
    mai: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
    oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
  };
  const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const DAY = 86400000;

  const clean = (s) => s.replace(/_+/g, ' ').replace(/\s+/g, ' ').replace(/\bGMBH\b/g, 'GmbH').replace(/\bMBH\b/g, 'mbH').trim();
  const lower = (s) => s.toLocaleLowerCase('de-DE');

  // ---------- Datum ----------
  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const t = new Date(y, m - 1, d);
    return t.getMonth() === m - 1 ? t : null;
  }
  function year(y, now) {
    if (y >= 100) return y;
    const yy = now.getFullYear() % 100;
    return y <= yy + 1 ? 2000 + y : 1900 + y;
  }

  function findDates(lines, now) {
    const out = [];
    const total = lines.length || 1;
    lines.forEach((line, i) => {
      const l = lower(line);
      const found = [];
      const num = /(?<![\d.])(\d{1,2}) ?\. ?(\d{1,2}) ?\. ?(\d{4}|\d{2})(?![\d])/g;
      for (let m; (m = num.exec(line));) found.push([m.index, validDate(year(+m[3], now), +m[2], +m[1])]);
      const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
      for (let m; (m = iso.exec(line));) found.push([m.index, validDate(+m[1], +m[2], +m[3])]);
      const txt = new RegExp(`(?<!\\d)(\\d{1,2})\\.? ?(${MONTH_RE})\\.? ?(\\d{4})(?!\\d)`, 'gi');
      for (let m; (m = txt.exec(line));) found.push([m.index, validDate(+m[3], MONTHS[lower(m[2])], +m[1])]);
      for (const [pos, date] of found) {
        if (!date) continue;
        let s = 1 + (1 - i / total);
        const before = l.slice(Math.max(0, pos - 40), pos);
        if (/(geburtsdatum|geb\.|geboren)\s*:?\s*(am\s*)?$/.test(before)) s -= 6;
        if (/datum/.test(before)) s += 2.5;
        else if (/\bvom\b/.test(before)) s += 1;
        if ((line.match(/\S+/g) || []).length > 9) s -= 1; // Datum mitten im Fließtext
        if (/(liefer|leistungs)datum|\bzeitraum\b|\bbis\b|fällig|zahlbar|spätestens|frist|gültig|ablauf|\bab\b/.test(before)) s -= 2;
        if (/[a-zäöüß], ?(den )?$/.test(before)) s += 3; // „Musterstadt, den 05.11.2026“
        const t = date.getTime();
        if (t > now.getTime() + 2 * DAY) s -= 2.5;
        if (t < now.getTime() - 40 * 365 * DAY) s -= 4;
        out.push({ date, score: s, line: i });
      }
    });
    out.sort((a, b) => b.score - a.score || a.line - b.line);
    return out;
  }
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // ---------- Dokumentart ----------
  // Wortenden (auch in Zusammensetzungen: „Stromrechnung“, „Steuerbescheid“); Gewicht < 1 = allgemeiner
  const KINDS = [
    ['rechnung', 1], ['gutschrift', 1], ['mahnung', 1.2], ['zahlungserinnerung', 1.2], ['aufforderung', 0.8],
    ['bescheid', 1.1], ['kündigung', 1.1], ['bestätigung', 0.8], ['vertrag', 0.8], ['angebot', 0.8],
    ['kostenvoranschlag', 1], ['lieferschein', 1], ['quittung', 1], ['kassenbon', 1], ['kontoauszug', 1],
    ['abrechnung', 1], ['bescheinigung', 0.9], ['versicherungsschein', 1], ['police', 0.9], ['befund', 1],
    ['arztbrief', 1], ['rezept', 0.8], ['attest', 1], ['zeugnis', 0.9], ['einladung', 0.8], ['antrag', 0.8],
    ['mitteilung', 0.7], ['vollmacht', 1], ['protokoll', 0.8], ['urkunde', 1], ['zertifikat', 0.9],
    ['steuererklärung', 1], ['mandat', 0.8], ['bestellung', 0.7], ['anmeldung', 0.7],
  ];
  // Wörter, die zwar so enden, aber keine Dokumentart sind
  const NOT_KINDS = new Set([
    'berechnung', 'verrechnung', 'anrechnung', 'hochrechnung', 'zurechnung', 'gegenrechnung', 'umrechnung',
    'erzeugnis', 'naturkunde',
  ]);
  const TITLE_HINT = /^(betreff|betr\.|thema|re:|aw:)\s*:?/i;

  function findKind(lines) {
    const score = new Map();
    const total = lines.length || 1;
    lines.forEach((line, i) => {
      const l = lower(line);
      const words = line.match(/[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß-]*/g) || [];
      words.forEach((w, wi) => {
        const lw = lower(w).replace(/-/g, '');
        if (lw.length > 34) return;
        const kind = KINDS.find(([k]) => lw.endsWith(k));
        if (!kind) return;
        if (NOT_KINDS.has(lw)) return;
        // Redewendungen statt Dokumentart
        if (lw === 'bescheid' && /(uns|mir|ihnen|kurz|gerne|gern|rechtzeitig)\s+bescheid|bescheid\s+(geben|sagen|wissen)/.test(l)) return;
        if (lw === 'rechnung' && /\b(in|auf|zur|laut|lt\.?|gemäß|dieser|ihrer|unserer|der)\s+rechnung\b/.test(l)) return;
        if (lw === 'antrag' && /\bauf\s+antrag\b/.test(l)) return;
        let s = kind[1] * (1 + (1 - i / total));
        const trimmed = clean(line);
        const titleLike = wi === 0 || TITLE_HINT.test(trimmed);
        if (titleLike) s += 1.5;
        if (words.length <= 4) s += 1; // Überschrift: kurze Zeile
        if (TITLE_HINT.test(trimmed)) s += 1;
        if (lw.length > kind[0].length + 2) s += 0.6; // Zusammensetzung ist genauer („Einkommensteuerbescheid“)
        let label = w.replace(/-$/, '');
        if (label === label.toUpperCase()) label = label[0] + lower(label.slice(1));
        else label = label[0].toUpperCase() + label.slice(1);
        const key = lower(label);
        const prev = score.get(key);
        score.set(key, { label, score: prev ? Math.max(prev.score, s) + 0.3 : s });
      });
    });
    const best = [...score.values()].sort((a, b) => b.score - a.score)[0];
    return best && best.score >= 2 ? best.label : null;
  }

  // ---------- Absender ----------
  const LEGAL = String.raw`(?:GmbH\s*&\s*Co\.?\s*KG(?:aA)?|gGmbH|GmbH|mbH|AG\s*&\s*Co\.?\s*KG|KGaA|AG|KG|OHG|GbR|UG(?:\s*\(haftungsbeschränkt\))?|e\.\s?V\.|eG|SE|AöR|PartG(?:\s*mbB)?|Ltd\.?|Inc\.?)`;
  const LEGAL_RE = new RegExp(String.raw`^(.{2,60}?\S)\s+${LEGAL}(?=$|[\s,·•|–-])`);
  const LEGAL_CUT = new RegExp(String.raw`^(.*?\S)[\s,]+${LEGAL}(?![A-Za-zÄÖÜäöüß]).*$`);
  const LEGAL_END = new RegExp(String.raw`[\s,]+${LEGAL}\s*$`);
  const INSTITUTION = new RegExp('(?:^|[\\s(])(' + [
    'Finanzamt', 'Landeshauptstadt', 'Stadtverwaltung', 'Stadt', 'Gemeinde', 'Landratsamt', 'Landkreis', 'Kreisverwaltung',
    'Bezirksamt', 'Amtsgericht', 'Landgericht', 'Sozialgericht', 'Jobcenter', 'Agentur für Arbeit', 'Bundesagentur für Arbeit',
    'Deutsche Rentenversicherung', 'Familienkasse', 'Bundeszentralamt', 'Bürgeramt', 'Ordnungsamt', 'Standesamt',
    'Zulassungsstelle', 'Polizei', 'Hauptzollamt', 'Kfz-Zulassung', 'Rundfunkbeitrag', 'Beitragsservice',
    'AOK', 'BARMER', 'Barmer', 'Techniker Krankenkasse', 'DAK', 'IKK', 'BKK', 'KKH', 'HEK', 'Knappschaft', 'Krankenkasse',
    'Sparkasse', 'Volksbank', 'Raiffeisenbank', 'Commerzbank', 'Deutsche Bank', 'Postbank', 'Hypovereinsbank', 'Targobank',
    'Stadtwerke', 'Hausverwaltung', 'Universität', 'Hochschule', 'Gymnasium', 'Grundschule', 'Realschule', 'Gesamtschule',
    'Kindergarten', 'Kita', 'Klinikum', 'Krankenhaus', 'Universitätsklinikum', 'Praxis', 'Gemeinschaftspraxis', 'Zahnarztpraxis',
    'Rechtsanwälte', 'Rechtsanwalt', 'Rechtsanwältin', 'Kanzlei', 'Steuerberater', 'Steuerberaterin', 'Notar', 'Notarin',
    'Versicherung', 'Allianz', 'HUK-COBURG', 'Ergo', 'ERGO', 'Debeka', 'Generali', 'Signal Iduna', 'R\\+V',
  ].join('|') + ')(?=[\\s,.-]|$)');
  const RECIPIENT = /^(frau|herrn?|familie|eheleute|an\b|z\.\s?hd|zu\s?h(än|a)nden)/i;
  const NOISE = /(telefon|\btel\.|\bfax\b|e-?mail|\biban\b|\bbic\b|\bust\b|ust-?id|steuer-?nr|steuernummer|kunden-?nr|kundennummer|aktenzeichen|seite \d|datum|bankverbindung|\bhrb\b|geschäftsführ|vorstand|sitz der)/i;
  const MAIL_HOSTS = /^(gmail|googlemail|web|gmx|t-online|outlook|hotmail|icloud|me|yahoo|freenet|posteo|mail|aol|live)$/i;
  const STREET = /(straße|strasse|str\.|weg|platz|allee|gasse|ring|damm|ufer)\s*\d/i;

  function cutSegment(s) {
    // bis zum ersten Trenner („Firma GmbH · Straße 1 · 12345 Ort“)
    return s.split(/\s+[·•|–—]\s+|\s+-\s+|\s{3,}|,\s+(?=[^,]*\d{5})/)[0];
  }
  function tidy(s) {
    s = cutSegment(clean(s)).replace(/^[^\wÄÖÜäöüß(]+|[^\wÄÖÜäöüß).]+$/g, '');
    s = s.replace(LEGAL_CUT, '$1'); // alles ab der Rechtsform weg („… GmbH. Hauptstraße 12“)
    s = s.replace(/(\S\s+)[A-ZÄÖÜ][a-zäöüß]+-AG$/, '$1').replace(LEGAL_END, '').replace(/[\s,&+-]+$/, '').trim();
    // GROSSBUCHSTABEN → normale Schreibweise (Abkürzungen bis 4 Buchstaben bleiben)
    if (/[A-ZÄÖÜ]{5}/.test(s) && s === s.toUpperCase()) s = s.replace(/[A-ZÄÖÜ]{5,}/g, (w) => w[0] + lower(w.slice(1)));
    if (s.length > 42) s = s.slice(0, 42).replace(/\s+\S*$/, '');
    return s;
  }
  const words = (s) => (s.match(/[A-Za-zÄÖÜäöüß]{2,}/g) || []);
  /** Ähnlich geschrieben (OCR-Fehler wie „Musterstact“ statt „Musterstadt“)? */
  function similar(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 2 || Math.min(a.length, b.length) < 6) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length] <= Math.max(1, Math.floor(a.length / 10));
  }

  function findSender(lines) {
    const cand = new Map();
    const N = Math.min(lines.length, 40);
    let li = 0; // aktuelle Zeile: Stimmen zählen je Zeile, nicht je Erkennungsregel
    const add = (name, s) => {
      name = tidy(name);
      const letters = (name.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
      if (name.length < 3 || letters / name.length < 0.6 || !/[A-Za-zÄÖÜäöüß]{3}/.test(name) || STREET.test(name) || /\d{5}/.test(name) || RECIPIENT.test(name) || NOISE.test(name)) return;
      const key = lower(name);
      // gleiche oder ähnlich geschriebene Kandidaten zusammenfassen; die häufigste Schreibweise gewinnt
      let prev = cand.get(key);
      if (!prev) for (const c of cand.values()) if (similar(lower(c.name), key)) { prev = c; break; }
      if (!prev) { cand.set(key, { name, score: s, lines: new Set([li]), votes: { [name]: new Set([li]) } }); return; }
      prev.score = prev.lines.has(li) ? Math.max(prev.score, s) : Math.max(prev.score, s) + 1;
      prev.lines.add(li);
      (prev.votes[name] = prev.votes[name] || new Set()).add(li);
      prev.name = Object.keys(prev.votes).sort((x, y) => prev.votes[y].size - prev.votes[x].size)[0];
    };
    for (let i = 0; i < N; i++) {
      const line = clean(lines[i]);
      li = i;
      if (!line || RECIPIENT.test(line)) continue;
      const pos = 1 - i / N;
      // Absenderzeile über dem Adressfeld
      const segs = line.split(/\s+[·•|–—]\s+|\s+-\s+|\s*\|\s*/);
      if (segs.length >= 2 && /\b\d{5}\b/.test(line) && line.length < 130) add(segs[0], 4 + pos);
      if (NOISE.test(line) && !LEGAL_RE.test(line)) {
        // Fußzeile/Kontaktzeile: nur Webadresse auswerten
      } else {
        const lm = line.match(LEGAL_RE);
        if (lm) add(lm[1], 3 + pos);
        const im = line.match(INSTITUTION);
        if (im) add(line.slice(im.index + (im[0].length - im[1].length)), 3.2 + pos);
      }
      const closing = line.match(/^(?:ihre?|ihr team (?:der|von|vom)|ihr|mit freundlichen grüßen,?)\s+(.{3,50})$/i);
      if (closing && i > 0) add(closing[1], 1.2);
      const web = line.match(/(?:www\.|@)([a-z0-9äöü-]{3,40})\.(?:de|com|eu|at|ch|net|org|info)\b/i);
      if (web && !MAIL_HOSTS.test(web[1])) {
        const nm = web[1].split('-').map((x) => (x.length <= 3 ? x.toUpperCase() : x[0].toUpperCase() + x.slice(1))).join(' ');
        add(nm, 1.5 + pos);
      }
    }
    const best = [...cand.values()].sort((a, b) => b.score - a.score)[0];
    return best ? best.name : null;
  }

  /**
   * @param {string} text erkannter Text aller Seiten
   * @param {{firstPage?:string, created?:number, now?:number}} [opts] firstPage: Text der ersten Seite (wird bevorzugt)
   * @returns {{name:string, date:string, dateFound:boolean, sender:string|null, kind:string|null}|null}
   */
  function suggest(text, opts = {}) {
    if (!text || text.length < 20) return null;
    const now = new Date(opts.now || Date.now());
    const toLines = (t) => t.slice(0, 8000).split(/\n/).map((l) => l.trim()).filter(Boolean);
    const all = toLines(text);
    const first = opts.firstPage && opts.firstPage.trim().length >= 20 ? toLines(opts.firstPage) : all;
    if (!all.length) return null;
    const dates = findDates(first, now);
    const kind = findKind(first.slice(0, 60)) || (first !== all ? findKind(all.slice(0, 120)) : null);
    let sender = findSender(first);
    if (sender && kind && lower(sender).includes(lower(kind))) sender = null;
    if (!sender && !kind) return null;
    const best = dates.find((d) => d.score > 0);
    const date = best ? best.date : new Date(opts.created || now);
    const name = [iso(date), sender, kind].filter(Boolean).join(' ');
    return { name, date: iso(date), dateFound: !!best, sender, kind };
  }

  // ---------- Fristen und Termine ----------
  const NUM_WORDS = { ein: 1, einen: 1, einem: 1, einer: 1, eines: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, zehn: 10, zwölf: 12, vierzehn: 14, einundzwanzig: 21, dreißig: 30 };
  const LABELS = [
    [/einspruch/, 'Einspruch'],
    [/widerspruch/, 'Widerspruch'],
    [/\bklage/, 'Klage'],
    [/\bendet\b|vertragsende|läuft .*aus|ende der (mitgliedschaft|laufzeit|vertrags)/, 'Vertragsende'],
    [/kündig/, 'Kündigung'],
    [/abgebucht|abbuch|lastschrift|eingezogen/, 'Abbuchung'],
    [/zahlbar|zahlen|zahlung|überweis|begleich|ausgleich|fällig|betrag|zahlungsziel|entricht/, 'Zahlung'],
    [/zurück(zu)?send|rücksend|einreich|nachreich|vorleg|vorzuleg|mitteil|mitzuteil|antwort|rückmeld|zurückmeld|melden|einsend|unterschrieben|einzureichen|abgeben|abzugeben/, 'Rückmeldung'],
    [/gültig|befristet|läuft .*ab|ablauf/, 'Gültig bis'],
    [/frist|spätestens|bis zum|bis einschließlich|nicht später als/, 'Frist'],
  ];
  const isoT = (d) => iso(d);
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => {
    const t = new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
    return t.getDate() !== d.getDate() ? new Date(t.getFullYear(), t.getMonth(), 0) : t; // 31.01. + 1 Monat → 28./29.02.
  };
  /** Satzanfang vor einer Position (damit Wörter aus dem vorigen Satz nicht zählen). */
  function clauseBefore(t, pos, max) {
    let w = t.slice(Math.max(0, pos - max), pos);
    const cut = Math.max(w.search(/[!?;]\s[^!?;]*$/), (() => { let k = -1; const re = /[a-zäöüß)]\.\s+(?=[A-ZÄÖÜ])/g; let m; while ((m = re.exec(w))) k = m.index + 1; return k; })());
    if (cut > 0) w = w.slice(cut + 1);
    return w;
  }

  /**
   * Fristen und Termine im Text: explizite Daten mit Fristwort davor („zahlbar bis 20.11.2026“, „spätestens am …“,
   * „Termin am … um 10:30 Uhr“) und relative Fristen („innerhalb eines Monats nach Bekanntgabe Einspruch“) ab dem
   * Briefdatum. Zeiträume („01.10.2025 bis 30.09.2026“), Geburts- und Bezugsdaten („Ihr Schreiben vom …“) zählen nicht.
   * @returns {Array<{id:string, date:string, time:string|null, label:string, snippet:string, approx:boolean}>}
   */
  function deadlines(text, opts = {}) {
    if (!text) return [];
    const now = new Date(opts.now || Date.now());
    const base = opts.letterDate ? new Date(opts.letterDate + 'T00:00:00') : null;
    const from = base || addDays(now, -60);
    const until = addDays(base || now, 3 * 366);
    const t = text.slice(0, 20000).replace(/\s+/g, ' ');
    const lt = lower(t);
    const out = new Map();
    const push = (date, time, label, pos, len, approx) => {
      if (!date || date < from || date > until) return;
      const d = isoT(date);
      const id = `${label}|${d}${time ? ' ' + time : ''}`;
      if (out.has(id)) return;
      const snippet = t.slice(Math.max(0, pos - 70), pos + len + 40).trim();
      out.set(id, { id, date: d, time: time || null, label, snippet, approx: !!approx });
    };
    // Datumsangaben im ganzen Text
    const dates = [];
    const num = /(?<![\d.])(\d{1,2}) ?\. ?(\d{1,2}) ?\. ?(\d{4}|\d{2})(?![\d])/g;
    for (let m; (m = num.exec(t));) dates.push({ pos: m.index, len: m[0].length, date: validDate(year(+m[3], now), +m[2], +m[1]) });
    const txt = new RegExp(`(?<!\\d)(\\d{1,2})\\.? ?(${MONTH_RE})\\.? ?(\\d{4})(?!\\d)`, 'gi');
    for (let m; (m = txt.exec(t));) dates.push({ pos: m.index, len: m[0].length, date: validDate(+m[3], MONTHS[lower(m[2])], +m[1]) });
    dates.sort((a, b) => a.pos - b.pos);
    dates.forEach((x, k) => {
      if (!x.date) return;
      const before = lower(clauseBefore(t, x.pos, 90));
      const near = before.slice(-45);
      const after = lt.slice(x.pos + x.len, x.pos + x.len + 40);
      // keine Frist: Geburtsdatum, Bezug auf frühere Schreiben, Zeitraum „von … bis …“
      if (/geb\.|geboren|geburt/.test(near)) return;
      const prev = dates[k - 1], next = dates[k + 1];
      if (prev && x.pos - (prev.pos + prev.len) < 8 && /^\s*(bis|-|–|—)\s*$/.test(lt.slice(prev.pos + prev.len, x.pos))) return;
      if (next && next.pos - (x.pos + x.len) < 8 && /^\s*(bis|-|–|—)\s*$/.test(lt.slice(x.pos + x.len, next.pos))) return;
      if (/\b(vom|datum|schreiben|stand|zeitraum|leistungszeitraum|abrechnungszeitraum|seit)\s*:?\s*(dem\s*)?$/.test(near)) return;
      // Termin mit Uhrzeit
      const tm = after.match(/^\s*,?\s*(?:(?:um|ab|von)\s*(\d{1,2})(?:[:.](\d{2}))?|(\d{1,2})[:.](\d{2}))\s*(?:uhr|h\b)/);
      const hh = tm ? +(tm[1] || tm[3]) : 99;
      if (tm && hh < 24) {
        const time = `${String(hh).padStart(2, '0')}:${tm[2] || tm[4] || '00'}`;
        const lbl = /einspruch|widerspruch|zahl|frist/.test(near) && LABELS.find(([re]) => re.test(near));
        push(x.date, time, lbl ? lbl[1] : 'Termin', x.pos, x.len + tm[0].length, false);
        return;
      }
      const weekday = /(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag),?\s*(den\s*)?$/.test(near);
      if (!weekday && /[a-zäöüß], ?(den )?$/.test(near)) return; // „Musterstadt, den …“ = Briefdatum
      if (/termin|findet|statt|erscheinen|untersuchung|sprechstunde|besichtigung|verhandlung|einladung/.test(near) && /\bam\s*$|\bam\s+[a-zäöüß]+,?\s*(den\s*)?$/.test(near)) {
        push(x.date, null, 'Termin', x.pos, x.len, false);
        return;
      }
      // Fristwort kurz vor dem Datum („bis“, „spätestens“, „fällig am“ …)
      if (!/(bis|spätestens|frist|fällig|fälligkeit|zahlungsziel|gültig|abgebucht|eingezogen|zum|am|bis zum)\s*(zum|am|den)?\s*:?\s*$/.test(near)) return;
      if (/\b(am|zum)\s*$/.test(near) && /(erhalten|eingegangen|geschrieben|versandt|zugestellt)/.test(after.slice(0, 30))) return; // „am 01.11. erhalten“
      const hit = LABELS.find(([re]) => re.test(before + ' ' + after));
      if (!hit) return;
      push(x.date, null, hit[1], x.pos, x.len, false);
    });
    // relative Fristen ab dem Briefdatum
    if (base) {
      const rel = /(?:innerhalb|binnen)\s+(?:von\s+)?(\d{1,3}|[a-zäöüß]+)\s+(tag|tagen|woche|wochen|monat|monats|monaten)\b([^.;]{0,140})/g;
      for (let m; (m = rel.exec(lt));) {
        const n = /^\d+$/.test(m[1]) ? +m[1] : NUM_WORDS[m[1]];
        if (!n || n > 400) continue;
        const sentence = lower(clauseBefore(t, m.index, 160)) + ' ' + m[0];
        const hit = LABELS.find(([re]) => re.test(sentence));
        if (!hit || hit[1] === 'Gültig bis' || hit[1] === 'Abbuchung') continue;
        const unit = m[2];
        let d = /^tag/.test(unit) ? addDays(base, n) : /^woche/.test(unit) ? addDays(base, 7 * n) : addMonths(base, n);
        // Bescheide gelten am 4. Tag nach Aufgabe zur Post als bekannt gegeben (§ 122 AO, seit 2025)
        if (/bekanntgabe|zugang|zustellung|erhalt/.test(m[0])) d = /^monat/.test(unit) ? addMonths(addDays(base, 4), n) : addDays(d, 4);
        push(d, null, hit[1], m.index, m[0].length, true);
      }
    }
    return [...out.values()].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  }

  /** Briefdaten für Sortierung/Anzeige: Datum des Schreibens (nur wenn im Text gefunden), Absender, Art. */
  function letterInfo(text, opts = {}) {
    if (!text || text.length < 20) return null;
    const now = new Date(opts.now || Date.now());
    const toLines = (x) => x.slice(0, 8000).split(/\n/).map((l) => l.trim()).filter(Boolean);
    const first = opts.firstPage && opts.firstPage.trim().length >= 20 ? toLines(opts.firstPage) : toLines(text);
    const best = findDates(first, now).find((d) => d.score > 0);
    const kind = findKind(first.slice(0, 60));
    let sender = findSender(first);
    if (sender && kind && lower(sender).includes(lower(kind))) sender = null;
    return { date: best ? iso(best.date) : null, sender: sender || null, kind: kind || null };
  }

  // ---------- Überweisung ----------
  // Länge der Kontonummer (BBAN) nach dem Ländercode und den 2 Prüfziffern; bei * nur Ziffern
  const IBAN_LEN = { DE: [18, true], AT: [16, true], CH: [17, false], LI: [17, false], LU: [16, false], NL: [14, false], BE: [12, true], FR: [23, false], IT: [23, false], ES: [20, true], PL: [24, true], DK: [14, true], CZ: [20, true], SK: [20, true] };
  function ibanValid(iban) {
    const r = iban.slice(4) + iban.slice(0, 4);
    let mod = 0;
    for (const ch of r) {
      const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
      for (const d of v) mod = (mod * 10 + +d) % 97;
    }
    return mod === 1;
  }
  const OCR_DIGIT = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', i: '1', L: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', b: '6', T: '7' };
  /** IBANs im Text (mit Prüfziffer geprüft; typische OCR-Verwechslungen O→0, I→1 … werden korrigiert). */
  function findIbans(t) {
    const out = [];
    const re = /\b([A-Z]{2})\s?([0-9OIlSBZ]{2})[\s]?((?:[A-Za-z0-9|][\s]?){10,34})/g;
    for (let m; (m = re.exec(t));) {
      const cc = m[1], spec = IBAN_LEN[cc];
      if (!spec) continue;
      const [len, digits] = spec;
      const raw = m[3].replace(/\s/g, '');
      if (raw.length < len) continue;
      let bban = raw.slice(0, len);
      const fix = (x) => x.split('').map((c) => (/\d/.test(c) ? c : OCR_DIGIT[c] || c)).join('');
      if (digits) bban = fix(bban);
      const iban = cc + fix(m[2]) + bban.toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) || !ibanValid(iban)) continue;
      // nach der Kontonummer darf keine weitere Ziffer folgen (sonst zu kurz gegriffen)
      out.push({ iban, pos: m.index });
      re.lastIndex = m.index + 4;
    }
    return out;
  }
  const fmtIban = (iban) => iban.replace(/(.{4})/g, '$1 ').trim();
  function parseAmount(intPart, cents) { return +(intPart.replace(/[.\s']/g, '') + '.' + cents); }

  /**
   * Überweisungsdaten einer Rechnung/Mahnung/eines Bescheids: IBAN, BIC, Empfänger, Betrag, Verwendungszweck.
   * directDebit = der Betrag wird abgebucht (keine Überweisung nötig). null, wenn nichts Brauchbares gefunden.
   */
  function payment(text, opts = {}) {
    if (!text || text.length < 20) return null;
    const t = text.slice(0, 20000).replace(/[ \t]+/g, ' ');
    const flat = t.replace(/\s+/g, ' ');
    const lt = lower(flat);
    const debit = /(wird|werden).{0,110}?(abgebucht|eingezogen)|per lastschrift|sepa-lastschrift(?!mandat)|lastschriftverfahren|bankeinzug/.test(lt)
      && !/(bitte|überweisen sie|zu überweisen|zahlen sie)[^.]{0,80}(überweis|auf (das|unser) konto)/.test(lt);
    // IBAN: bevorzugt mit „IBAN“/„Bankverbindung“ davor, nicht die des Empfängers („Ihre IBAN“)
    let iban = null, best = -Infinity;
    for (const c of findIbans(flat)) {
      const before = lt.slice(Math.max(0, c.pos - 60), c.pos);
      let s = 0;
      if (/iban\s*:?\s*$/.test(before)) s += 3;
      if (/bankverbindung|konto|überweis|zahlbar|kreditinstitut|bank\b|sparkasse|volksbank/.test(before)) s += 2;
      if (/\b(ihre?|ihr konto|ihrem konto|mandat|abgebucht|zahlungspflichtige)\b/.test(before)) s -= 4;
      if (/\*{2,}|x{3,}/i.test(flat.slice(c.pos, c.pos + 30))) s -= 5;
      if (s > best) { best = s; iban = c.iban; }
    }
    if (iban && best < -2) iban = null;
    const bicM = flat.match(/\b(?:BIC|SWIFT)(?:-Code)?\s*:?\s*([A-Z]{4}\s?[A-Z]{2}\s?[A-Z0-9]{2}(?:\s?[A-Z0-9]{3})?)\b/);
    const bic = bicM ? bicM[1].replace(/\s/g, '') : null;
    // Betrag
    let amount = null, bestA = -Infinity;
    const money = /(?:(?:€|EUR)\s?(\d{1,3}(?:[.\s']\d{3})*|\d+),(\d{2})(?!\d))|(?:(?<![\d,.])(\d{1,3}(?:[.\s']\d{3})*|\d+),(\d{2})\s?(?:€|EUR\b|Euro\b))/g;
    const amounts = [];
    for (let m; (m = money.exec(flat));) {
      const v = m[1] ? parseAmount(m[1], m[2]) : parseAmount(m[3], m[4]);
      if (!(v > 0) || v > 1e7) continue;
      const before = lt.slice(Math.max(0, m.index - 70), m.index);
      let s = 0;
      if (/(zu zahlen|zahlbetrag|rechnungsbetrag|gesamtbetrag|endbetrag|offene[nr]? betrag|noch offen|nachzahlung|zahlbar|betrag von|bruttobetrag|summe brutto|gesamt brutto|gesamtsumme|forderung|fälliger betrag|ausstehend|zahlen sie|überweisen sie)[^0-9]{0,40}$/.test(before)) s += 5;
      else if (/(gesamt|summe|total|betrag)[^0-9]{0,25}$/.test(before)) s += 2;
      if (/(netto|mwst|ust\.?|umsatzsteuer|mehrwertsteuer|zzgl|einzelpreis|rabatt|skonto|guthaben|erstattung|abschlag gezahlt|bereits gezahlt|zahlungen)[^0-9]{0,30}$/.test(before)) s -= 4;
      amounts.push({ v, s, pos: m.index });
      if (s > bestA || (s === bestA && v > amount)) { bestA = s; amount = v; }
    }
    if (bestA <= 0) amount = amounts.length === 1 ? amounts[0].v : null;
    // Empfänger
    const recM = t.match(/(?:zahlungs)?empfänger(?:in)?\s*:?\s*([^\n,;]{3,70})/i) || t.match(/kontoinhaber(?:in)?\s*:?\s*([^\n,;]{3,70})/i);
    const recipient = (recM ? clean(recM[1]) : opts.sender || '').replace(/\s*(IBAN|BIC)\b.*$/i, '').slice(0, 70) || null;
    // Verwendungszweck
    let reference = null;
    const vz = t.match(/verwendungszweck\s*:?\s*([^\n]{3,140})/i);
    if (vz && !/^\s*(bitte|angeben|unbedingt)/i.test(vz[1])) reference = clean(vz[1]).replace(/^["„“]|["„“]$/g, '');
    if (!reference) {
      const parts = [];
      const grab = (re, label) => { const m = flat.match(re); if (m && !parts.some((p) => p.includes(m[1]))) parts.push(`${label} ${m[1]}`); };
      grab(/kassenzeichen\s*:?\s*([A-Z0-9][A-Z0-9.\-\/ ]{3,30}[A-Z0-9])/i, 'Kassenzeichen');
      grab(/rechnungs?\s?-?\s?(?:nummer|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9.\-\/]{2,30})/i, 'Rechnung');
      if (!parts.length) grab(/\brechnung\s+nr\.?\s*:?\s*([A-Z0-9][A-Z0-9.\-\/]{2,30})/i, 'Rechnung');
      grab(/kunden\s?-?\s?(?:nummer|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9.\-\/]{2,30})/i, 'Kunde');
      grab(/vertrags\s?-?\s?(?:nummer|nr\.?|konto)\s*:?\s*([A-Z0-9][A-Z0-9.\-\/]{2,30})/i, 'Vertrag');
      grab(/steuer\s?-?\s?(?:nummer|nr\.?)\s*:?\s*(\d{2,3}\s?\/\s?\d{3,4}\s?\/\s?\d{4,5})/i, 'StNr');
      grab(/aktenzeichen\s*:?\s*([A-Z0-9][A-Z0-9.\-\/ ]{2,30}[A-Z0-9])/i, 'Az');
      reference = parts.join(', ').slice(0, 140) || null;
    }
    if (!iban && !debit) return null;
    return { iban, ibanFormatted: iban ? fmtIban(iban) : null, bic, recipient, amount, reference, directDebit: !iban && debit };
  }

  /** Inhalt eines GiroCodes (EPC-QR, Version 002) für Banking-Apps. */
  function giroCode(p) {
    const amt = p.amount ? 'EUR' + p.amount.toFixed(2) : '';
    const cut = (s, n) => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, n);
    return ['BCD', '002', '1', 'SCT', cut(p.bic, 11), cut(p.recipient, 70), p.iban, amt, '', '', cut(p.reference, 140)].join('\n');
  }

  /** Grundform der Dokumentart für Schlagwörter: „Stromrechnung“ → „Rechnung“, „Einkommensteuerbescheid“ → „Bescheid“. */
  function kindBase(kind) {
    if (!kind) return null;
    const lk = lower(kind).replace(/-/g, '');
    const k = KINDS.filter(([r]) => lk.endsWith(r)).sort((a, b) => b[0].length - a[0].length)[0];
    if (!k) return kind;
    const r = k[0] === 'zahlungserinnerung' ? 'mahnung' : k[0];
    return r[0].toUpperCase() + r.slice(1);
  }

  /** Allgemeine Dateinamen (z. B. „Scan_0001“, „IMG_1234“, „Dokument (2)“), die ersetzt werden dürfen. */
  const isGenericName = (n) => /^(?:scan(?:ned)?|scanner|img|image|bild|foto|photo|dsc|doc|dok|document|dokument|datei|file|unbenannt|untitled|neu|new|pdf|print|druck|cam|kopie|copy)?[\s_\-().\d]*$/i.test((n || '').replace(/\.pdf$/i, '').trim());

  return { suggest, letterInfo, deadlines, kindBase, payment, giroCode, ibanValid, isGenericName, _internals: { findDates, findKind, findSender } };
})();
if (typeof module !== 'undefined') module.exports = DocName;
