# HA List Manager

**Einkaufslisten, Inventar und Aufgaben — gemeinsam in Home Assistant.**

[English](README.md) · Deutsch · [Wiki](https://github.com/Nisbo/ha-list-manager/wiki/Home-DE)

HA List Manager ist die Weiterentwicklung der
[Improved Shopping List Card](https://github.com/Nisbo/ha-shopping-list-improved)
mit gemeinsamer Produktdatenbank und zentraler Verwaltung in Home Assistant.

<!-- ha-marketplace:exclude-start -->
[![HA List Manager in Marketplace öffnen](https://my.home-assistant.io/badges/marketplace_repository.svg)](https://my.home-assistant.io/redirect/marketplace_repository/?owner=Nisbo&repository=ha-list-manager&category=integration)
<!-- ha-marketplace:exclude-end -->

Einkäufe planen, Vorräte im Blick behalten und wiederkehrende Aufgaben verwalten.
Die drei Dashboard-Karten lassen sich einzeln oder zusammen verwenden.
Einkaufsliste und Inventar nutzen dieselbe Produktdatenbank; Kategorien, Labels
und Schnelleingaben helfen beim Organisieren der Listen. Die Oberfläche und das
vollständige Wiki gibt es auf Deutsch und Englisch.

![Kompakte Dashboard-Karten für Inventar, Einkaufsliste und Aufgaben](docs/images/de/overview-desktop.jpg)

## Unterstützte Scanner

Unter **HA List Manager → Scanner** stehen Eyoyo, ein konfigurierbares MQTT-Topic,
eine **Home-Assistant-Entität** und **USB 2 MQTT Scanner** zur Wahl. Entitätsscanner
lesen den Barcode aus dem Zustand oder einem benannten Attribut, optional mit
einem Scan-ID-Attribut. Eine neue ID erlaubt den erneuten Scan desselben Barcodes;
wiederholte IDs werden auch nach einem HA-Neustart ignoriert. Vorhandene Werte
beim Aktivieren oder Starten fügen keine Artikel hinzu.

[USB 2 MQTT Scanner](https://github.com/Nisbo/usb-scanner-mqtt) verbindet USB-
Tastaturscanner mit MQTT und Home Assistant Discovery. Wähle dessen automatisch
erkannte **Last-scan**-Entität; Topic und JSON-Zuordnung sind nicht nötig. Richte
einen physischen Scanner nur über eine Quelle ein. Die Verarbeitung läuft zentral
ohne geöffnete Karte; die vorhandenen Listen- und Aktionszuordnungen gelten weiter.

## Drei Listenarten

### Einkaufslisten

- Freie Artikel hinzufügen oder gespeicherte Produkte mit Bildern und Packungsgrößen auswählen.
- Anzahl und Beschreibungen verwalten.
- Schnelleingaben wiederverwenden und Artikel mit **Nur kaufen, wenn im Angebot** markieren.
- Angebote filtern und Artikel suchen.
- Zutaten aus gespeicherten Gerichten oder Tandoor-Rezepten auf lokale Einkaufslisten setzen.
- Artikel an eine andere Einkaufsliste senden, PDFs exportieren oder Benachrichtigungen verschicken.
- Bring!-Listen über die offizielle Bring!-Integration von Home Assistant verbinden.

### Inventar

- Separate Bestandslisten für Küche, Gefrierschrank oder Vorratsraum führen.
- Produkte einlagern, entnehmen, Bestände korrigieren und die letzte manuelle Buchung 60 Sekunden rückgängig machen.
- Zum Einlagern und Entnehmen Barcodes scannen; Bestände auch mit den Plus-/Minus-Buttons ändern.
- Mindestbestände festlegen und fehlende Artikel manuell oder automatisch nachbestellen.
- Nachbestellregeln pro Liste, Produkt oder Gruppe austauschbarer Produkte festlegen.

### To-do-Listen

- Aufgaben mit Notizen, Fälligkeit, Uhrzeit und Wiederholungsintervallen organisieren.
- Wiederverwendbare Aufgabenvorlagen anlegen und Fälligkeitswarnungen einstellen.
- Aufgaben suchen, nach Fälligkeit sortieren und erledigte Aufgaben ausblenden.
- Aufgaben unabhängig von Produkten und Barcodes verwalten.

**Mobile Kartenansichten im Dashboard**

![Inventar und Einkaufsliste in der mobilen Kartenansicht](docs/images/de/overview-tablet.jpg)


### QR-Aktionen für vorhandene Aufgaben

Öffne in einer bestehenden To-do-Aufgabe **Aktion wählen → QR-Code erstellen …**.
Wähle „Neue Fälligkeit ab jetzt“, „Neue Fälligkeit ab bisherigem Termin“,
„Als erledigt markieren“ oder „Nur Zuletzt geprüft auf jetzt setzen“.
Der Code lässt sich als Bild kopieren, als PNG herunterladen oder mit Aufgabenname
und Aktion drucken. Er bleibt nach einer Umbenennung gültig.

**Aufgaben-QR scannen** in der Buttonleiste öffnet die Kamera. Vor der Ausführung
erscheint eine Bestätigung; der Karteneditor bietet optional einen Direktmodus.
Registrierte Scanner führen die Aktion zentral und unabhängig vom Scannerziel aus.
Pausierte Überwachung bleibt pausiert. Doppellesungen werden drei Sekunden lang
geräteübergreifend unterdrückt; wiederholte Anfragen bleiben auch nach einem
HA-Neustart ohne weitere Wirkung. Ein späterer neuer Scan ist wieder möglich.

### Eigene Produktdatenquelle

Unter **Backend → Einstellungen → Produktdatenquelle** stehen Open Food Facts
(Standard) und ein eigener **mit Open Food Facts v3 kompatibler** Server zur Auswahl, zum Beispiel
[OFF Proxy Server](https://github.com/Nisbo/off-proxy-server). Trage die
Basisadresse und optional einen API-Schlüssel ein. Ein leerer Schlüssel sendet
keinen Anmeldungsheader. Lokale Produkte werden zuerst geprüft; Karten und
Scanner nutzen dieselbe Quelle. Die beiden optionalen Rückfälle auf Open Food Facts bei
fehlenden Produkten und Serverfehlern sind standardmäßig ausgeschaltet. Der
Verbindungstest verwendet nur die ausgewählte Quelle und speichert keine
Produkte. Ursprüngliche Bildadressen bleiben erhalten.

## Einkaufen mit Alexa

„Alexa, setze Gurken auf die Einkaufsliste“ — und der Eintrag landet in
HA List Manager. Dazu wird eine vorhandene Liste aus der HA-Integration
**Alexa Devices** einer lokalen Einkaufsliste zugeordnet.

- **Alexa als Eingang (empfohlen):** neue Einträge übernehmen und standardmäßig bei Alexa löschen.
- **Verknüpfte Artikel abgleichen:** zusätzlich Status, Löschungen und optional Mengen abgleichen.
- **Abgleich mit neuen lokalen Artikeln:** auch künftig neu angelegte lokale Artikel an Alexa senden.

Die optionale Mengen- und Einheitenerkennung verarbeitet gesprochene Angaben.
Aliasse ordnen mehrere Ausdrücke einem bestimmten Produkt oder einem anderen
Artikelnamen zu. Im Tab **Test** lässt sich das Ergebnis vorab ausprobieren.

## Gerichte und optionale Tandoor-Anbindung

- **Eigene Gerichte speichern:** Zutaten als freie Artikel oder verknüpfte
  Produkte zusammenstellen, etwa Tomaten, Zwiebeln und Knoblauch für eine
  Tomatensuppe. Beim Hinzufügen Zutaten auswählen, Anzahlen anpassen und
  Kategorien prüfen.
- **Tandoor Recipes verbinden (optional):** Eine vorhandene Tandoor-Instanz
  unter **HA List Manager → Einstellungen** mit Adresse und API-Token einrichten.
  In der Einkaufskarte Rezepte suchen oder ein Kochbuch auswählen, die
  Portionszahl anpassen und die gewünschten Zutaten auf die Einkaufsliste setzen.
  Die Portionsanpassung setzt entsprechende Angaben im Rezept voraus.

Gerichte und Tandoor lassen sich für jede lokale Einkaufsliste getrennt
aktivieren. Die Zutaten werden der Einkaufsliste hinzugefügt; es wird dabei
kein Inventarbestand gebucht.

[Anleitung zu Gerichten und Rezepten](https://github.com/Nisbo/ha-list-manager/wiki/Chips-Dishes-and-Recipes-DE)

## Dein Tandoor-Kochbuch als Dashboard-Karte

Wähle **Tandoor** in der Kartenauswahl des Dashboards.
Durchstöbere Kochbücher, suche Rezepte, passe Portionen an und lies Zutaten und
Zubereitung auf großen Bildschirmen nebeneinander. Koch-Häkchen bleiben lokal
in deinem Browser. Wähle eine Einkaufsliste mit aktiviertem Tandoor, um vor der
Übernahme die vorhandene Zutaten-, Mengen- und Kategorieauswahl zu öffnen.

Für eine einzelne, seitenfüllende Karte eignet sich eine HA-Ansicht vom Typ
**Panel**; die Karte passt sich automatisch an. Zusätzlich gibt es einen
Vollbild-Button. **Lesestand in diesem Browser merken** erhält Kochbuch, Suche,
Seite, geöffnetes Rezept, Portionen, Häkchen und Scrollposition beim Neuladen.
Mehrere Karten auf derselben Seite können mit unterschiedlichen **Karten-IDs**
ihren eigenen Lesestand behalten. Ein Klick auf die Kochmütze vergrößert die Karte im Dashboard, ein Klick auf
den Titel klappt sie ein. Beides ist standardmäßig aktiviert und separat
abschaltbar. Der Klappzustand bleibt unabhängig vom optionalen Lesestand erhalten.
Unter der Suchmaske lassen sich Zutaten und Rezepttexte zusätzlich zu den
Rezeptnamen durchsuchen. Diese Auswahl wird zusammen mit der Suche gemerkt.

Die Karte nutzt die vorhandene Tandoor-
Verbindung und erlaubt das Stöbern auch ohne Einkaufsliste. Private API-Zugangsdaten
bleiben im Backend.

## Watchlist

Füge **HA List Manager · Watchlist** über die Kartenauswahl im Dashboard hinzu. Hinterlege unter **HA List Manager → Watchlist → Einstellungen** deinen [TMDB-Zugriffstoken mit Leserechten](https://www.themoviedb.org/settings/api), um die Online-Suche freizuschalten.

Füge Filme, Filmreihen und Serien direkt in der Karte hinzu. Markiere Filme, Staffeln oder einzelne Folgen als gesehen und filtere nach Genres oder Labels. Unter **Labels → Watchlist** legst du eigene Labels an oder schaltest die globalen Labels gemeinsam ein. Den Gesehen-Status kannst du gemeinsam oder einzeln führen. Unter **Weiterschauen** findest du die nächste ungesehene Folge. Favoriten gehören zu deinem Home-Assistant-Konto. Mit **Alle anzeigen** siehst du die Favoriten aller Nutzer, jeden Titel einmal. Jeder Browser merkt sich die zuletzt geöffnete Ansicht.

[Watchlist-Anleitung mit Screenshots und TV-Demo-Skript](https://github.com/Nisbo/ha-list-manager/wiki/Watchlist-DE)

## Kategorien und Labels in allen drei Listenarten

- **Kategorien** gliedern die Liste, etwa in Getränke, Backwaren oder Haushalt.
  Jeder Eintrag gehört zu einer Kategorie oder zu Allgemein.
- **Mehrere Labels pro Eintrag** ergänzen diese Ordnung. Milch kann zur Kategorie
  Getränke gehören und gleichzeitig die Labels Frühstück und Laktosefrei tragen.
  Bei Aufgaben könnten es Garten und Wochenende sein.
- **Nach Kategorien oder Labels gruppieren:** In der Labelansicht erscheint ein
  Eintrag unter jedem seiner Labels. Es bleibt derselbe Eintrag: Anzahl,
  Erledigt-Status und Änderungen werden in allen Ansichten übernommen.
- **Gemeinsam oder getrennt verwalten:** Kategorien und Labels können global,
  für einen Listentyp oder nur für eine Liste gelten, jeweils mit Symbol und Farbe.
  Bei gleichen Namen hat die einzelne Liste Vorrang vor dem Listentyp und Global.
- **Schnell auswählen und ändern:** über die Suche, die Ausklappliste,
  das Auswahlpopup oder die Schnellbuttons im Bearbeitungsdialog.

Automatische Kategoriezuordnungen sortieren neue Einträge anhand ihres Namens
ein. Schnelleingaben und Aufgabenvorlagen dienen dagegen zum schnellen Hinzufügen
wiederkehrender Artikel oder Aufgaben.

## Produktdatenbank

Die gemeinsame Produktdatenbank speichert optional EAN, Marke, Packungsmenge und
Bild. Unbekannte Barcodes lassen sich über Open Food Facts nachschlagen;
Produktdaten bleiben bearbeitbar. Das Löschen eines Einkaufsartikels löscht
weder sein Produkt noch verändert es den Inventarbestand.

![Produktverwaltung mit Suche und Produktinformationen](docs/images/de/backend-products.jpg)

### Ein Blick in die Artikelbearbeitung

![Vollständiger Bearbeitungsdialog mit Schnellbuttons, Anzahl, Kategorie und Labels](docs/images/de/edit-item.jpg)

## Gemeinsam nutzen und Daten sichern

- Änderungen erscheinen auch auf anderen geöffneten Geräten. Scans werden zentral
  verarbeitet, selbst ohne offenes Dashboard; offene Scans haben eine gemeinsame Warteschlange.
- Normale angemeldete Benutzer bedienen die Listenkarten. Die Verwaltung bleibt Admins vorbehalten.
- Pro Liste ein HA-Skript und auslösende Ereignisse für Benachrichtigungen oder Sprachausgaben auswählen.
- Sicherungen erstellen, herunterladen und wiederherstellen oder Listen aus der ursprünglichen Improved Shopping List Card übernehmen.

## Entity-Verlauf

Ausgewählte HA-Entitäten langfristig archivieren, alte Historien importieren und
Messwerte korrigieren oder ausblenden. Die separate **Entity-Verlaufskarte** zeigt
bis zu fünf Entitäten als Diagramm oder chronologische Liste — inklusive
Referenzlinien und einstellbarer Anzeigepräzision.

**Diagramm**

![Entity-Verlaufskarte mit mehreren Messreihen](docs/images/de/history.jpg)

**Chronologische Liste**

![Entity-Verlaufskarte als chronologische Liste mit Zeitpunkten und Messwerten](docs/images/de/history-list.jpg)

## Große Panelansichten

Im großen Panel bekommt der Listeninhalt mehr Platz. Dieselben Listen bleiben
auch in den kompakten Dashboard-Karten verfügbar.

### Einkaufsliste

**PC**

![Einkaufsliste in der großen PC-Panelansicht](docs/images/de/shopping-panel-desktop.jpg)

**Tablet**

![Einkaufsliste in der großen Tablet-Panelansicht](docs/images/de/shopping-panel-tablet.jpg)

### Inventar

**PC**

![Inventar in der großen PC-Panelansicht](docs/images/de/inventory-panel-desktop.jpg)

**Tablet**

![Inventar in der großen Tablet-Panelansicht](docs/images/de/inventory-panel-tablet.jpg)

### To-do-Liste

**PC**

![To-do-Liste in der großen PC-Panelansicht](docs/images/de/todo-panel-desktop.jpg)

**Tablet**

![To-do-Liste in der großen Tablet-Panelansicht](docs/images/de/todo-panel-tablet.jpg)

<!-- ha-marketplace:exclude-start -->
## Installation

Über **Marketplace** ab Home Assistant **2026.11**. Installation und Einrichtung
erfordern ein Administratorkonto.

[![HA List Manager in Marketplace öffnen](https://my.home-assistant.io/badges/marketplace_repository.svg)](https://my.home-assistant.io/redirect/marketplace_repository/?owner=Nisbo&repository=ha-list-manager&category=integration)

1. Den blauen Button anklicken oder unter **Einstellungen → Marketplace → Über Link hinzufügen**
   `https://github.com/Nisbo/ha-list-manager` eintragen.
2. Falls erforderlich GitHub verbinden, **Integration** wählen und HA List Manager installieren.
   Anschließend Home Assistant neu starten.
3. Unter **Einstellungen → Geräte & Dienste → Integration hinzufügen** nach **HA List Manager** suchen.
4. In der HA-Seitenleiste **HA List Manager → Listen → Liste anlegen** öffnen
   und den gewünschten Listentyp auswählen.
5. Das Dashboard bearbeiten, **Karte hinzufügen** wählen und nach **HA List Manager** suchen.
   **HA List Manager – Einkaufsliste**, **HA List Manager – Inventar** oder
   **HA List Manager – To-do-Liste** auswählen und in der Karte die angelegte Liste wählen.
   Für aufgezeichnete Entitätsverläufe gibt es zusätzlich **HA List Manager – Entity-Inventar**.

**Manuelle Installation (HA 2026.10+):** Installationsarchiv unter
[Releases](https://github.com/Nisbo/ha-list-manager/releases) herunterladen und
so entpacken, dass `custom_components/ha_list_manager/manifest.json` im
HA-Konfigurationsverzeichnis liegt. HA neu starten und mit Schritt 3 fortfahren.
<!-- ha-marketplace:exclude-end -->

## Anleitungen und Hilfe

[Schnellstart](https://github.com/Nisbo/ha-list-manager/wiki/Quick-Start-DE) ·
[Einkaufslisten](https://github.com/Nisbo/ha-list-manager/wiki/Shopping-Lists-DE) ·
[Inventar](https://github.com/Nisbo/ha-list-manager/wiki/Inventory-DE) ·
[To-do](https://github.com/Nisbo/ha-list-manager/wiki/To-do-Lists-DE) ·
[Alexa](https://github.com/Nisbo/ha-list-manager/wiki/Alexa-DE) ·
[Gerichte und Rezepte](https://github.com/Nisbo/ha-list-manager/wiki/Chips-Dishes-and-Recipes-DE) ·
[Scanner](https://github.com/Nisbo/ha-list-manager/wiki/Scanners-DE) ·
[Datensicherung](https://github.com/Nisbo/ha-list-manager/wiki/Backup-and-Restore-DE)

Fehler und Verbesserungsvorschläge bitte unter [GitHub Issues](https://github.com/Nisbo/ha-list-manager/issues) melden.

[MIT-Lizenz](LICENSE) · [Lizenz der mitgelieferten PDF-Bibliothek](custom_components/ha_list_manager/frontend/PDF-LIB-LICENSE.md)
