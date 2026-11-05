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
        if (/(geburtsdatum|geb\.|geboren)/.test(l)) s -= 6;
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

  /** Allgemeine Dateinamen (z. B. „Scan_0001“, „IMG_1234“, „Dokument (2)“), die ersetzt werden dürfen. */
  const isGenericName = (n) => /^(?:scan(?:ned)?|scanner|img|image|bild|foto|photo|dsc|doc|dok|document|dokument|datei|file|unbenannt|untitled|neu|new|pdf|print|druck|cam|kopie|copy)?[\s_\-().\d]*$/i.test((n || '').replace(/\.pdf$/i, '').trim());

  return { suggest, isGenericName, _internals: { findDates, findKind, findSender } };
})();
if (typeof module !== 'undefined') module.exports = DocName;
