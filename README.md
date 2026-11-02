# HA List Manager

Shopping lists, household inventory and to-do lists inside Home Assistant —
with a shared product database, dashboard cards and an administration panel.
A separate history card adds long-term recording for selected HA entities.

> [!IMPORTANT]
> **Beta release: 1.0.0b1.** This is the first public beta, not a stable release.
> Back up your Home Assistant configuration and important data before testing.
> Please report problems with the installed version and steps to reproduce them.

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

The shared backend also provides:

- **Product management:** Optional EAN, brand, package quantity and image, with
  local lookup and Open Food Facts lookup for unknown barcodes.
- **Categories, labels and chips:** Global, list-type or list-specific definitions,
  with icons, colors and dynamic categories.
- **Central scanner processing:** Scanner targets, modes and pending scans work
  in the backend without requiring a dashboard card to be open.
- **List-specific scripts and notifications:** Select the events that invoke an
  HA script or send a notification. Scripts can use the supplied message for
  feedback or speech output.
- **Data backup:** A persistent archive with download, upload, confirmed restore
  and delete controls, plus automatic safety copies before restore or import.
- **Import from the original card:** Previewed transfer of shopping, to-do or
  simplified inventory data, with explanations for omitted settings.

Products, shopping entries and inventory stock are separate records. Removing a
shopping entry does not delete its product. Marking a purchase complete does not
automatically book it into inventory.

## Requirements

- **Home Assistant 2026.10.0 or newer.** The first beta was tested with 2026.10.4.
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
3. **Enable pre-release versions for this repository.** This release is a beta;
   allow pre-releases using its [HACS pre-release switch](https://www.hacs.dev/docs/use/entities/switch/).
4. Download **1.0.0b1** and **restart Home Assistant**.
5. Open **Settings → Devices & services → Add integration**, search for
   **HA List Manager**, and complete setup.
6. Open **HA List Manager** in the sidebar to create your lists, then add their
   cards to a dashboard.

If you prefer adding it manually in HACS, open **HACS → ⋮ → Custom repositories**
and enter:

| Field | Value |
| --- | --- |
| Repository | `https://github.com/Nisbo/ha-list-manager` |
| Type / category | **Integration** |

Then follow steps 3–6 above. This is an integration that includes its dashboard
cards; do not add it as a Dashboard/Frontend-only repository.

### Manual installation

1. Download the `ha-list-manager-1.0.0b1.zip` asset from the
   [beta release](https://github.com/Nisbo/ha-list-manager/releases/tag/1.0.0b1).
2. Extract it into your HA configuration directory so the result is
   `<config>/custom_components/ha_list_manager/manifest.json`.
3. Restart Home Assistant and add **HA List Manager** under
   **Settings → Devices & services → Add integration**.

Only the `custom_components/ha_list_manager` directory belongs in the HA
installation. Do not copy the whole repository, its tests or development tools.

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
choose a source to-do list, or choose **Without entries** to copy only categories
and configured chips. Check the preview and import notes before applying.

The importer creates **new lists** and leaves the sources unchanged. Simplified
inventory import creates new generic products without EANs and combines matching
names in the same category. It does not transfer EAN databases, browser chips,
transfer queues, inventory groups or replenishment settings.

See [Data import](https://github.com/Nisbo/ha-list-manager/wiki/Data-Import) /
[Datenübernahme](https://github.com/Nisbo/ha-list-manager/wiki/Data-Import-DE) for
the supported data and examples.

## Documentation

| Topic | English | Deutsch |
| --- | --- | --- |
| Start and concepts | [Quick Start](https://github.com/Nisbo/ha-list-manager/wiki/Quick-Start) · [Concepts](https://github.com/Nisbo/ha-list-manager/wiki/Concepts) | [Schnellstart](https://github.com/Nisbo/ha-list-manager/wiki/Quick-Start-DE) · [Grundlagen](https://github.com/Nisbo/ha-list-manager/wiki/Concepts-DE) |
| Shopping and tasks | [Shopping lists](https://github.com/Nisbo/ha-list-manager/wiki/Shopping-Lists) · [To-do](https://github.com/Nisbo/ha-list-manager/wiki/To-do-Lists) | [Einkaufslisten](https://github.com/Nisbo/ha-list-manager/wiki/Shopping-Lists-DE) · [Aufgaben](https://github.com/Nisbo/ha-list-manager/wiki/To-do-Lists-DE) |
| Stock, groups and replenishment | [Inventory](https://github.com/Nisbo/ha-list-manager/wiki/Inventory) | [Inventar](https://github.com/Nisbo/ha-list-manager/wiki/Inventory-DE) |
| Scanners, scripts and notifications | [Scanners](https://github.com/Nisbo/ha-list-manager/wiki/Scanners) · [Scripts](https://github.com/Nisbo/ha-list-manager/wiki/Script-Connection) · [Notifications](https://github.com/Nisbo/ha-list-manager/wiki/Notifications) | [Scanner](https://github.com/Nisbo/ha-list-manager/wiki/Scanners-DE) · [Skripte](https://github.com/Nisbo/ha-list-manager/wiki/Script-Connection-DE) · [Benachrichtigungen](https://github.com/Nisbo/ha-list-manager/wiki/Notifications-DE) |
| Entity archive and history card | [Archive](https://github.com/Nisbo/ha-list-manager/wiki/Entity-History) · [Card](https://github.com/Nisbo/ha-list-manager/wiki/Entity-History-Card) | [Archiv](https://github.com/Nisbo/ha-list-manager/wiki/Entity-History-DE) · [Karte](https://github.com/Nisbo/ha-list-manager/wiki/Entity-History-Card-DE) |
| Backup and import | [Backups](https://github.com/Nisbo/ha-list-manager/wiki/Backup-and-Restore) · [Import](https://github.com/Nisbo/ha-list-manager/wiki/Data-Import) | [Datensicherung](https://github.com/Nisbo/ha-list-manager/wiki/Backup-and-Restore-DE) · [Übernahme](https://github.com/Nisbo/ha-list-manager/wiki/Data-Import-DE) |

## Data and updates

The integration stores its database at `<config>/ha_list_manager.db` and its
backup archive at `<config>/ha_list_manager_backups/`. These files survive normal
HA restarts and are not automatically deleted when the integration is removed.
Use the backup panel and keep a copy outside the HA machine. The initial database
schema for this release is **1**.

Install later beta updates through HACS, restart HA and refresh open dashboards.
See the [release notes](https://github.com/Nisbo/ha-list-manager/releases) and
[roadmap](ROADMAP.md) for changes and deliberately deferred features.

## Feedback and development

Report reproducible problems in [GitHub Issues](https://github.com/Nisbo/ha-list-manager/issues).
Include your HA version, HA List Manager version, affected workflow and steps to
reproduce the problem. Use screenshots or relevant logs where useful; remove
credentials and private data before posting.

For the implementation notes and test commands, see [Development](docs/Development.md).
Licensed under the [MIT License](LICENSE). The bundled PDF library has its own
[license notice](custom_components/ha_list_manager/frontend/PDF-LIB-LICENSE.md).
