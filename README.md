# DokScan – Unterlagen fotografieren & als PDF speichern

Web-App (PWA) für Handy, Tablet und Desktop: Unterlagen Seite für Seite fotografieren,
die Fotos werden automatisch zugeschnitten, aufbereitet und zu **einem PDF** zusammengefügt.
Alles läuft lokal im Browser – es werden keine Bilder hochgeladen, es gibt keine externen Abhängigkeiten.

## Funktionen

- **Dokumentenablage:** Jeder Scan wird als eigenes Dokument gespeichert (Vorschau, Name, Seitenzahl, Datum). **Suche** über Namen *und* erkannten Text, Umbenennen mit Namensvorschlägen aus dem Text, Löschen, später weitere Seiten ergänzen.
- **Mehrere Dokumente senden:** „Auswählen“ in der Ablage, Dokumente antippen, dann „Senden“ – als einzelne PDFs oder zusammen als ein PDF, mit den PDF-Einstellungen; danach „Teilen“ (Mail, Nachrichten, Dateien …) oder „Speichern“. Ausgewählte Dokumente lassen sich auch gemeinsam löschen.
- **Ordnen:** Schlagwörter je Dokument (mit Vorschlägen aus dem Brief: Absender, Art, Jahr), Filter nach Schlagwort oder „Fristen“, Sortierung nach zuletzt geändert, Briefdatum (mit Monatsgruppen), Absender (gruppiert) oder Name. Die Suche findet auch Schlagwörter und Absender.
- **Fristen und Termine:** Aus dem Text erkannt – z. B. „zahlbar bis 16.11.2026“, „fällig am …“, „Termin am Dienstag, 24.11.2026 um 9:30 Uhr“, „Angebot gültig bis …“ sowie relative Fristen wie „Einspruch innerhalb eines Monats nach Bekanntgabe“ (ab Briefdatum berechnet, als „bitte prüfen“ markiert). Anzeige in der Ablage (farbig, wenn bald fällig oder überfällig) und im Dokument mit „In den Kalender“ (Kalendereintrag mit Erinnerung), „Erledigt“, Bearbeiten und eigenen Fristen.
- **Überweisung aus der Rechnung:** IBAN (mit Prüfziffer, OCR-Fehler wie O/0 werden korrigiert), BIC, Empfänger, Betrag und Verwendungszweck (Rechnungs-, Kunden-, Steuernummer, Kassenzeichen …) werden erkannt. Im Dokument lässt sich jedes Feld einzeln kopieren; „GiroCode“ zeigt einen QR-Code für Banking-Apps (EPC-QR). Werte lassen sich korrigieren; „Bezahlt“ erledigt auch die Zahlungsfrist. Bei Lastschrift weist die App darauf hin, dass keine Überweisung nötig ist.
- **Prüfschritt nach dem Scannen:** Nach „Fertig“ werden die neuen Seiten groß angezeigt (wischen zum Blättern, neu aufnehmen, zuschneiden, drehen, löschen), erst dann entsteht das PDF. Abschaltbar in den Einstellungen.
- **Automatische Benennung:** Aus dem erkannten Text der ersten Seite werden Datum, Absender und Art des Schreibens ermittelt, z. B. „2026-10-28 Stadtwerke Musterstadt Stromrechnung“ oder „2026-09-14 Finanzamt Musterstadt Einkommensteuerbescheid“. Der Name passt sich an, solange er nicht von Hand geändert wurde; leeres Namensfeld = wieder automatisch. Importierte PDFs behalten ihren Dateinamen, außer bei Namen wie „Scan_0001.pdf“. Abschaltbar in den Einstellungen.
- **Serienaufnahme** mit der Rückkamera (Live-Vorschau, Auslöser, Licht/Taschenlampe falls verfügbar).
- **Automatisch auslösen:** Liegt das Dokument ca. 1 Sekunde ruhig im Bild, wird das Foto von selbst gemacht (Fortschrittsring am Auslöser). Danach wartet die App, bis die nächste Seite aufgelegt ist – so entsteht kein Doppelfoto. Ein-/ausschaltbar über „Auto“ in der Kamera.
- **Zoom & Kamerawahl:** Zoom-Tasten (z. B. 0,5× / 1× / 2×) und Zoomen mit zwei Fingern, Wechsel auf Ultraweitwinkel u. a. – sofern das Gerät es unterstützt. Modus **„Weites Sichtfeld“** (auf dem iPad automatisch aktiv) verhindert das stark vergrößerte Kamerabild.
  Ohne Kamerazugriff wird automatisch die Kamera-App des Geräts verwendet.
- **Import** vorhandener Fotos und **PDFs** (Mehrfachauswahl oder Drag & Drop am Desktop). PDF-Seiten werden als Bilder übernommen, vorhandener Text wird mit Position übernommen (kein OCR nötig); passwortgeschützte PDFs fragen nach dem Passwort. So lassen sich an ein bestehendes PDF weitere Seiten anscannen.
- **Mehrere Seiten bearbeiten**: „Auswählen“ in der Dokumentansicht – Filter, Drehung oder Löschen für alle ausgewählten Seiten auf einmal.
- **Automatische Randerkennung**: Schon in der Kamera wird der erkannte Dokumentrand live als Rahmen angezeigt; das Foto wird automatisch zugeschnitten und entzerrt. Kantenbasiert (Geradensuche + Bewertung von Kantenverlauf und Farbunterschied innen/außen), mit Feinjustierung auf dem vollen Foto – robust auch bei Holzmaserung, Mustern, Fliesen und Kopfzeilen. Ecken lassen sich mit Lupe manuell nachziehen. Messung: `tools/edge-benchmark.html`.
- **Unschärfe-Warnung**: Nach jeder Aufnahme wird die Schärfe gemessen. Wirkt ein Foto unscharf, erscheint direkt in der Kamera „Seite 3 wirkt unscharf – Neu aufnehmen“; zusätzlich Markierung in der Seitenübersicht, Hinweis im Editor und im PDF-Dialog. Abschaltbar in den Einstellungen.
- **Seite neu aufnehmen**: Im Editor eine unscharfe oder schiefe Seite neu fotografieren – Position und Filter bleiben, „Rückgängig“ stellt das alte Foto wieder her.
- **Filter:** Dokument (Schatten entfernen, weißes Papier), Original, Graustufen, Schwarz-Weiß. Fotos, Logos und farbige Flächen auf der Seite bleiben erhalten.
- **Perspektive:** Schräg fotografierte Seiten werden mit dem echten Seitenverhältnis entzerrt (A4/Letter werden erkannt).
- **Helligkeit und Kontrast:** „Anpassen“ im Editor öffnet zwei Regler mit Live-Vorschau – für blasse Kopien, Durchschläge oder dunkle Fotos. „Alle Seiten“ überträgt die Einstellung auf das ganze Dokument (mit „Rückgängig“). Doppeltippen auf einen Regler setzt ihn zurück.
- Seiten **drehen (die Vorschau dreht sich sofort mit), löschen (mit „Rückgängig“) und per Ziehen umsortieren**; im Editor mit den Pfeilen am Bildrand, per Wischen oder mit den Pfeiltasten zwischen den Seiten blättern.
- **Datensicherung:** In den Einstellungen „Ablage sichern“ erstellt eine ZIP-Datei mit allen Dokumenten (z. B. für „Dateien“/iCloud Drive), „Sicherung laden“ stellt sie wieder her – auch auf einem anderen Gerät. Die Einstellungen zeigen den belegten Speicher und das Datum der letzten Sicherung; in Safari ohne Home-Bildschirm erscheint ein Hinweis, dass Daten sonst gelöscht werden können.
- **Texterkennung (OCR):** Der Text wird lokal auf dem Gerät erkannt (Tesseract, Deutsch). Das PDF wird durchsuchbar, Text lässt sich markieren und kopieren; im Editor zeigt „Text“ den erkannten Text zum Kopieren. Die Dateien (ca. 7 MB) werden beim ersten Start im Hintergrund geladen und bleiben auch nach App-Updates offline verfügbar.
- **Passwortschutz**: PDF optional mit Öffnen-Passwort (AES-256, PDF-Standard R6); das Passwort wird nicht gespeichert.
- **PDF-Einstellungen**: Seitenformat A4, A5, US Letter oder wie Foto; Ausrichtung automatisch/hoch/quer; Seitenrand ohne/5/10/20 mm; maximale Dateigröße 1/2/5 MB (z. B. für E-Mail) – die Bilder werden dann nur so weit verkleinert wie nötig.
- **PDF automatisch nach dem Scannen**: drei Qualitätsstufen,
  danach teilen (z. B. Mail, WhatsApp, Dateien), speichern oder ansehen.
- Seiten bleiben beim Neuladen erhalten (IndexedDB), bis ein neues Dokument begonnen wird.
- Installierbar auf dem Homescreen und offline nutzbar (Service Worker).

## Benutzung

1. In der Ablage auf **Scannen** tippen (legt ein neues Dokument an) und Kamerazugriff erlauben.
2. Seiten nacheinander fotografieren (automatisch oder per Auslöser), dann **Fertig**.
3. Das PDF wird sofort erstellt → **Teilen** oder **Speichern**.
4. Das Dokument bleibt in der Ablage: antippen zum Ansehen, Ergänzen (Scannen/Importieren) oder erneuten PDF-Export; Name antippen zum Umbenennen.
5. Seite antippen, um Zuschnitt, Drehung, Filter, Helligkeit/Kontrast oder Reihenfolge zu ändern; „Text“ zeigt den erkannten Text.

## Als iPad-/iPhone-App

Im Ordner [`native/`](native/README.md) liegt eine iOS-App (Capacitor) mit dauerhaftem Speicher, Teilen über das iOS-Menü und Erinnerungen an Fristen als Mitteilungen. Bauen mit Xcode auf dem Mac – Anleitung in [`native/README.md`](native/README.md).

## Online nutzen

**https://koppenburg.github.io/dokscan/**

Am Handy öffnen und über „Zum Home-Bildschirm“ (iOS: Teilen-Menü, Android: Browser-Menü) als App installieren.

## Bereitstellen

Die Kamera funktioniert nur über **HTTPS** (oder `localhost`). Die App besteht nur aus statischen Dateien
und läuft über **GitHub Pages** direkt aus diesem Repository:

1. **Settings → Pages**
2. *Source:* „Deploy from a branch“, Branch `main`, Ordner `/ (root)` → **Save**
3. Nach 1–2 Minuten erreichbar unter `https://koppenburg.github.io/dokscan/`

Lokal testen:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Aufbau

| Datei | Inhalt |
|-------|--------|
| `index.html` | Oberfläche (Übersicht, Kamera, Editor, Dialoge) |
| `app.js` | App-Logik, Kamera, Speicher, PDF-Ablauf |
| `imaging.js` | Bildverarbeitung: Drehen, Perspektivkorrektur, Filter, Randerkennung |
| `pdf.js` | Eigener, minimaler PDF-Writer (JPEG-Seiten, unsichtbare Textebene) |
| `proc-worker.js` | Hintergrund-Thread für die Bildverarbeitung |
| `ocr.js`, `vendor/tesseract/` | Texterkennung (Tesseract, lokal eingebunden) |
| `pdfimport.js`, `vendor/pdfjs/` | PDF-Import (pdf.js, lokal eingebunden) |
| `naming.js` | Namensvorschlag aus dem Text (Datum, Absender, Dokumentart) |
| `backup.js` | Datensicherung der Ablage als ZIP (ohne fremde Bibliothek) |
| `vendor/qrcode/` | QR-Code für den GiroCode (qrcode-generator, MIT, lädt bei Bedarf) |
| `sw.js`, `manifest.webmanifest`, Icons | PWA / Offline |

Nach Änderungen an App-Dateien `CACHE` in `sw.js` hochzählen, damit installierte Apps die neue Version laden.
