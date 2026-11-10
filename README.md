# HA List Manager

Shopping lists, household inventory and to-do lists inside Home Assistant —
with a shared product database, dashboard cards and an administration panel.
A separate history card adds long-term recording for selected HA entities.

> [!IMPORTANT]
> **Beta release: 1.0.0b11.** This is a pre-release for testing before the stable release.
> Back up your Home Assistant configuration and important data before testing.
> Please report problems with the installed version and steps to reproduce them.

**Release channel:** For technical reasons, the first beta **1.0.0b1** is
published from `main` as a regular GitHub release. The software remains a
**beta**. Further beta updates will be published as pre-releases from the
[`beta` branch](https://github.com/Nisbo/ha-list-manager/tree/beta) until the
final **1.0.0** release is ready.

**Documentation:** [English wiki](https://github.com/Nisbo/ha-list-manager/wiki) ·
[Deutsches Wiki](https://github.com/Nisbo/ha-list-manager/wiki/Home-DE)

The interface and complete wiki are available in **English and German**.
HA List Manager is a separate integration from the original
[Improved Shopping List Card](https://github.com/Nisbo/ha-shopping-list-improved).
It has its own version numbering and does not replace that card automatically.

## What it does

| Workflow | Features |
| --- | --- |
| **Shopping lists** | Products or free-text items, quantities, categories, labels, reusable quick entries, offer-only markers, notifications and PDF export. Optional Bring! connection through Home Assistant's official integration. |
| **Inventory** | Stock and minimum quantities, book items in or out, 60-second undo, interchangeable-product groups, and configurable automatic or manual replenishment to a shopping list. |
| **To-do lists** | Tasks, due dates, repeat intervals, categories, labels, filters and reusable task templates. Tasks never require product records or barcodes. |
| **Entity history** | An independent long-term archive for selected HA entities, with history imports, corrections and hidden values. Its own card displays charts or a chronological list, with up to five entities. |

![Complete inventory, shopping and to-do cards with neutral English example data](https://raw.githubusercontent.com/wiki/Nisbo/ha-list-manager/images/en/home-cards.png)

All three list cards can optionally switch between category and label sections.
An item assigned to several labels appears in each section while sharing the
same quantity, completion state and edits. The feature is disabled by default.
See the [worked example](https://github.com/Nisbo/ha-list-manager/wiki/Categories-and-Labels-Example)
for setup and matching English/German screenshots.

When typing filters a list, matching category and label sections temporarily
open automatically. Clearing the search restores their previous open/closed
state. **Automatically open groups while searching** is enabled by default and
can be disabled in each card editor. Header text and icons automatically adapt
to light or dark category and label colors.

Category and label search fields in the cards and administration panel offer
both a drop-down list and a searchable chip popup. Choose one category or select
several labels, then save the surrounding form. Status and error banners can be
closed with their right-hand **X**; dismissing a message does not undo its action.

Optional edit shortcut bars open category, labels and the supported item actions directly.
Changed forms show **Not saved yet** and ask before discarding edits. Product
editing uses shared fields across cards and administration, with a return path
to the pending inventory entry.

Saved shopping and inventory items have an **Item actions** menu to create a
list-specific chip or add a chosen quantity to another local shopping list,
without moving the source item or changing stock. Administrators can also
create exact-name category rules for the current list.

Category and Labels in item editors can be collapsed separately, with their
state remembered in the browser. Quick selection remains available while closed.
Local shopping lists also offer an **Offer filter** whose selection is remembered
per user and list.

For linked local shopping items, optional checkboxes can save the selected
category as the product default for this list and save labels on the product.
Both are off by default and apply only when the item is saved. Product label
changes show additions/removals and their scopes: global or list-type assignments
can affect future additions in other lists. Existing entries stay unchanged.
See [product defaults](https://github.com/Nisbo/ha-list-manager/wiki/Shopping-Lists#keep-category-and-labels-as-product-defaults).

The shared backend also provides:

- **Product management:** Optional EAN, brand, package quantity and image, with
  local lookup and Open Food Facts lookup for unknown barcodes.
- **Categories, labels and chips:** Global, list-type or list-specific definitions,
  with icons, colors and dynamic categories.
- **Central scanner processing:** Scanner targets, modes and pending scans work
  in the backend without requiring a dashboard card to be open. Pending scans
  can be reviewed on multiple devices, with one editor per scan and synchronized
  completion or confirmed discard.
- **List-specific scripts and notifications:** Select the events that invoke an
  HA script or send a notification. Scripts can use the supplied message for
  feedback or speech output.
- **Alexa connection:** Connect an existing Alexa Devices list to one local
  shopping list. Recommended One Way imports entries and deletes the imported
  source entries. Optional experimental linked mode synchronizes linked items'
  completion and deletion, with optional quantity consolidation. Number/unit
  recognition and exact product matching are configurable; the Test tab
  previews recognition without changing lists or contacting Amazon.
- **Data backup:** A persistent archive with download, upload, confirmed restore
  and delete controls, plus automatic safety copies before restore or import.
- **Import from the original card:** Previewed transfer of shopping, to-do or
  inventory data, with an optional transfer of the old EAN database into the
  shared product catalog and explanations for omitted settings.

Archived measurements can optionally use the entity's Home Assistant display
precision. Raw values stay unchanged, and an explicit history-card decimal
setting takes precedence.

Products, shopping entries and inventory stock are separate records. Removing a
shopping entry does not delete its product. Marking a purchase complete does not
automatically book it into inventory.

## Requirements

- **Home Assistant 2026.10.0 or newer.** Beta 11 was tested with 2026.11.0.
- **HACS** for the installation method below, or use manual installation.
- An **administrator account** for installation and backend configuration.

Normal signed-in Home Assistant users can operate all three list cards.
The administration panel, shared configuration and backup management are
restricted to administrators. See the [permissions guide](https://github.com/Nisbo/ha-list-manager/wiki/Backend-Settings#permissions).

## Install with HACS

[![Open HA List Manager in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Nisbo&repository=ha-list-manager&category=integration)

1. Make sure [HACS is installed](https://www.hacs.dev/docs/use/) in your HA instance.
2. Click the blue button above, select your Home Assistant instance and open
   **HA List Manager** in HACS. Confirm adding the repository if requested.
3. Open the HACS download dialog, choose a different version and select
   **1.0.0b11**. Download it and **restart Home Assistant**.
4. Open **Settings → Devices & services → Add integration**, search for
   **HA List Manager**, and complete setup.
5. Open **HA List Manager** in the sidebar to create your lists, then add their
   cards to a dashboard.

If you prefer adding it manually in HACS, open **HACS → ⋮ → Custom repositories**
and enter:

| Field | Value |
| --- | --- |
| Repository | `https://github.com/Nisbo/ha-list-manager` |
| Type / category | **Integration** |

Then follow steps 3–5 above. This is an integration that includes its dashboard
cards; do not add it as a Dashboard/Frontend-only repository.

### Manual installation

1. Download the installation archive
   [`ha-list-manager-1.0.0b11.zip`](https://github.com/Nisbo/ha-list-manager/releases/download/1.0.0b11/ha-list-manager-1.0.0b11.zip).
2. Extract it into your HA configuration directory so the result is
   `<config>/custom_components/ha_list_manager/manifest.json`.
3. Restart Home Assistant and add **HA List Manager** under
   **Settings → Devices & services → Add integration**.

Only the `custom_components/ha_list_manager` directory belongs in the HA
installation. The repository also contains this README, HACS metadata and
license information.

## First steps

1. In the administration panel, create a **shopping**, **inventory** or **to-do**
   list. For Bring!, configure Home Assistant's official Bring! integration first,
   then select its to-do entity when creating the linked list.
2. Add an **HA List Manager** card from the dashboard card picker and select the
   backend list in the graphical editor. Card resources are registered
   automatically; no separate card download is needed.
3. Add shopping items or tasks directly. To use inventory, select an existing
   product or create one, then set its starting stock.
4. Optionally configure categories, labels, scanners, scripts and replenishment.

The [Quick Start](https://github.com/Nisbo/ha-list-manager/wiki/Quick-Start) /
[Schnellstart](https://github.com/Nisbo/ha-list-manager/wiki/Quick-Start-DE) walks
through this with complete screenshots and neutral examples.

### Already using the original card?

Use **HA List Manager → Backup → Import old card**. Supply the old card YAML and
choose a source to-do list, or choose **Without list entries** to copy categories
and configured chips. An inventory EAN database can be selected separately,
including when no list entries are copied. Check the preview and import notes
before applying.

The importer creates **new lists** and leaves the sources unchanged. Inventory
can optionally import its old EAN to-do database into the **shared product
catalog**, including products without stock. Existing EAN products are reused
without overwriting their data, and ambiguous inventory assignments require an
explicit choice in the preview. These products are also available to shopping
lists. Imported category defaults apply only to the new inventory list.

Without EAN import, inventory creates generic products and combines matching
names in the same category. Browser chips, local EAN files, transfer queues,
inventory groups, minimum stocks and replenishment settings are not imported.

See [Data import](https://github.com/Nisbo/ha-list-manager/wiki/Data-Import) /
[Datenübernahme](https://github.com/Nisbo/ha-list-manager/wiki/Data-Import-DE) for
the supported data and examples.

## Documentation

| Topic | English | Deutsch |
| --- | --- | --- |
| Start and concepts | [Quick Start](https://github.com/Nisbo/ha-list-manager/wiki/Quick-Start) · [Concepts](https://github.com/Nisbo/ha-list-manager/wiki/Concepts) | [Schnellstart](https://github.com/Nisbo/ha-list-manager/wiki/Quick-Start-DE) · [Grundlagen](https://github.com/Nisbo/ha-list-manager/wiki/Concepts-DE) |
| Shopping and tasks | [Shopping lists](https://github.com/Nisbo/ha-list-manager/wiki/Shopping-Lists) · [To-do](https://github.com/Nisbo/ha-list-manager/wiki/To-do-Lists) | [Einkaufslisten](https://github.com/Nisbo/ha-list-manager/wiki/Shopping-Lists-DE) · [Aufgaben](https://github.com/Nisbo/ha-list-manager/wiki/To-do-Lists-DE) |
| Alexa shopping input | [Alexa](https://github.com/Nisbo/ha-list-manager/wiki/Alexa) | [Alexa](https://github.com/Nisbo/ha-list-manager/wiki/Alexa-DE) |
| Stock, groups and replenishment | [Inventory](https://github.com/Nisbo/ha-list-manager/wiki/Inventory) | [Inventar](https://github.com/Nisbo/ha-list-manager/wiki/Inventory-DE) |
| Scanners, scripts and notifications | [Scanners](https://github.com/Nisbo/ha-list-manager/wiki/Scanners) · [Scripts](https://github.com/Nisbo/ha-list-manager/wiki/Script-Connection) · [Notifications](https://github.com/Nisbo/ha-list-manager/wiki/Notifications) | [Scanner](https://github.com/Nisbo/ha-list-manager/wiki/Scanners-DE) · [Skripte](https://github.com/Nisbo/ha-list-manager/wiki/Script-Connection-DE) · [Benachrichtigungen](https://github.com/Nisbo/ha-list-manager/wiki/Notifications-DE) |
| Entity archive and history card | [Archive](https://github.com/Nisbo/ha-list-manager/wiki/Entity-History) · [Card](https://github.com/Nisbo/ha-list-manager/wiki/Entity-History-Card) | [Archiv](https://github.com/Nisbo/ha-list-manager/wiki/Entity-History-DE) · [Karte](https://github.com/Nisbo/ha-list-manager/wiki/Entity-History-Card-DE) |
| Backup and import | [Backups](https://github.com/Nisbo/ha-list-manager/wiki/Backup-and-Restore) · [Import](https://github.com/Nisbo/ha-list-manager/wiki/Data-Import) | [Datensicherung](https://github.com/Nisbo/ha-list-manager/wiki/Backup-and-Restore-DE) · [Übernahme](https://github.com/Nisbo/ha-list-manager/wiki/Data-Import-DE) |

## Data and updates

The integration stores its database at `<config>/ha_list_manager.db` and its
backup archive at `<config>/ha_list_manager_backups/`. These files survive normal
HA restarts and are not automatically deleted when the integration is removed.
Use the backup panel and keep a copy outside the HA machine. This release uses
database schema **3**. Existing schema-1 and schema-2 databases upgrade
automatically while preserving their data. Valid backups of both older schemas
can still be restored; see
[Backup and Restore](https://github.com/Nisbo/ha-list-manager/wiki/Backup-and-Restore)
for the effects of restoring older Alexa processing records.

Install later beta updates through HACS, restart HA and refresh open dashboards.
See the [release notes](https://github.com/Nisbo/ha-list-manager/releases)
for changes.

## Feedback

Report reproducible problems in [GitHub Issues](https://github.com/Nisbo/ha-list-manager/issues).
Include your HA version, HA List Manager version, affected workflow and steps to
reproduce the problem. Use screenshots or relevant logs where useful; remove
credentials and private data before posting.

Licensed under the [MIT License](LICENSE). The bundled PDF library has its own
[license notice](custom_components/ha_list_manager/frontend/PDF-LIB-LICENSE.md).
