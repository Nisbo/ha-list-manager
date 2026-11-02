# HA List Manager 1.0.0b1

First public beta — published as a GitHub pre-release from the `beta` branch.

HA List Manager brings shopping lists, household inventory and To-do lists into
one Home Assistant custom integration, with separate dashboard cards and an
administrator-only management panel.

- Shared product database, categories, labels, quick entries and task templates.
- Inventory bookings, groups, 60-second undo and configurable replenishment.
- Central barcode scanner processing, pending scans and list-specific scripts.
- Notifications, sharing and PDF export.
- Long-term entity archive with its own configurable history card.
- Persistent backup archive and confirmed database restoration.
- Previewed import from the original card, including simplified inventory.
- Native English/German interface and an independent bilingual wiki.

The initial database schema is **1**. This is a separate integration and version
series from the original frontend-only card. Existing installations of that card
are not replaced automatically; use the import wizard after installing HA List
Manager and review its notes.

Only `custom_components/ha_list_manager` is installed into Home Assistant.
Minimum declared Home Assistant version: **2026.10.0**. As a beta, this version is
intended for testing before a stable release. Keep an independent backup of
important data before testing.

Install with HACS as a custom **Integration** repository and enable pre-release
versions to select **1.0.0b1**. Restart Home Assistant, then add **HA List Manager**
under **Settings → Devices & services → Add integration**. Dashboard cards are
included and their resources are registered automatically. The
[README](https://github.com/Nisbo/ha-list-manager/tree/beta#install-with-hacs)
contains the blue installation button and the full setup instructions.

The release includes a standalone installation ZIP. Extract it into the HA
configuration directory, keeping `custom_components/ha_list_manager` intact.

Validation: 540 isolated Python tests, 26 frontend regression harnesses and a
clean installation on Home Assistant 2026.10.4, including backup/restore.

Documentation: [English](https://github.com/Nisbo/ha-list-manager/wiki) ·
[Deutsch](https://github.com/Nisbo/ha-list-manager/wiki/Home-DE).
