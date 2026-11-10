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

## Über TestFlight verteilen

Voraussetzung: **bezahlte** Mitgliedschaft im Apple Developer Program (mit einer kostenlosen Apple-ID geht TestFlight nicht).

### 1. App in App Store Connect anlegen (einmalig)

[App Store Connect](https://appstoreconnect.apple.com) → *Apps* → **+** → *Neue App*:
Plattform iOS, Name „DokScan“ (muss im App Store frei sein, sonst z. B. „DokScan – Belege & Briefe“),
Primärsprache Deutsch, Bundle-ID wie in Xcode (`info.koppenburg.dokscan`), SKU frei wählbar (z. B. `dokscan`).
Taucht die Bundle-ID nicht auf: einmal in Xcode mit deinem Team bauen oder sie unter
[Identifiers](https://developer.apple.com/account/resources/identifiers/list) anlegen.

### 2. Build hochladen

1. In Xcode oben als Ziel **Any iOS Device (arm64)** wählen → *Product › Archive*.
2. Im *Organizer*: **Distribute App** → **App Store Connect** → **Distribute**.
   Jeder Upload braucht eine neue Build-Nummer: Xcode erhöht sie dabei meist selbst („Manage Version and Build Number“),
   sonst vorher unter *General › Build* hochzählen.
3. Nach 5–30 Minuten erscheint der Build in App Store Connect unter *TestFlight*.
   Die Frage zur Verschlüsselung entfällt: In `Info.plist` ist `ITSAppUsesNonExemptEncryption = NO` gesetzt,
   weil DokScan nur die in iOS eingebaute Verschlüsselung nutzt (WebCrypto für PDF-Passwörter).

### 3a. Interne Tester (sofort, ohne Prüfung durch Apple)

Bis zu 100 Personen, die in *Benutzer und Zugriff* deines Teams eingetragen sind (z. B. Familie mit Rolle „Marketing“ oder „Entwickler“).
*TestFlight* → *Interne Tests* → Gruppe anlegen → Tester hinzufügen. Sie bekommen eine Mail und installieren über die App **TestFlight**.

### 3b. Externe Tester (beliebige Personen, bis 10.000)

1. *TestFlight* → *Testinformationen* ausfüllen: kurze Beschreibung („Was soll getestet werden?“), Feedback-E-Mail,
   Kontaktdaten für Apple, **Datenschutz-URL**: `https://koppenburg.github.io/dokscan/datenschutz.html`.
   Anmeldedaten: „Keine Anmeldung erforderlich“.
2. *Externe Tests* → Gruppe anlegen → Build hinzufügen → **Zur Beta-Prüfung einreichen**.
   Die erste Prüfung dauert meist 1–2 Tage; spätere Builds derselben Version gehen meist ohne erneute Prüfung durch.
3. Danach Tester per E-Mail einladen **oder** einen **öffentlichen Link** aktivieren und weitergeben.

Ein TestFlight-Build läuft **90 Tage**; danach einen neuen hochladen.

### Später im App Store

Zusätzlich nötig: Screenshots (iPhone 6,9″ und iPad 13″), Beschreibung, Altersfreigabe-Fragebogen,
*App-Datenschutz* → „Keine Daten erfasst“, sowie in der EU die Angabe zum **Händlerstatus** (Digital Services Act).

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
| `ios/App/App/Info.plist` | Berechtigungstexte (Kamera, Fotos), Angabe zur Verschlüsselung |
| `ios/App/App/PrivacyInfo.xcprivacy` | Datenschutz-Manifest für Apple (kein Tracking, keine Datenerfassung) |
