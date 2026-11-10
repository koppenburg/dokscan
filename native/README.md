# DokScan als iPad-/iPhone-App

Dieser Ordner verpackt die Web-App (übergeordneter Ordner) mit [Capacitor](https://capacitorjs.com) in eine echte iOS-App.
Der App-Code bleibt derselbe – Änderungen an der Web-App kommen mit `npm run sync` in die App.

Was die App gegenüber der Web-App zusätzlich kann:

- **Dauerhafter Speicher** im App-Container (Safari kann ihn nicht löschen, im iCloud-Backup des Geräts enthalten)
- **Teilen über das iOS-Menü** (Mail, Nachrichten, „In Dateien sichern“ …) für PDFs, mehrere PDFs, Kalendereinträge und Sicherungen
- **Erinnerungen an Fristen** als echte Mitteilungen (2 Tage vorher und am Tag; bei Terminen am Vorabend und 2 Stunden vorher) – Antippen öffnet das Dokument
- Texterkennung, PDF-Import und QR-Code funktionieren ohne Internet (alles ist in der App enthalten)

## Voraussetzungen

- Mac mit **Xcode 16** oder neuer
- **Node.js 22** oder neuer (z. B. von nodejs.org)
- Apple-Entwicklerkonto (für die Installation per TestFlight; zum reinen Ausprobieren per Kabel reicht auch eine kostenlose Apple-ID – die App läuft dann 7 Tage)

## App bauen und auf dem iPad starten

```bash
git clone https://github.com/koppenburg/dokscan.git
cd dokscan/native
npm install
npm run sync      # Web-App nach www/ kopieren und ins iOS-Projekt übernehmen
npm run open      # öffnet das Projekt in Xcode
```

In Xcode:

1. Links das Projekt **App** wählen → Ziel **App** → Reiter **Signing & Capabilities**
2. Bei **Team** dein Apple-Entwicklerkonto auswählen („Automatically manage signing“ eingeschaltet lassen).
   Ist die Bundle-ID `info.koppenburg.dokscan` schon vergeben, eine eigene eintragen (z. B. `info.koppenburg.dokscan2`).
3. iPad per Kabel anschließen und oben als Ziel auswählen, dann ▶︎ (**Run**).
   Beim ersten Mal auf dem iPad: *Einstellungen › Datenschutz & Sicherheit › Entwicklermodus* einschalten und neu starten.

## Über TestFlight installieren (empfohlen)

1. In [App Store Connect](https://appstoreconnect.apple.com) unter *Apps* eine neue App anlegen (Bundle-ID wie in Xcode, Name z. B. „DokScan“).
2. In Xcode oben als Ziel **Any iOS Device (arm64)** wählen → *Product › Archive*.
3. Im Fenster *Organizer*: **Distribute App** → **App Store Connect** → **Upload**.
4. In App Store Connect unter *TestFlight* dich selbst als internen Tester eintragen, auf dem iPad die App **TestFlight** öffnen und DokScan installieren.
   Hinweis: Bei der Frage zur Exportkontrolle („Verschlüsselung“) – DokScan nutzt Verschlüsselung nur für den Passwortschutz von PDFs über die Standardfunktionen von iOS.

## Updates

```bash
cd dokscan && git pull
cd native && npm install && npm run sync
```

Dann in Xcode erneut ▶︎ bzw. für TestFlight *Archive* (vorher unter *General* die **Build**-Nummer erhöhen).

## Daten aus der Web-App übernehmen

Die App hat ihren eigenen Speicher. Vorhandene Dokumente aus der Safari-Version überträgst du so:
in der Web-App *Einstellungen › Ablage sichern* → Datei in „Dateien“ speichern → in der App *Einstellungen › Sicherung laden*.

## Aufbau

| Pfad | Inhalt |
|------|--------|
| `capacitor.config.json` | App-ID, Name, Einstellungen |
| `scripts/copy-web.mjs` | kopiert die Web-App nach `www/` (wird nicht eingecheckt) |
| `ios/` | Xcode-Projekt (Swift Package Manager, kein CocoaPods) |
| `ios/App/App/Info.plist` | Berechtigungstexte (Kamera, Fotos) |
