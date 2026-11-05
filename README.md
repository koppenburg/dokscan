# DokScan – Unterlagen fotografieren & als PDF speichern

Web-App (PWA) für Handy, Tablet und Desktop: Unterlagen Seite für Seite fotografieren,
die Fotos werden automatisch zugeschnitten, aufbereitet und zu **einem PDF** zusammengefügt.
Alles läuft lokal im Browser – es werden keine Bilder hochgeladen, es gibt keine externen Abhängigkeiten.

## Funktionen

- **Dokumentenablage:** Jeder Scan wird als eigenes Dokument gespeichert (Vorschau, Name, Seitenzahl, Datum). **Suche** über Namen *und* erkannten Text, Umbenennen mit Namensvorschlägen aus dem Text, Löschen, später weitere Seiten ergänzen.
- **Serienaufnahme** mit der Rückkamera (Live-Vorschau, Auslöser, Licht/Taschenlampe falls verfügbar).
- **Automatisch auslösen:** Liegt das Dokument ca. 1 Sekunde ruhig im Bild, wird das Foto von selbst gemacht (Fortschrittsring am Auslöser). Danach wartet die App, bis die nächste Seite aufgelegt ist – so entsteht kein Doppelfoto. Ein-/ausschaltbar über „Auto“ in der Kamera.
- **Zoom & Kamerawahl:** Zoom-Tasten (z. B. 0,5× / 1× / 2×) und Zoomen mit zwei Fingern, Wechsel auf Ultraweitwinkel u. a. – sofern das Gerät es unterstützt. Modus **„Weites Sichtfeld“** (auf dem iPad automatisch aktiv) verhindert das stark vergrößerte Kamerabild.
  Ohne Kamerazugriff wird automatisch die Kamera-App des Geräts verwendet.
- **Import** vorhandener Fotos und **PDFs** (Mehrfachauswahl oder Drag & Drop am Desktop). PDF-Seiten werden als Bilder übernommen, vorhandener Text wird mit Position übernommen (kein OCR nötig); passwortgeschützte PDFs fragen nach dem Passwort. So lassen sich an ein bestehendes PDF weitere Seiten anscannen.
- **Mehrere Seiten bearbeiten**: „Auswählen“ in der Dokumentansicht – Filter, Drehung oder Löschen für alle ausgewählten Seiten auf einmal.
- **Automatische Randerkennung**: Schon in der Kamera wird der erkannte Dokumentrand live als Rahmen angezeigt; das Foto wird automatisch zugeschnitten und entzerrt. Kantenbasiert (Geradensuche + Bewertung von Kantenverlauf und Farbunterschied innen/außen), mit Feinjustierung auf dem vollen Foto – robust auch bei Holzmaserung, Mustern, Fliesen und Kopfzeilen. Ecken lassen sich mit Lupe manuell nachziehen. Messung: `tools/edge-benchmark.html`.
- **Unschärfe-Warnung**: Nach jeder Aufnahme wird die Schärfe gemessen. Wirkt ein Foto unscharf, erscheint direkt in der Kamera „Seite 3 wirkt unscharf – Neu aufnehmen“; zusätzlich Markierung in der Seitenübersicht, Hinweis im Editor und im PDF-Dialog. Abschaltbar in den Einstellungen.
- **Seite neu aufnehmen**: Im Editor eine unscharfe oder schiefe Seite neu fotografieren – Position und Filter bleiben, „Rückgängig“ stellt das alte Foto wieder her.
- **Filter:** Dokument (Schatten entfernen, weißes Papier), Original, Graustufen, Schwarz-Weiß.
- Seiten **drehen, löschen und per Ziehen umsortieren**.
- **Texterkennung (OCR):** Der Text wird lokal auf dem Gerät erkannt (Tesseract, Deutsch). Das PDF wird durchsuchbar, Text lässt sich markieren und kopieren; im Editor zeigt „Text“ den erkannten Text zum Kopieren. Beim ersten Mal werden ca. 9 MB geladen, danach funktioniert es offline.
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
5. Seite antippen, um Zuschnitt, Drehung, Filter oder Reihenfolge zu ändern; „Text“ zeigt den erkannten Text.

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
| `sw.js`, `manifest.webmanifest`, Icons | PWA / Offline |

Nach Änderungen an App-Dateien `CACHE` in `sw.js` hochzählen, damit installierte Apps die neue Version laden.
