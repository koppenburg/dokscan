// Kopiert die Web-App (übergeordneter Ordner) nach native/www – das ist der Inhalt der iOS-App.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, '..', 'www');
const FILES = [
  'index.html', 'styles.css', 'app.js', 'imaging.js', 'pdf.js', 'proc-worker.js', 'ocr.js', 'pdfimport.js',
  'naming.js', 'backup.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of FILES) {
  if (!existsSync(join(root, f))) throw new Error(`Datei fehlt: ${f}`);
  cpSync(join(root, f), join(out, f));
}
// Bibliotheken (Texterkennung, PDF-Import, QR-Code) – in der App immer offline verfügbar
cpSync(join(root, 'vendor'), join(out, 'vendor'), { recursive: true });
console.log(`Web-App nach ${out} kopiert (${FILES.length} Dateien + vendor/).`);
