# Development and implementation notes

For installation, features and the beta notice, see the [README](../README.md).
The [English wiki](https://github.com/Nisbo/ha-list-manager/wiki) and
[German wiki](https://github.com/Nisbo/ha-list-manager/wiki/Home-DE) contain the
user-facing workflows, screenshots and examples.

These notes describe the current implementation and local regression checks.
Only `custom_components/ha_list_manager` is installed into Home Assistant.
Tests, tools and optional script examples remain repository development files.

## Current API boundary

Cards and the panel use authenticated Home Assistant WebSocket commands under
`ha_list_manager/`, including `items/create`, `items/update`,
`inventory/adjust` and `inventory/undo`. Authenticated Home Assistant users can
operate the shopping, inventory and To-do cards, including their live updates.
The administration panel, list/scanner configuration, script assignments,
shared category/label definitions and backups require administrator access.
Card selections expose only the effective choices for a list; notification
destination addresses remain private. This is not an anonymous HTTP API.
`inventory/undo` accepts a server-issued `token` and an optional
`include_transfer` boolean. It returns the restored entry (or null when removing
a new inventory assignment) and the affected list IDs. Backend events refresh
other open clients.

A Home Assistant action/service layer for YAML automations remains deferred.
Per-list script callbacks already execute centrally in the backend rather than
independently in each open card.

## UI languages and text catalogs

English and German texts live in the native Home Assistant integration files
`custom_components/ha_list_manager/translations/en.json` and `de.json`.
The `config_panel` section contains the four cards, their HA form editors,
shared PDF export and administration panel. Python messages use `common`;
errors also provide native `exceptions` translation metadata. Configuration
flows keep the standard `config` section. Custom integrations ship complete
translation files directly; no catalog generator or translation build is needed.

Frontend components load the integration's `config_panel` category with
`hass.loadBackendTranslation` and render through `hass.localize`. Home Assistant
handles resource loading, caching and English fallback. Cards and editors load
texts again when the HA user language changes, preserving their normal update,
focus and scroll behavior. Python uses `homeassistant.helpers.translation`;
request-facing text follows the supplied user language, while automatic
notifications and script `message` values follow the HA system language.

Use short semantic English keys, such as `ui.max_value`, `help.max_value` or
`inventory.undo_expired`, nested inside `config_panel`, and named placeholders
(`{count}`, `{name}`, ...). Keep placeholders identical between languages.
Existing `{p0}` placeholders are supported. Pass dynamic values separately;
never create keys from user-entered names, categories or labels. Those values
remain user data. HTML markup, whitespace joining, CSS, API identifiers and
saved configuration values stay in the implementation. Preserve escaping of
dynamic HTML values at the call site. Stored event IDs and modes are unchanged.

After editing translation files, restart Home Assistant to clear its backend
translation cache and refresh the frontend. Tests verify both languages,
placeholder parity, native loading, language changes and existing workflows.

## Per-list script hooks

The administration dialog contains only the script and event settings with a
short hint. Detailed setup instructions, the variable reference, and notification
and speech examples are in the
[script guide](https://github.com/Nisbo/ha-list-manager/wiki/Script-Connection) /
[Skript-Anbindung](https://github.com/Nisbo/ha-list-manager/wiki/Script-Connection-DE).
The notification test script is an optional example, not automatically installed
by the integration.
For a visible test, merge `examples/list-script-notification.yaml` into HA's
`scripts.yaml` and reload scripts. Select **HA-LM – Ereignisse testen** in a list's
script settings, enable the desired events and save. Each selected list action
replaces one persistent HA notification with its message, local timestamp and
received event data. It does not change list entries or stock. Running the
script directly without variables shows a notification-only check instead.


Under **Lists → Script connection** (script icon next to each list) or directly
in **Inventory → Script connection**, administrators can select one HA script
and the events that should invoke it. Disabling the connection retains the
selected script and events. Shopping/Bring and Todo lists expose item events;
inventory lists expose bookings, scanner outcomes and restocking. General Todo
operations never create products. Script configuration is administrator-only.

Dispatch runs in the backend without an open dashboard. An inventory scan's
successful booking is dispatched once through its committed database write;
the scanner's success history does not produce a second invocation. Waiting
scan offers/queue updates share a deduplication key. A simultaneous rename and
quantity change produces one primary event with all `changed_fields`. Dish batches
produce one event per changed ingredient. Completion, reopening and date-only
changes in recurring Todo entries remain distinct; date-only changes are
`item_updated` with `due_at` in `changed_fields`. A newly assigned inventory
product uses `inventory_registered` (including initial stock), while changes
to an existing stock use the corresponding booking event. A restock
is a separate source-inventory event and one destination-list mutation. Choose
HA script mode **queued** for multiple fast scans. Failed/missing scripts are
logged without rolling back the successful booking. There are no automatic
retries, durable delivery guarantees or script execution on initial configuration.
Recursive invocations of the same list within a script execution chain are skipped.

Stable `event` values:

- Items: `item_added`, `item_removed`, `item_quantity_changed`, `item_renamed`,
  `item_completed`, `item_reopened`, `item_updated`.
- Inventory: `inventory_in`, `inventory_out`, `inventory_corrected`,
  `inventory_registered`, `inventory_removed`, `inventory_undo_completed`.
- Scanner: `scanner_mode_changed`, `scanner_disabled`, `scan_needs_input`, `scan_error`.
- Restock: `restock_manual`, `restock_automatic`, `restock_lock_reset` (explicit reset).

Scripts receive `event`, `event_id`, `timestamp`, `message`, `source`, `list_id`,
`list_name`, `target_list_id`, `target_list_name`, and `changed_fields` in addition
to the legacy variable names `status`, `name`, `category`, `quantity`,
`previous_quantity`, `previous_name`, `list_entity`, `mode`, `ean`, `is_ean`,
`offer_only`, `brand`, `product_quantity`, `image_url`, `scan_quantity`,
`scanner_address`, `scanner_source`, `scan_mode`, `card_id`, `stock_before`,
`stock_after`, `original_action`, `transfer_result`, `action`, and `error`.
Not-applicable values remain empty. `card_id` is empty because dispatch no longer
belongs to a particular card. `list_entity` is the associated HA entity when
available (the original external Todo entity for Bring). `mode` remains the
semantic list type (`shopping`, `todo`, `inventory`). `quantity` means the current
item quantity for item events, actual changed stock for bookings, and transferred
quantity for restocking. `scan_quantity` preserves the requested scan quantity.

Where equivalent, scanner `status` retains `product_added`,
`product_quantity_increased`, `product_quantity_decreased`, `inventory_corrected`,
`inventory_undo_completed`, `product_not_found`, `product_review_required`, `error`,
and `transfer_sent`. Scanner mode is `add`, `remove`, `register` or `correct`.
Raw input/product lookup stages from the old browser card do not trigger additional
success calls. Use `event` for new scripts; existing scripts may need to update
their status selection. `message` is ready-to-use speech text in the HA system
language, for example `1× Milch aus Vorrat entnommen.` in German or the equivalent
English message. User product/list/category names remain user data.

An inert example (it fires only a local HA event):

```yaml
alias: HA-LM example
mode: queued
max: 50
sequence:
  - event: ha_list_manager_script_example
    event_data:
      action: "{{ event }}"
      list_name: "{{ list_name }}"
      message: "{{ message }}"
```

Administrator WebSocket commands are `lists/script/get` (`list_id`) and
`lists/script/set` (`list_id`, `enabled`, `script_entity`, `events`), each prefixed
with `ha_list_manager/`. Settings are stored separately for each list and are
removed when that list is deleted. New script connections start disabled.

## Database backup and restore

The active SQLite database lives at `/config/ha_list_manager.db`
(or the HA configuration directory on other installations). Removing the
integration does not delete it. HA backups containing the configuration include
it; the integration's backup hooks checkpoint WAL and pause writes during backup.

The dedicated **Backup** page lists standalone SQLite files stored in
`/config/ha_list_manager_backups/`. The archive is outside the active
SQLite database: restoring that database cannot roll the archive back. Files and
metadata survive page reloads, integration reloads and HA restarts. There is no
expiry timer and no automatic deletion. Each file can be downloaded, restored
(with explicit replacement confirmation) or deleted (with confirmation).

Creating a backup records the current database. Uploading validates a raw
`.db`, `.sqlite` or `.sqlite3` file up to 512 MiB before saving it in the archive;
invalid uploads do not enter the archive. The UI shows filename, date, size and
origin: created, uploaded, safety copy before restore, or automatic backup before
data import. Uploading does not restore anything. All four kinds remain available
until explicitly deleted.

The initial supported database schema is **1**. Unsupported versions are rejected
rather than silently relabeled or converted. Before every restore the selected
file is copied and validated again; the original archive file is retained.
Restore drains and retires the old DB wrapper, unloads the integration,
creates an additional safety copy in the archive, replaces the live contents via
SQLite's backup API, and sets the integration up again. Setup failure rolls back
to that new safety copy; snapshot failure never rolls back to an older copy.
Restores do not fire list/booking script callbacks. All archive operations share a
lock, so a download or deletion cannot remove a file during an active restore.

Archive access uses authenticated administrator-only HTTP endpoints. IDs are
validated, symlinks rejected, and files/metadata written atomically with private
permissions. Download uses a disposable copy; it never consumes the archived file.
Only incomplete upload/restore/download work uses temporary files. Keep another
copy on a separate device; database files may contain configured credentials.

## Development checks

Use Python 3.14 and Node.js 24 in a standalone checkout. The isolated Python
tests use Home Assistant doubles; they do not replace a real installation test.

```sh
python -m pip install -r requirements-test.txt
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q -p no:cacheprovider tests
node tools/test-frontend.cjs
```

The frontend runner checks JavaScript syntax and executes all regression
harnesses in `tests/*_smoke.js`, including native English/German translations,
card interactions, scroll behavior and the import wizard. The validation workflow
runs these checks alongside HACS validation and Hassfest.
