# Pendelpilot

Persönlicher Pendel- und Tagesplaner. Die App betrachtet **Hinweg, Rückweg, Arbeitszeit, Studium,
Termine, gelernte Verkehrsmuster und die aktuelle Verkehrslage gemeinsam** und empfiehlt, wann du
losfährst und wann du Feierabend machst – mit Begründung und Alternativen.

## Was die App macht

| | |
|---|---|
| **Vorabend** (z. B. 20:00) | „Morgen voraussichtlich beste Abfahrt: 07:12“ – mit Feierabend & Heimkehr |
| **Am Tag selbst** | prüft alle 5 Minuten automatisch die Lage; meldet sich nur, wenn sich die beste Zeit spürbar verschiebt: „Aktuell sieht 07:18 besser aus“ |
| **Kurz vor der Fahrt** | „In 15 Minuten losfahren – aktuell beste Option“ |
| **Während Vorlesungen** | keine Störung. Muss man direkt nach einer Vorlesung los, kommt der Hinweis *vor* Beginn |
| **Lernen** | misst regelmäßig die echten Fahrzeiten, erkennt Wochentags-/Uhrzeitmuster und wie stark Prognosen danebenliegen |

### Wie entschieden wird

Für jeden Tag probiert der Planer alle sinnvollen Kombinationen durch (Arbeitsbeginn im erlaubten
Zeitfenster, Abfahrtszeiten im 5-Minuten-Raster, bei optionalen Veranstaltungen: ganz / teilweise / gar nicht)
und bewertet sie mit deinen Prioritäten:

- **Pflichttermine** und **Arbeitszeit** (inkl. automatischer Pause, z. B. 8 h → 8,5 h vor Ort) sind feste Bedingungen.
- Abgewogen werden: **Minuten im Auto**, **Minuten weg von zu Hause** und **verpasste Minuten optionaler Termine**.
  Die Gewichte stellst du mit Reglern ein.
- Längeres Bleiben nach Feierabend ist erlaubt, wenn sich dadurch der Stau auflöst.

Fahrzeit-Prognose = Prognose des Verkehrsdienstes (TomTom) für den Tag, gemischt mit deinen eigenen
Erfahrungswerten (gleicher Wochentag, neuere Wochen zählen mehr), korrigiert um die gelernte
Prognose-Abweichung. Am Tag selbst korrigiert die gemessene aktuelle Lage die nächsten Stunden.

## Einrichtung (einmalig)

1. **Verkehrsdaten:** kostenlosen Schlüssel bei [developer.tomtom.com](https://developer.tomtom.com/user/register)
   holen (keine Kreditkarte) und in der App unter *Einstellungen → Verkehrsdaten* einfügen.
2. **Orte:** unter *Einstellungen → Orte* Zuhause, Arbeit, Uni eintragen und „Suchen“ tippen.
3. **Benachrichtigungen:** In der App (vom Home-Bildschirm geöffnet) unter *Mehr → Benachrichtigungen*
   „Mitteilungen erlauben“ tippen. Die Nachrichten kommen direkt aufs Handy (Web Push, ab iOS 16.4).
   Alternativ geht die App **ntfy** – dann am besten mit eigenem ntfy-Zugangsschlüssel, sonst teilt sich
   der Server das kostenlose Kontingent mit anderen (Fehler 429).
4. **Plan:** Arbeitszeiten pro Wochentag, Stundenplan und Termine unter *Plan* eintragen.
5. App auf dem Handy **zum Home-Bildschirm hinzufügen** (Safari: Teilen → „Zum Home-Bildschirm“).

Bis ein TomTom-Schlüssel eingetragen ist, läuft die App mit einem Demo-Verkehrsmodell.

## Konto & Anmeldung

- Registrieren und Anmelden mit E-Mail + Passwort oder mit Google (Supabase Auth).
- Jedes Konto hat eigene Einstellungen, Termine, gelernte Fahrzeiten und Mitteilungen.
- Daten aus der Zeit vor den Konten (alter Zugangsschlüssel) werden beim ersten Anmelden auf dem Gerät mit dem Schlüssel automatisch übernommen.
- Unter Mehr → Konto: Passwort ändern, abmelden, Konto mit allen Daten löschen.

Einmalig im Supabase-Dashboard: *Authentication → URL Configuration* → Site URL `https://joelrxcreator.github.io/first-repository/` (auch bei Redirect URLs eintragen). Für Google: in der Google Cloud Console einen OAuth-Client (Web) mit Redirect-URI `https://ntkooxdivapuznjufdwj.supabase.co/auth/v1/callback` anlegen und Client-ID/Secret unter *Authentication → Sign In / Providers → Google* eintragen. Der Google-Knopf erscheint in der App automatisch, sobald das eingeschaltet ist.

## Eigene Abfahrtszeit & sofort aktualisieren

- Auf „Morgen“ unter „Wann willst du los?“ eine Uhrzeit wählen: Die Fahrzeit erscheint sofort. „Für morgen festlegen“ plant den Tag mit genau dieser Abfahrt und zeigt den Vergleich zur besten Zeit.
- Auch im Sheet „… anpassen“ gibt es „Losfahren um (optional)“.
- Nach jeder Änderung holt die App sofort frische Verkehrsprognosen (höchstens alle 3 Minuten).
- Ganz oben nach unten ziehen = aktualisieren (oder „Jetzt aktualisieren“ antippen).

## Technik (für später)

```
web/                        Handy-App (HTML/JS, keine Build-Tools) → GitHub Pages
supabase/functions/pendel/  Backend (Supabase Edge Function)
  core/                     Planer, Verkehrsmodell, Benachrichtigungslogik (reines JS, getestet)
  server.js                 Ablauf: /tick (alle 5 min), /overview, /settings, /state …
  providers.js              TomTom (Routing, Adresssuche), ntfy (Push)
supabase/migrations/        Datenbank
supabase/cron.sql           Zeitplan für die automatische Prüfung (pg_cron)
tests/                      node --test
tools/dev-server.js         lokaler Testserver im Demo-Modus
```

- Tests: `npm test`
- Lokal ausprobieren: `npm run dev` und den ausgegebenen Link öffnen.
- Zugang: Die App spricht nur mit der Edge Function; die prüft einen geheimen Schlüssel
  (Tabelle `app_secret`). Alle Tabellen sind per Row Level Security gesperrt.
- Verbrauch: einstellbar unter *Mehr → Datenabrufe* (Häufigkeit, Zeitraum, Tageslimit, Protokoll); kostenlos bis 2.500 TomTom-Abfragen/Tag. Zwischen zwei Abfragen liegen mind. 260 ms (TomTom-Ratenlimit).
- Push: `webpush.js` (VAPID + aes128gcm nur mit WebCrypto, keine Zusatzpakete).
