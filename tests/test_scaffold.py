"""Structural smoke tests for the initial integration scaffold."""

import json
from pathlib import Path
import re
import runpy


import runpy as _localization_runpy
_localized_source = _localization_runpy.run_path(str(Path(__file__).with_name('localization_source.py')))['localized_source']

ROOT = Path(__file__).parents[1]
INTEGRATION = ROOT / "custom_components" / "ha_list_manager"


def _card_method(source: str, name: str) -> str:
    """Read a multiline method definition rather than an earlier call site."""
    match = re.search(
        rf"^  (?:async )?{re.escape(name)}\([^\n]*\) \{{\n.*?^  \}}",
        source,
        re.MULTILINE | re.DOTALL,
    )
    assert match is not None, f"Card method {name} was not found"
    return match.group()


def test_manifest_matches_integration_directory() -> None:
    manifest = json.loads(_localized_source(INTEGRATION / "manifest.json"))

    assert manifest["domain"] == INTEGRATION.name
    assert manifest["config_flow"] is True
    assert manifest["single_config_entry"] is True
    assert "panel_custom" in manifest["dependencies"]
    assert "lovelace" in manifest["dependencies"]
    assert "websocket_api" in manifest["dependencies"]


def test_translations_are_valid_json() -> None:
    for path in [INTEGRATION / "strings.json", *sorted((INTEGRATION / "translations").glob("*.json"))]:
        assert json.loads(_localized_source(path))["title"] == "HA List Manager"


def test_panel_contains_planned_navigation() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    for label in ["Übersicht", "Listen", "Produkte", "Kategorien", "Labels", "Chips & Vorlagen", "Gerichte", "Inventar", "Scanner", "Einstellungen", "Statistiken"]:
        assert label in panel
    assert 'customElements.define("ha-list-manager-panel"' in panel


def test_optional_initial_category_rules_do_not_send_blank_entries() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    websocket = _localized_source(INTEGRATION / "websocket.py")

    assert '.split(/\\r?\\n/).map((rule) => rule.trim()).filter(Boolean)' in panel
    assert 'if isinstance(pattern, str) and pattern.strip()' in websocket


def test_specific_category_product_manager_is_wired_end_to_end() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "async_set_product_list_category" in database
    assert "async_list_recent_products" in database
    assert "_list_products_for_category" in database
    assert 'f"{DOMAIN}/categories/products/list"' in websocket
    assert 'f"{DOMAIN}/products/category/set"' in websocket
    assert "data-manage-category-detail" in panel
    assert "_renderCategoryProductsPage" in panel
    assert "data-back-categories" in panel
    assert "data-open-category-product-search" in panel
    assert "data-remove-category-product-page" in panel
    assert "data-category-product-search" in panel
    assert "data-category-product-show-assigned" in panel
    assert "return dialog.show_assigned || !assignment;" in panel
    assert "data-confirm-category-product-move" in panel
    assert "Bereits hier" in panel
    assert "Bereits in" in panel
    assert 'f"{DOMAIN}/categories/rules/list"' in websocket
    assert 'f"{DOMAIN}/categories/rules/set"' in websocket
    assert 'f"{DOMAIN}/categories/rules/resolve"' in websocket
    assert "data-category-rule-input" in panel
    assert "data-category-rules-bulk" in panel
    assert 'data-category-detail-tab="rules"' in panel
    assert 'data-category-detail-tab="products"' in panel
    shopping_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")
    assert "_matchingAutomaticCategory" in shopping_card


def test_user_favorites_are_persistent_and_navigable() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "async_list_user_favorites" in database
    assert "async_set_user_favorite" in database
    assert 'f"{DOMAIN}/favorites/list"' in websocket
    assert 'f"{DOMAIN}/favorites/set"' in websocket
    assert "connection.user.id" in websocket
    assert "data-toggle-page-favorite" in panel
    assert "data-open-favorite" in panel
    assert "data-remove-favorite" in panel
    assert "Schnellzugriff" in panel


def test_backend_versions_match() -> None:
    manifest = json.loads(_localized_source(INTEGRATION / "manifest.json"))
    constants = _localized_source(INTEGRATION / "const.py")
    panel_module = _localized_source(INTEGRATION / "panel.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    inventory_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-inventory-card.js")
    shopping_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")
    todo_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")
    history_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-history-card.js")

    assert f'VERSION: Final = "{manifest["version"]}"' in constants
    assert "v={VERSION}" in panel_module
    assert f'PANEL_VERSION = "{manifest["version"]}"' in panel
    assert f'CARD_VERSION = "{manifest["version"]}"' in inventory_card
    assert f'CARD_VERSION = "{manifest["version"]}"' in shopping_card
    assert f'CARD_VERSION = "{manifest["version"]}"' in todo_card
    assert f'CARD_VERSION = "{manifest["version"]}"' in history_card


def test_overview_uses_backend_aggregate_statistics() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "async_overview_statistics" in database
    assert '"products_assigned"' in database
    assert '"items_bring"' in database
    assert '"inventory_entries"' in database
    assert '"statistics": statistics' in websocket
    assert '"Zugeordnete Produkte"' in panel
    assert '"Einträge nach Listenart"' in panel


def test_bring_sync_diagnostics_are_persistent_and_visible() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "CREATE TABLE external_list_sync_status" in database
    assert "FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE" in database
    assert "async_mark_external_sync_success" in database
    assert 'f"{DOMAIN}/lists/sync"' in websocket
    assert 'data-sync-bring' in panel
    assert 'Letzter erfolgreicher Abgleich' in panel


def test_inventory_category_inputs_preserve_spaces() -> None:
    inventory_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-inventory-card.js")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert 'draft.category_name = match?.name || raw;' in inventory_card
    assert 'picker.value = match?.name || raw;' in inventory_card
    assert 'data-inventory-category-options' in panel
    assert 'draft.category_name = match?.name || raw;' in panel
    assert '${this._renderLabelSelector(draft.label_ids || [])}' in panel


def test_backend_shopping_card_is_registered_and_product_aware() -> None:
    panel_module = _localized_source(INTEGRATION / "panel.py")
    shopping_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")
    websocket = _localized_source(INTEGRATION / "websocket.py")

    assert "SHOPPING_CARD_MODULE_URL" in panel_module
    assert '_async_register_frontend_cards' in panel_module
    assert 'customElements.define("ha-list-manager-shopping-card"' in shopping_card
    assert 'ha_list_manager_items_changed' in shopping_card
    assert 'type: `${HA_LM_API}/products/list`' in shopping_card
    assert 'product_id: product?.id || draft.item?.product_id || null' in shopping_card
    assert 'probatio.Optional("product_id")' in websocket


def test_central_dishes_are_wired_end_to_end() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    shopping_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")

    assert "CREATE TABLE dishes" in database
    assert "CREATE TABLE dish_items" in database
    assert "async_add_dish_to_list" in database
    assert 'f"{DOMAIN}/dishes/list"' in websocket
    assert 'f"{DOMAIN}/dishes/create"' in websocket
    assert 'f"{DOMAIN}/dishes/update"' in websocket
    assert 'f"{DOMAIN}/dishes/delete"' in websocket
    assert 'f"{DOMAIN}/dishes/add_to_list"' in websocket
    assert '["dishes", "Gerichte", "mdi:food-variant"]' in panel
    assert "data-list-use-dishes" in panel
    assert 'quick_items: ""' in panel
    assert "this._importDishItems(false);" in panel
    assert "draft.quick_items = event.target.value" in panel
    assert "dish-ingredient-header" in panel
    assert "dish-ingredient-actions" in panel
    assert "data-add-dish-product" in panel
    assert "data-add-free-dish-item" in panel
    assert "data-dish-product-search" in panel
    assert "data-select-dish-product" in panel
    assert "Produkt, Marke oder EAN suchen" in panel
    assert "data-dish-item-product" not in panel
    assert 'dishes: ["Gerichte", "mdi:food-variant"]' in panel
    assert "dish-ingredient-product-info" in panel
    assert "Noch keine Zutaten" in panel
    assert "dishes_confirm_add" in shopping_card
    assert "dish_color_rgb" in shopping_card
    assert "_renderDishDialog" in shopping_card
    assert "data-dish-category-search" in shopping_card
    assert "data-dish-category-option" in shopping_card
    assert 'class="dish-category-combo ${choice.source === "none" ? "unresolved" : ""}"' in shopping_card
    assert "dish-category-combo.unresolved" in shopping_card
    assert "Dynamisch in dieser Liste" in shopping_card
    assert "category: dynamicName" in shopping_card
    assert "_wrappedChipCategoryKey" in shopping_card


def test_database_has_versioned_list_schema() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    constants = _localized_source(INTEGRATION / "const.py")

    assert "DATABASE_SCHEMA_VERSION: Final = 1" in constants
    assert "CREATE TABLE lists" in database
    assert "CREATE TABLE list_items" in database
    assert "FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE" in database
    assert "CREATE UNIQUE INDEX lists_name_unique" in database
    assert "uuid4()" in database
    assert "CREATE TABLE products" in database
    assert "CREATE UNIQUE INDEX products_ean_unique" in database
    assert "CREATE TABLE categories" in database
    assert "CREATE TABLE category_rules" in database
    assert "CREATE TABLE IF NOT EXISTS user_favorites" in database
    assert "categories_global_name_unique" in database
    assert "categories_list_name_unique" in database
    assert "def _create_schema" in database
    assert "is not supported" in database
    assert "def _migrate_schema" not in database
    assert "lists_external_entity_unique" in database
    assert "list_items_external_uid_unique" in database
    assert "CREATE TABLE notification_pending_batches" in database
    assert "CREATE TABLE list_category_order" in database
    assert "list_items_product_id_idx" in database
    assert 'product_id=row["product_id"]' in database
    group_mapper = database[database.index("def _inventory_group_record_from_row"):database.index("def _inventory_select")]
    assert 'product_id=row["product_id"]' not in group_mapper
    assert "CREATE TABLE labels" in database
    assert "CREATE TABLE product_labels" in database
    assert "CREATE TABLE list_item_labels" in database
    assert "labels_global_name_unique" in database
    assert "labels_type_name_unique" in database
    assert "labels_list_name_unique" in database
    assert "CREATE TABLE chips" in database
    assert "chips_global_name_unique" in database
    assert "chips_type_name_unique" in database
    assert "chips_list_name_unique" in database
    assert "label_conflict_policy" in database
    assert "original_name TEXT" in database
    assert "list_items_category_id_idx" in database
    assert "category_id=row[\"category_id\"]" in database
    assert "CREATE TABLE inventory_entries" in database
    assert "UNIQUE (list_id, product_id)" in database
    assert "CREATE TABLE inventory_groups" in database
    assert "CREATE TABLE inventory_group_members" in database
    assert "inventory_entry_id TEXT NOT NULL UNIQUE" in database
    assert "CREATE TABLE scanners" in database
    assert "CREATE TABLE scanner_target" in database
    assert "CREATE TABLE scan_history" in database


def test_restock_configuration_is_backend_owned_and_quantity_is_per_source() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    inventory_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-inventory-card.js")
    database = _localized_source(INTEGRATION / "database.py")

    for marker in ["data-inventory-restock-settings", "data-save-inventory-restock-settings", "data-inventory-restock-rule", "data-inventory-restock-quantity"]:
        assert marker in panel
    assert "Standardregel für Artikel ohne eigene Einstellung" in panel
    assert "Standardmenge (optional)" in panel
    assert "Listenstandard verwenden" in panel
    assert "Ohne Mindestbestand gibt es keine Schwelle" in panel
    assert "requestAnimationFrame(() => requestAnimationFrame(restoreScroll))" in panel
    assert "data-reset-inventory-restock-latch" in panel
    assert 'type: `${API}/inventory/restock/preview`' in panel
    assert 'type: `${API}/inventory/restock/latch/reset`' in panel
    assert "data-open-restock-settings" not in inventory_card
    assert "data-save-restock" not in inventory_card
    assert "data-open-restock-preview" in inventory_card
    assert "def _effective_restock_mode" in database
    assert 'source["restock_quantity"] if source["restock_mode"] == "fixed"' in database


def test_entity_inventory_records_exact_states_and_registers_history_card() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    manager = _localized_source(INTEGRATION / "entity_history.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel_module = _localized_source(INTEGRATION / "panel.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    history_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-history-card.js")

    assert "CREATE TABLE IF NOT EXISTS tracked_entities" in database
    assert "CREATE TABLE IF NOT EXISTS entity_states" in database
    assert 'latest["state"] == state' in database
    assert 'latest["attributes_json"] == attributes_json' in database
    assert "async_track_state_report_event" in manager
    assert "EVENT_STATE_CHANGED" in manager
    assert "EVENT_ENTITY_REGISTRY_UPDATED" in manager
    assert 'event.data.get("old_entity_id")' in manager
    assert "dict(state.attributes)" in manager
    assert 'f"{DOMAIN}/entity_history/get"' in websocket
    assert "POLICY_READ" in websocket
    assert "HISTORY_CARD_MODULE_URL" in panel_module
    assert '"Entity-Inventar"' in panel
    assert 'customElements.define("ha-list-manager-history-card"' in history_card
    assert "Number(point.raw)" in history_card
    assert "values_to_show" in history_card
    assert "latest: true" in history_card
    assert "static getConfigForm" in history_card
    assert 'this._form = document.createElement("ha-form")' in history_card
    assert 'font:24px sans-serif' in history_card
    assert 'f"{DOMAIN}/entity_history/import"' in websocket
    assert "entity_history_import.py" in {
        path.name for path in INTEGRATION.iterdir()
    }
    assert 'value: "list"' in history_card
    assert "_renderList" in history_card
    assert "data-toggle-history" in history_card
    assert "list_rows_before_scroll" in history_card
    assert 'data-set-view="chart"' in history_card
    assert 'data-set-view="list"' in history_card
    assert "view-switch button.active" in history_card
    assert 'name: "min_value"' in history_card
    assert 'name: "max_value"' in history_card
    assert 'selector: { icon: {} }' in history_card
    assert 'selector: { color_rgb: {} }' in history_card
    assert 'label: "1. Entität – Hauptreihe"' in history_card
    assert 'label: haListManagerHistoryCardText("ui.numbered_entity_optional", {p0:(index)}, hass)' in history_card
    assert "_seriesConfigs" in history_card
    assert "Promise.all" in history_card
    assert "_niceScale" in history_card
    assert "niceFraction" in history_card
    assert 'class="series-legend"' in history_card
    assert 'name: "header_value"' in history_card
    assert 'value: "none", label: "Ausblenden"' in history_card
    assert 'haListManagerHistoryCardText("history.entity_count", {p0:(seriesData.length)}, this._hass)' in history_card
    assert 'label: "Zeitraum und Anzahl"' in history_card
    assert 'label: "Darstellung"' in history_card
    assert 'label: "Kartenverhalten"' in history_card
    assert 'name: "scale_decimals"' in history_card
    assert 'name: "value_fixed_decimals"' in history_card
    assert 'name: "axis_decimals"' in history_card
    assert 'name: "axis_fixed_decimals"' in history_card
    assert "_formatAxisValue(label)" in history_card
    assert "minimumFractionDigits: fixed ? digits : 0" in history_card
    assert "computeHelper" in history_card
    assert "previousScrollTop" in history_card
    assert "currentList.scrollTop = previousScrollTop" in history_card
    assert "summaryParts" in history_card
    assert "Weitere ältere passende Datenpunkte vorhanden" not in history_card
    assert "_sameSeriesData" in history_card
    assert "if (shouldRender) this._render()" in history_card
    hass_setter = re.search(r"^  set hass\(hass\) \{\n.*?^  \}", history_card, re.MULTILINE | re.DOTALL).group()
    assert "TextUpdateTranslations(this, this._hass)" in hass_setter
    assert "if (translationsChanged) this._render();" in hass_setter
    assert not re.search(r"^\s*this\._render\(\);", hass_setter, re.MULTILINE)
    assert "data-toggle-expanded-view" in history_card
    assert "_findDashboardViewport" in history_card
    assert ':host([data-expanded-view])' in history_card
    assert "Große Ansicht öffnen" in history_card
    assert 'event.key === "Escape"' in history_card
    assert 'probatio.Optional("min_value")' in websocket
    assert 'probatio.Optional("max_value")' in websocket
    assert "numeric_filter" in database
    assert "len(selected_rows) > limit" in database
    assert '"already_stored": already_stored' in database
    assert '"unchanged": unchanged' in database
    assert "ohne Zustandsänderung verworfen" in panel
    assert "first_recorded_at" in panel
    assert "Langzeitstatistik ergänzen" in panel


def test_category_toggles_update_only_the_affected_group() -> None:
    frontend = INTEGRATION / "frontend"
    for kind, bind_method in [
        ("shopping", "_bindDynamicContent"),
        ("inventory", "_bindInventoryRowEvents"),
    ]:
        card = _localized_source(frontend / f"ha-list-manager-{kind}-card.js")
        toggle = _card_method(card, "_toggleCategory")
        assert 'header?.closest(".category")' in toggle
        assert 'setAttribute("aria-expanded"' in toggle
        assert "[...section.children].slice(1)" in toggle
        assert 'insertAdjacentHTML("beforeend"' in toggle
        assert f"this.{bind_method}(section, false)" in toggle
        assert 'if (!header || !section || !group) { this._render(); return; }' in toggle
        assert toggle.count("this._render()") == 1
        assert "shadowRoot.innerHTML" not in toggle

    todo = _localized_source(frontend / "ha-list-manager-todo-card.js")
    toggle = _card_method(todo, "_toggleCategory")
    assert 'if (!this._applyCategoryState(id, collapsed, button)) this._render();' in toggle
    assert toggle.count("this._render()") == 1
    update = _card_method(todo, "_applyCategoryState")
    assert 'if (!header || !section || !group) return false;' in update
    assert 'header?.closest(".category")' in update
    assert 'setAttribute("aria-expanded"' in update
    assert 'this._clearRenderListeners(previousItems); previousItems.remove();' in update
    assert 'section.insertAdjacentHTML("beforeend"' in update
    assert 'this._bindContent(section, false)' in update
    assert "return true;" in update
    assert "this._render()" not in update
    assert "shadowRoot.innerHTML" not in update


def test_bring_lists_use_external_todo_and_local_metadata() -> None:
    external_lists = _localized_source(INTEGRATION / "external_lists.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    shopping_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")

    assert 'registry_entry.platform != "bring"' in external_lists
    assert '"get_items"' in external_lists
    assert '"update_entity"' in external_lists
    assert "refresh_source=False" in external_lists
    assert "def _public_item" in external_lists
    assert "description=parse_bring_details(item.description)" in external_lists
    assert 'const isBring = list.list_type === "bring"' in panel
    assert "Menge oder Beschreibung (optional)" in panel
    assert "Menge oder Beschreibung (optional)" in shopping_card
    assert 'provider = "bring" if requested_type == "bring" else "local"' in websocket
    assert 'list_type = "shopping" if provider == "bring" else requested_type' in websocket
    assert 'integration: "bring"' in panel
    assert "_ensureItemsSubscription" in panel
    assert "_bringRefreshTimer" in panel
    assert "async_archive_external_item" in external_lists
    assert "async_get_external_item_metadata" in external_lists
    assert "remote_name_counts" in external_lists
    assert "this._loadItems(true)" in panel
    assert "JSON.stringify(nextItems) !== JSON.stringify(this._items)" in panel
    assert "ITEMS_EVENT" in panel
    assert "_bringRefreshTimer" in shopping_card
    assert 'this._list?.list_type === "bring"' in shopping_card
    assert '!["shopping", "bring"].includes(nextList.list_type)' in shopping_card
    assert '["shopping", "bring"].includes(state.attributes?.list_type)' in shopping_card
    assert "include_entities: entities" in shopping_card


def test_backend_todo_card_is_registered_and_keeps_task_semantics() -> None:
    panel_module = _localized_source(INTEGRATION / "panel.py")
    todo_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert "TODO_CARD_MODULE_URL" in panel_module
    assert 'customElements.define("ha-list-manager-todo-card"' in todo_card
    assert 'state.attributes?.list_type === "todo"' in todo_card
    assert 'Wiederholen alle' in todo_card
    assert 'Beschreibung (optional)' in todo_card
    assert 'quantity: 1' in todo_card
    assert 'show_plus_minus' not in todo_card
    assert '_remainingDue(item)' in todo_card
    assert 'class="item-name-row"' in todo_card
    assert 'class="interval"' in todo_card
    assert 'class="due-remaining"' in todo_card
    assert 'return "Fällig"' in todo_card


def test_todo_due_editor_uses_separate_date_and_time_fields() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    todo_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    todo_panel = panel.split("_renderItemDialog() {", 1)[1].split("\n  _", 1)[0]
    for frontend in (todo_panel, todo_card):
        assert 'type="date"' in frontend
        assert 'type="time"' in frontend
        assert 'datetime-local' not in frontend
    assert "draft.due_date" in panel
    assert "draft.due_time" in panel
    assert "d.due_date" in todo_card
    assert "d.due_time" in todo_card
    assert ".todo-due-fields{grid-template-columns:" in panel
    assert ".todo-recurrence-fields{grid-template-columns:" in panel
    assert ".due-editor-row{display:grid;grid-template-columns:" in todo_card


def test_todo_action_menu_closes_and_card_header_toggles_list() -> None:
    todo_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert "if (changed && this._actionDialog) this._closeDialogs()" in todo_card
    assert "_listCollapseKey()" in todo_card
    assert "_toggleList()" in todo_card
    assert 'data-toggle-list aria-expanded=' in todo_card
    assert 'root.querySelector("[data-toggle-list]")' in todo_card


def test_all_backend_cards_offer_configurable_list_collapse() -> None:
    frontend = INTEGRATION / "frontend"
    todo = _localized_source(frontend / "ha-list-manager-todo-card.js")
    shopping = _localized_source(frontend / "ha-list-manager-shopping-card.js")
    inventory = _localized_source(frontend / "ha-list-manager-inventory-card.js")

    for card in (todo, shopping, inventory):
        assert 'collapsible: true' in card
        assert '{ name: "collapsible", selector: { boolean: {} }, default: true }' in card
        assert 'data-toggle-list aria-expanded=' in card
        assert '_listCollapseKey()' in card
        assert '_toggleList()' in card
    assert 'class="inventory-title"' in inventory
    assert inventory.index('const titleHeader =') < inventory.index('const cardBody =')
    for card in (todo, shopping, inventory):
        assert 'title_icon' in card
        assert '.list-collapsed{height:76px;padding:12px 14px}' in card
        assert 'height:50px;min-height:50px;margin:0 0 8px' in card
        assert 'margin:0' in card
        assert 'height:54px;min-height:54px;margin:0 0 4px' in card
        assert 'color:var(--primary-color)' in card
    assert 'mdi:cart-variant' in shopping
    assert 'mdi:package-variant-closed' in inventory
    assert 'haListManagerShoppingCardText("ui.open_total_items", {p0:(openItems), p1:(this._items.length)}, this._hass)' in shopping
    assert 'unter Mindestbestand' in inventory
    assert 'Mindestbestand erfüllt' in inventory
    assert 'grid-template-rows:auto auto' in shopping
    assert 'grid-template-rows:auto auto' in inventory
    assert 'class="title-heading"><h2>' in todo
    assert 'class="title-meta">${titleDue}' in todo
    assert '.title-meta{grid-column:1;grid-row:2' in todo


def test_all_list_cards_offer_configurable_title_icon_color() -> None:
    frontend = INTEGRATION / "frontend"
    cards = [
        _localized_source(frontend / "ha-list-manager-shopping-card.js"),
        _localized_source(frontend / "ha-list-manager-todo-card.js"),
        _localized_source(frontend / "ha-list-manager-inventory-card.js"),
    ]

    for card in cards:
        assert '{ name: "title_icon_color_rgb", selector: { color_rgb: {} } }' in card
        assert 'title_icon_color_rgb: "Farbe des Titel-Icons"' in card
        assert 'this._config.title_icon_color_rgb' in card
        assert 'Ohne Auswahl wird die Primärfarbe des Home-Assistant-Themes verwendet.' in card


def test_todo_input_and_inventory_mode_panel_are_harmonized() -> None:
    frontend = INTEGRATION / "frontend"
    todo = _localized_source(frontend / "ha-list-manager-todo-card.js")
    inventory = _localized_source(frontend / "ha-list-manager-inventory-card.js")

    assert '<button class="primary" data-add-task><span>Hinzufügen</span></button>' in todo
    assert 'data-add-task><ha-icon' not in todo
    assert '.input-row input{height:44px;min-height:44px}' in todo
    assert '.input-row .primary{height:44px;min-height:44px}' in todo
    assert ':host{display:block;container-type:inline-size}' in todo
    assert 'ha-card{padding:12px 14px 18px' in todo
    assert '@container(max-width:600px){' in todo
    assert 'ha-card{padding:10px}' in todo
    assert '.input-row{grid-template-columns:1fr}.input-row .primary{height:42px;min-height:42px}' in todo

    assert '{ name: "show_mode_toggle", selector: { boolean: {} }, default: true }' in inventory
    assert '{ name: "mode_panel_expanded", selector: { boolean: {} }, default: true }' in inventory
    assert '_modePanelKey()' in inventory
    assert 'localStorage.getItem(this._modePanelKey())' in inventory
    assert 'localStorage.setItem(this._modePanelKey()' in inventory
    assert 'data-toggle-mode-panel' in inventory
    assert 'const modePanel = this._config.show_mode_toggle !== false && modePanelExpanded ?' in inventory
    assert '.inventory-title{display:grid;grid-template-columns:auto minmax(0,1fr);' in inventory
    assert 'text-overflow:ellipsis;white-space:nowrap' in inventory
    assert '.input-row input{width:100%;height:44px;padding:0 11px;' in inventory
    assert '.input-row{display:flex;align-items:stretch;gap:8px;margin:8px 0 14px}' in inventory
    assert '.product-input{position:relative;flex:1 1 160px;min-width:0}' in inventory
    assert '.input-row>.quantity{flex:0 0 92px}' in inventory
    assert '.view-mobile .input-row{flex-wrap:wrap}' in inventory


def test_inventory_and_todo_cards_support_the_large_view_modes() -> None:
    frontend = INTEGRATION / "frontend"
    for name in ("ha-list-manager-inventory-card.js", "ha-list-manager-todo-card.js"):
        card = _localized_source(frontend / name)
        assert 'content_display: "card_and_large"' in card
        assert '{ value: "card_only", label: "Nur in der Karte" }' in card
        assert '{ value: "large_only", label: "Nur in Großansicht" }' in card
        assert 'data-toggle-expanded-view' in card
        assert '_findDashboardViewport()' in card
        assert '_setExpandedView(expanded)' in card
        assert ':host([data-expanded-view])' in card
        assert 'event.key === "Escape"' in card
        assert 'if (!this._expandedView) this._toggleList()' in card


def test_panel_view_can_collapse_and_uses_the_card_background() -> None:
    frontend = INTEGRATION / "frontend"
    shopping = _localized_source(frontend / "ha-list-manager-shopping-card.js")
    inventory = _localized_source(frontend / "ha-list-manager-inventory-card.js")

    assert '.view-panel.list-collapsed{min-height:0}' in shopping
    for card in (shopping, inventory):
        assert 'background:var(--ha-card-background,var(--card-background-color))!important' in card


def test_todo_due_icon_setting_applies_to_entries_and_categories() -> None:
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert 'Kalender-Icon bei Fälligkeiten anzeigen' in todo
    due_method = todo.split('_dueHtml(item) {', 1)[1].split('_matchesFilter(item)', 1)[0]
    assert 'this._config.show_title_info_icon' in due_method
    category_method = todo.split('_contentHtml() {', 1)[1].split('_inputHtml()', 1)[0]
    assert 'this._config.show_title_info_icon' in category_method


def test_external_item_metadata_has_a_versioned_schema() -> None:
    database = _localized_source(INTEGRATION / "database.py")

    assert "CREATE TABLE external_item_metadata" in database
    assert "PRIMARY KEY (list_id, match_key)" in database
    assert "FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE" in database


def test_api_exposes_list_crud() -> None:
    websocket = _localized_source(INTEGRATION / "websocket.py")

    for command in ["lists/list", "lists/create", "lists/update", "lists/delete"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["items/list", "items/create", "items/update", "items/set_completed", "items/reorder", "items/delete"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["products/list", "products/lookup", "products/create", "products/update", "products/delete"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["settings/get", "settings/update"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["categories/list", "categories/create", "categories/update", "categories/delete", "categories/order/get", "categories/order/set", "categories/order/reset"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["labels/list", "labels/create", "labels/update", "labels/delete"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["chips/list", "chips/create", "chips/update", "chips/delete"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["inventory/lists", "inventory/list", "inventory/options", "inventory/lookup", "inventory/add", "inventory/create", "inventory/update", "inventory/adjust", "inventory/visibility", "inventory/delete"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["inventory/groups/list", "inventory/groups/create", "inventory/groups/update", "inventory/groups/delete"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    for command in ["scanners/list", "scanners/create", "scanners/update", "scanners/delete", "scanner/target/get", "scanner/target/set", "scanner/target/clear", "scanner/simulate", "scanner/queue/list", "scanner/queue/list_for_list", "scanner/queue/hold", "scanner/queue/resolve", "scanner/queue/dismiss", "scanner/history"]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    assert 'f"{DOMAIN}/lists/scope-impact"' in websocket
    update_list = websocket[websocket.index("async def websocket_update_list"):websocket.index("async def websocket_delete_list")]
    assert 'probatio.Optional("list_type")' not in update_list
    assert 'list_type=msg.get("list_type")' not in update_list


def test_panel_uses_home_assistant_selectors() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert 'selector = { icon: {} }' in panel
    assert '{ select: { mode: "dropdown"' in panel
    assert "data-open-list" in panel
    assert "data-add-item" in panel
    assert "data-add-product" in panel
    assert "data-product-search" in panel
    assert "data-category-color-selector" in panel
    assert "data-clear-category-color" in panel
    assert "data-add-list-category" in panel
    assert 'class="category-page-actions"' in panel
    assert "${tabBar}${specificPicker}${categoryActions}" in panel
    assert "data-add-list-category-id" not in panel
    assert "data-sort-list-categories" not in panel
    assert "data-category-specific-list" in panel
    assert "list.name} · ${LIST_TYPES(this._hass)[list.list_type]?.label" in panel
    assert '<ha-input class="selector-field" type="color"' in panel
    assert "data-item-category-search" in panel
    assert "data-item-category-options" in panel
    assert 'customElements.get("ha-generic-picker")' in panel
    assert "data-inventory-product-search" in panel
    assert "data-clear-inventory-product-search" in panel
    assert "data-new-inventory-product" in panel
    assert "data-edit-inventory-product" in panel
    assert "data-inventory-entry-category-search" in panel
    assert "data-inventory-entry-category-options" in panel
    assert "_inventoryProductDefaultCategory" in panel
    assert 'class="inventory-category-notice"' in panel
    assert "mdi:information-outline" in panel
    assert 'search: "", label_id: null, limit: 100, offset: 0' in panel
    assert "Die Suche zeigt höchstens 100 Treffer." in panel
    assert "--label-color" in panel
    assert "data-product-label-filter" in panel
    assert "data-label-input" in panel
    assert "data-remove-label" in panel
    assert "data-label-color-selector" in panel
    assert "data-label-search" in panel
    assert 'class="category-row definition-row"' in panel
    assert ".category-row.definition-row{grid-template-columns:auto minmax(0,1fr) auto auto}" in panel
    assert ".category-row.definition-row{grid-template-columns:auto minmax(0,1fr) auto}" in panel
    assert ".entity-history-actions{grid-column:1/3" in panel
    assert ".notification-profile-row>.row-actions{grid-column:1/3" in panel
    assert "data-list-item-search" in panel
    assert "Der Listentyp wird beim Anlegen festgelegt" in panel
    assert "data-open-inventory-section" in panel
    assert "lovelace/dashboards/list" in panel
    assert "lovelace/config" in panel
    assert "lovelace_updated" in panel
    assert "data-refresh-dashboard-usages" in panel
    assert 'class="detail-section dashboard-usage-card"' in panel
    assert ".list-scope-card .section-heading,.dashboard-usage-card .section-heading{display:grid" in panel
    assert "this._navigationScrollLeft = 0;" in panel
    assert 'this.shadowRoot.querySelector("nav")?.scrollLeft' in panel
    assert "navigationElement.scrollLeft = navigationScrollLeft;" in panel
    assert "requestAnimationFrame(() => requestAnimationFrame" in panel
    assert 'window.matchMedia("(max-width: 760px)").matches' in panel
    assert 'nav::after{content:"";flex:0 0 calc(50vw - 48px)}' in panel
    assert "data-view-inventory-image" in panel
    assert "_labelUsageText(label)" in panel
    assert "data-inventory-list-filter" in panel
    assert "data-add-inventory" in panel
    assert "data-product-page-size" in panel
    assert "data-product-page=" in panel
    assert "this._productPageSize = 25" in panel


def test_categories_use_the_same_scope_tabs_as_labels_and_chips() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    for tab in ("global", "shopping", "inventory", "todo", "specific", "dynamic"):
        assert f'["{tab}",' in panel
        assert f'data-category-tab="${{id}}"' in panel
    assert 'this._categoryTab = "global"' in panel
    assert 'data-category-scope="global"' in panel
    assert 'data-category-scope="list"' in panel
    assert 'data-category-scope="list_type"' in panel
    assert 'id === "dynamic" ? this._dynamicCategories.length' in panel
    assert "data-label-specific-list" in panel
    assert "data-chip-specific-list" in panel
    assert 'this._labelSpecificListId = ""' in panel
    assert 'this._chipSpecificListId = ""' in panel
    assert 'data-label-list-id="${this._escape(selectedListId)}"' in panel
    assert 'data-chip-list-id="${this._escape(selectedListId)}"' in panel


def test_statistics_have_their_own_last_navigation_section() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert '["statistics", "Statistiken", "mdi:chart-box-outline"]' in panel
    assert panel.index('["settings", "Einstellungen"') < panel.index('["statistics", "Statistiken"')
    assert 'if (this._activeSection === "statistics") return this._renderStatistics();' in panel
    assert '_renderStatistics() {' in panel
    assert '"Häufig verwendete Bereiche schnell wieder öffnen."' in panel


def test_regular_list_details_have_overview_and_item_tabs() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert 'this._listDetailTab = "overview"' in panel
    assert 'data-list-detail-tab="overview"' in panel
    assert 'data-list-detail-tab="items"' in panel
    assert "_renderListOverview(list)" in panel
    assert "_renderListItemsTab(list, type)" in panel
    assert "Eigene Kategorien" in panel
    assert "Eigene Labels" in panel
    assert "Eigene To-do-Vorlagen" in panel
    assert "Eigene Artikel-Chips" in panel
    assert "Verfügbare Inhalte" in panel
    assert 'class="list-availability-matrix"' in panel
    assert 'data-toggle-list-scope="${key}"' in panel
    assert 'data-confirm-list-scope-toggle' in panel
    assert '_openListScopeToggle(key)' in panel
    assert '_confirmListScopeToggle()' in panel
    assert 'data-edit-current-list><ha-icon icon="mdi:tune"' not in panel
    assert 'data-add-list-category title="Kategorie hinzufügen"' in panel
    assert 'data-open-list-assignments><ha-icon icon="mdi:link-variant"' in panel
    assert "Zuordnungen verwalten" in panel
    assert 'data-open-list-assignments="rules"' not in panel
    assert 'data-open-list-assignments="products"' not in panel
    assert 'class="list-assignment-link-copy"' in panel
    assert 'const mode = specific ? "list" : listType ? "list_type" : "global";' in panel
    assert 'if (listType) this._categoryOrderListType = listType;' in panel
    assert '_loadListAssignments(listId, quiet = false)' in panel
    assert 'data-category-specific-list' in panel
    assert 'data-category-detail-target="${detailMode === "summary" ? this._categorySpecificMode : detailMode || "rules"}"' in panel
    assert 'renderCategory(category, "summary")' in panel
    assert "die automatischen und festen Produktzuordnungen der Kategorie" in panel
    assert "Der Stift öffnet den vollständigen Kategorieeditor." in panel
    assert 'data-specific-assignment-mode="rules"' not in panel
    assert '_renderListAssignmentsPage(list)' not in panel
    assert 'data-back-list-assignments' not in panel
    assert "Gespeicherte Seiten und Tabs direkt öffnen." in panel
    assert "Deine persönlichen Favoriten in Home Assistant." not in panel
    assert "_findListCards" in panel


def test_product_editor_uses_scoped_category_combobox() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "_productCategoryAssignmentsMarkup()" in panel
    assert "data-product-global-category" in panel
    assert "data-add-product-exception" in panel
    assert "_configureProductCategoryPicker()" in panel
    assert "data-product-shopping-category" in panel
    assert "data-product-inventory-category" in panel
    assert "data-product-exception-category" in panel
    assert '_productCategoryComboMarkup("data-product-global-category"' in panel
    assert 'role="combobox"' in panel
    assert "Keine passende gespeicherte Kategorie." in panel
    assert "data-product-combo-value" in panel
    assert 'class="label-option-icon"' in panel
    assert 'secondary: category.scope === "global"' in panel
    assert 'label: "Allgemein", secondary: "Keine Kategorie"' in panel
    assert '_productCategoryComboMarkup("data-product-global-category", "Global")' in panel
    assert "Hier können nur bereits unter „Kategorien“ gespeicherte Kategorien gewählt werden." in panel
    assert "Dynamische Kategorien für einzelne Einträge bleiben davon unberührt." in panel


def test_product_pagination_filters_before_limit_and_offset() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "async_list_products_page" in database
    assert "SELECT COUNT(*) AS value FROM products" in database
    assert '"LIMIT ? OFFSET ?"' in database
    assert 'probatio.Optional("limit"): int' in websocket
    assert 'probatio.Optional("offset"): int' in websocket
    assert "limit: this._productPageSize" in panel
    assert "offset: (this._productPage - 1) * this._productPageSize" in panel
    assert "this._productPage = 1" in panel


def test_inventory_card_is_registered_as_a_self_contained_resource() -> None:
    frontend = INTEGRATION / "frontend"
    card = _localized_source(frontend / "ha-list-manager-inventory-card.js")
    panel_module = _localized_source(INTEGRATION / "panel.py")

    assert "class HaListManagerClient" in card
    assert "Keep this Lovelace resource self-contained" in card
    assert 'customElements.define("ha-list-manager-inventory-card"' in card
    assert "HA List Manager – Inventar" in card
    assert "INVENTORY_CARD_MODULE_URL" in panel_module
    assert "add_extra_js_url" in panel_module


def test_inventory_product_dialog_is_shared_and_persists_explicit_labels() -> None:
    card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-inventory-card.js")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    scanner = _localized_source(INTEGRATION / "scanner.py")

    assert "_productDialogDraft(product = null, overrides = {})" in card
    assert '["product-edit", "add"].includes(this._dialog.kind)' in card
    assert "_renderProductDialog(eanStatus, generalStatus)" in card
    assert card.count('<section class="dialog product-dialog"') == 1
    assert 'const productFields = ["name", "original_name", "ean", "brand", "package_quantity", "image_url"]' in card
    assert 'labels_supplied = "label_ids" in msg' in websocket
    assert "if product is not None and labels_supplied:" in websocket
    assert "product_label_ids: list[str] | None = None" in scanner
    assert "if product is not None and product_label_ids is not None:" in scanner
    assert 'probatio.Optional("minimum_stock"): probatio.Any(int, None)' in websocket
    assert "minimum_stock: minimum" in card
    resolve = websocket[
        websocket.index("async def websocket_resolve_pending_scan"):
        websocket.index('f"{DOMAIN}/scanner/queue/dismiss"')
    ]
    assert "product_label_ids=product_label_ids" in resolve


def test_inventory_categories_visibility_and_views_are_supported() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-inventory-card.js")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "category_id TEXT REFERENCES categories(id) ON DELETE SET NULL" in database
    assert "hidden INTEGER NOT NULL DEFAULT 0" in database
    assert "data-product-input" in card
    assert "data-suggestions" in card
    assert "Produkt zum Inventar hinzufügen" in card
    assert "data-toggle-hidden" in card
    assert 'view_mode: "auto"' in card
    assert "data-toggle-category-menu" in card
    assert "Nicht nach Kategorien gruppieren" in card
    assert "product-image-placeholder" in card
    assert "quantity_position" in card
    assert "category_sort" in card
    assert 'value: "alphabetical", label: "Kombiniert nach ABC"' in card
    assert 'value: "position", label: "Manuelle Position"' in card
    assert "_compareCategories(a, b)" in card
    assert "data-category-position" in panel
    assert "data-edit-category-order" in panel
    assert 'draggable="true"' in panel
    assert "data-category-order-position" in panel
    assert "Globale Grundreihenfolge" in panel
    assert "Kombinierte Ausnahme für eine Liste" in panel
    assert "data-reset-combined-category-order" in panel
    assert "categories/order/get" in panel
    assert "categories/order/set" in panel
    assert "manual_position" in card
    assert "mode_timeout" in card
    assert "data-name-component" in card
    assert "data-edit-product" in card
    assert "data-delete-entry" in card
    assert "static getConfigElement()" in card
    assert 'state.attributes?.list_type === "inventory"' in card
    assert "include_entities: entities" in card
    assert "data-toggle-category" in card
    assert "localStorage.setItem" in card
    assert "this._cardIdentity()" in card
    assert "data-category-input" in card
    assert "data-category-options" in card
    assert "data-view-image" in card
    assert "data-label-input" in card
    assert "data-label-option" in card
    assert "data-remove-label" in card
    assert "Keine passenden Labels" in card
    assert '_configureLabelSelector()' in card
    assert '_renderDialogStatus("ean")' in card
    assert 'dialog-status.success' in card
    assert 'dialog-status.warning' in card
    assert 'dialog-status.error' in card
    assert "_bindDialogScrollGuard()" in card
    assert "Änderungen verwerfen?" in card
    assert "Noch nicht gespeichert" in card
    assert "data-toggle-group-selection" in card
    assert "data-edit-group" in card
    assert "Produktvorgabe verwenden" in card
    assert "Bevorzugte Kategorie (optional)" not in card
    assert "listentypbezogenen und listenspezifischen Produktkategorien" in card
    assert "data-product-category-input" not in card
    assert "data-open-member-picker" in card
    assert "data-member-picker-search" in card
    assert "data-show-grouped-members" in card
    assert "Dynamisch in diesem Inventar" in card
    assert "data-toggle-label-menu" in card
    assert "data-label-choice" in card
    assert "Ohne Label" in card
    assert "data-pick-group" in card
    assert "data-new-group-for-entry" in card
    assert "data-confirm-accept" in card
    assert "PICKER_RESULT_LIMIT = 100" in card
    assert "Artikel verschieben und Gruppe auflösen?" in card
    assert "Produkt-DB" in card
    assert "/ha_list_manager/products" in card
    assert "confirm(" not in card
    assert "allow_filter" in card
    assert "HA_LM_SCANNER_TARGET_EVENT" in card
    assert "data-toggle-scanner-target" in card
    assert "Scannerziel wechseln?" in card
    assert "data-camera-scan" in card
    assert "Html5QrcodeScanner" in card


def test_scanner_backend_is_central_and_simulatable() -> None:
    scanner = _localized_source(INTEGRATION / "scanner.py")
    database = _localized_source(INTEGRATION / "database.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert 'SCANNER_EVENT = "eyoyo_barcode_scanned"' in scanner
    assert "class ScannerManager" in scanner
    assert "async_listen" in scanner
    assert "async_process_scan" in scanner
    assert "async_add_scan_history" in scanner
    assert "data-run-simulation" in panel
    assert "Scanner simulieren" in panel
    assert "data-simulation-ean" in panel
    assert "data-simulation-delay" in panel
    assert "async_list_pending_scans" in database
    assert "async_resolve_pending_scan" in scanner
    assert "async_queue_offered_scan" in scanner
    assert "_async_queue_unclaimed_offer" in scanner
    assert "_async_process_unclaimed_offer" not in scanner
    assert "needs_review" in scanner
    assert "entry.stock < quantity" in scanner
    assert "data-history-tab" in panel
    assert "data-edit-pending-scan" in panel
    assert "Offenen Scan bearbeiten" in panel
    assert "data-scan-page-size" in panel
    assert 'tab("devices"' in panel
    assert 'tab("simulation"' in panel
    assert "data-retry-pending-scan" not in panel
    assert "LIMIT ? OFFSET ?" in database

    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    assert "GROUP_PICKER_RESULT_LIMIT = 100" in panel
    assert "data-inventory-group-search" in panel
    assert "data-confirm-group-moves" in panel
    assert "data-admin-show-grouped" in panel
    assert "_bindDialogScrollGuard()" in panel


def test_backend_lists_are_exposed_as_native_home_assistant_entities() -> None:
    integration = _localized_source(INTEGRATION / "__init__.py")
    sensor = _localized_source(INTEGRATION / "sensor.py")

    assert "Platform.SENSOR" in integration
    assert "Platform.TODO" not in integration
    assert not (INTEGRATION / "todo.py").exists()
    assert "async_forward_entry_setups" in integration
    assert "class HaListManagerListSensor" in sensor
    assert "if record.enabled" in sensor
    assert '"list_id": self._record.id' in sensor
    assert '"provider": self._record.provider' in sensor
    assert '"external_entity_id": self._record.external_entity_id' in sensor
    assert "entity_registry" not in integration


def test_bring_quantity_does_not_treat_measurements_as_item_counts() -> None:
    helpers = runpy.run_path(INTEGRATION / "bring_quantity.py")
    parse = helpers["parse_bring_quantity"]
    parse_details = helpers["parse_bring_details"]
    format_description = helpers["format_bring_description"]

    assert parse(None) == 1
    assert parse("7") == 7
    assert parse("250 ml") == 1
    assert parse("2 kg") == 1
    assert parse("6 Mit Beschreibung ^^") == 1
    assert parse("2 · 250 ml") == 1
    assert parse("2 x 250 ml") == 2
    assert parse("2×Bio, mild") == 2
    assert parse_details("250 ml") == "250 ml"
    assert parse_details("2 kg") == "2 kg"
    assert parse_details("2 x 250 ml") == "250 ml"
    assert parse_details("2×Bio, mild") == "Bio, mild"
    assert parse_details("2 · 250 ml") == "2 · 250 ml"
    assert format_description(2, "250 ml") == "2 x 250 ml"
    assert format_description(2, "Bio, mild") == "2 x Bio, mild"
    assert format_description(1, "2 · 250 ml") == "2 · 250 ml"
    assert format_description(1, "2 x Bio, mild") == "Bio, mild"


def test_label_list_includes_assignment_counts_without_n_plus_one_queries() -> None:
    database = _localized_source(INTEGRATION / "database.py")

    label_list = database[database.index("def _list_labels"):database.index("def _create_label")]
    assert "FROM product_labels" in label_list
    assert "FROM list_item_labels" in label_list
    assert "product_count" in label_list
    assert "item_count" in label_list


def test_all_content_types_use_the_same_fixed_scope_model() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    save_category = panel[panel.index("async _saveCategory()"):panel.index("async _saveLabel()")]
    save_label = panel[panel.index("async _saveLabel()"):panel.index("async _saveInventory()")]
    assert 'list_type: draft.scope === "list_type" ? draft.list_type : null' in save_category
    assert 'scope: draft.scope' in save_label
    assert 'list_type: draft.scope === "list_type" ? draft.list_type : null' in save_label
    assert 'list_id: draft.scope === "list" ? draft.list_id : null' in save_label
    for legend in ("Verfügbare Kategorien", "Verfügbare Labels"):
        assert f'<fieldset class="option-group"><legend>{legend}</legend>' in panel
    assert 'draft.list_type === "todo" ? "Verfügbare To-do-Vorlagen" : "Verfügbare Artikel-Chips"' in panel
    assert "Globale Artikel-Chips werden in To-do-Listen grundsätzlich nicht angezeigt." in panel
    assert "data-list-label-conflict-select" not in panel
    assert "use_global_categories" in panel
    assert "use_type_categories" in panel
    assert "use_global_chips" in panel
    assert "use_type_chips" in panel


def test_todo_templates_are_separate_and_use_searchable_combos() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert "chip_kind TEXT NOT NULL DEFAULT 'entry'" in database
    assert "To-do-Vorlagen sind nur für To-do-Listen zulässig" in database
    assert 'list_row["list_type"] != "todo"' in database
    create_chip_schema = websocket.split(
        'probatio.Required("type"): f"{DOMAIN}/chips/create"', 1
    )[1].split("async def websocket_create_chip", 1)[0]
    create_item_schema = websocket.split(
        'probatio.Required("type"): f"{DOMAIN}/items/create"', 1
    )[1].split("async def websocket_create_item", 1)[0]
    assert 'probatio.Optional("chip_kind", default="entry")' in create_chip_schema
    assert 'probatio.Optional("template_data")' in create_chip_schema
    assert 'probatio.Optional("chip_kind", default="entry")' not in create_item_schema
    assert 'role="combobox" aria-autocomplete="list"' in panel
    assert "data-chip-category-combo" in panel
    assert "data-chip-label-combo" in panel
    assert "data-chip-list-combo" in panel
    assert "_configureTodoChipPickers()" in panel
    assert "Allgemeine Artikel" in panel
    assert "To-do-Vorlagen" in panel
    assert "Als Vorlage speichern" in todo
    assert "_templateValues(chip)" in todo
    assert "data-todo-chip" in todo


def test_todo_recurrence_uses_database_fields_and_labels_use_tabs() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert "def _create_schema" in database
    assert "recurrence_interval" in database
    assert "recurrence_unit" in database
    assert "marker = re.compile" not in database
    assert 'probatio.Optional("recurrence_interval")' in websocket
    assert "recurrence_interval: recurrenceInterval" in panel
    assert "recurrence_interval: recurrenceInterval" in todo
    assert "INTERVAL_RE" not in todo
    assert "_storedName" not in todo
    for tab in ["Global", "Einkaufsliste", "Inventar", "To-do", "Spezifisch"]:
        assert f'"{tab}"' in panel
    assert "data-label-tab" in panel
    assert "data-label-scope" in panel


def test_dialogs_share_the_same_actions_and_product_feedback() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "_dialogHeader(title)" in panel
    assert 'class="icon-button dialog-close"' in panel
    assert "justify-content:flex-start" in panel
    assert "data-view-product-image" in panel
    assert "_openFoodFactsImageUrl" in panel
    assert "Produktdaten geladen – noch nicht gespeichert." in panel
    assert "Für diese EAN wurden keine Produktdaten gefunden." in panel
    assert "Dynamische Kategorie (optional)" in panel
    assert "data-save-dynamic-category" in panel
    assert "object-fit:contain" in panel
    assert "ean-lookup-block" in panel


def test_product_name_options_preserve_the_custom_base_name() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "_parseProductName(name, brand, quantity)" in panel
    assert "base_name: parsedName.base_name" in panel
    assert "let name = (draft.base_name || draft.name || draft.original_name || \"\").trim()" in panel
    assert "baseName.endsWith(suffix)" in panel
    assert "name.toLocaleLowerCase().includes(value.toLocaleLowerCase())" in panel


def test_list_items_reference_permanent_categories_by_id() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")

    assert "REFERENCES categories(id) ON DELETE SET NULL" in database
    assert "def _resolve_item_category(" in database
    assert "category_id = ? OR" in database
    assert 'probatio.Optional("category_id")' in websocket


def test_open_food_facts_lookup_checks_duplicates_without_implicit_save() -> None:
    websocket = _localized_source(INTEGRATION / "websocket.py")
    lookup = _localized_source(INTEGRATION / "open_facts.py")

    local_position = websocket.index("async_get_product_by_ean(ean)")
    remote_position = websocket.index("async_lookup_open_facts(hass, ean)")
    assert local_position < remote_position
    lookup_block = websocket[websocket.index("async def websocket_lookup_product"):websocket.index("async def websocket_create_product")]
    assert "async_create_product" not in lookup_block
    assert '"duplicate": product.as_dict()' in lookup_block
    assert '"product_type": "all"' in lookup
    assert "product_name_en" in lookup
    assert "image_front_thumb_url" in lookup


def test_list_type_selector_keeps_the_selected_value() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "data-list-type-select" in panel
    assert "typeSelect.options" in panel
    assert 'typeSelect.addEventListener("selected"' in panel
    assert "typeSelect.value = value" in panel


def test_backend_shopping_card_keeps_the_original_card_interaction_model() -> None:
    card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")
    inventory_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-inventory-card.js")
    todo_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert 'show_plus_minus: true' in card
    assert 'quantity_position: "beginning"' in card
    assert 'add_dialog_behavior: "missing_category"' in card
    assert 'acknowledged: "show"' in card
    assert 'show_images: false, show_brand: false, show_quantity: false' in card
    assert 'data-quantity-change=' in card
    assert 'data-list-search' not in card
    assert 'data-label-input' in card
    assert 'data-category-options' in card
    assert 'this._config.acknowledged === "hide"' in card
    assert 'default: true' in card
    assert "_refreshSearchView()" in card
    search_method = _card_method(card, "_searchProducts")
    assert "this._refreshSearchView();" in search_method
    assert "this._render(); return" not in search_method
    assert "clearTimeout(this._searchTimer)" in search_method
    assert "setTimeout(async () =>" in search_method
    assert "this._inputValue === value" in search_method
    assert "largeImageUrl(product.image_url)" in card
    assert "category-option-icon" in card
    assert 'entry.id === draft.category_id' in card
    assert 'left.name.localeCompare(right.name, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base", numeric: true })' in card
    assert 'duplicateNames.get(category.name.toLocaleLowerCase()) > 1' in card
    assert 'width:100%;height:auto;max-height:calc(100vh - 130px)' in card
    assert '{ value: "controls", label: "Zwischen Plus und Minus" }' in card
    assert '{ value: "never", label: "Nie öffnen – neue Artikel in Allgemein" }' in card
    assert 'item.product_id === product.id' in card
    assert '!item.product_id && candidates.includes' in card
    assert 'this._config.add_dialog_behavior === "always"' in card
    assert 'this._config.add_dialog_behavior === "never"' in card
    assert 'this._openIncrementDialog(existing' in card
    assert 'data-d-increment' in card
    assert 'data-edit-existing' in card
    assert 'category && !category.dynamic ? category.id : null' in card
    assert 'category?.dynamic ? category.name : null' in card
    assert 'Mehrere Produkte heißen' in card
    assert 'data-product-choice' in card
    assert 'product.brand, product.package_quantity' in card
    assert 'data-clear-input' in card
    assert 'data-clear-input' in inventory_card
    assert 'data-clear-input' in todo_card
    assert 'search: raw, limit: 100, offset: 0' in card
    assert '_availableCategories()' in card
    assert 'if (this._expandedView && previousCard?.scrollTop > 0) this._expandedScrollTop = previousCard.scrollTop' in card
    assert 'this._rememberExpandedScroll(item.id)' in card
    assert 'offset: row.getBoundingClientRect().top - card.getBoundingClientRect().top' in card
    assert 'card.scrollTop += offset - anchor.offset' in card
    assert 'align(true);' in card
    assert 'if (restoreScrollTop) card.scrollTop = scrollTop' in card
    assert 'this._expandedScrollTimer = setTimeout' in card
    assert 'haListManagerShoppingCardText("ui.item_removed_from_list", {p0:(item.name)}, this._hass)' in card
    assert '_canPatchQuantityRefresh(' in card
    assert '_patchQuantityItems(items)' in card
    assert 'name.firstChild.textContent = this._displayName(item)' in card
    assert 'this._setNotificationStatus((delta > 0 ? haListManagerShoppingCardText("shopping.quantity_increased_full", {item: item.name, previous, next}, this._hass) : haListManagerShoppingCardText("shopping.quantity_decreased_full", {item: item.name, previous, next}, this._hass)), item.id)' in card
    assert 'anchor.getBoundingClientRect().top - anchorTop' in card
    assert 'data-status-region' in card
    assert '.sort(compareNames)' in card
    assert 'Number(a.completed) - Number(b.completed) || compareNames(a, b)' in card
    assert 'element.getAttribute(focusAttribute) === focusValue' in card
    assert 'new ResizeObserver(this._onExpandedViewResize)' in card
    assert 'const collapsed = !this._expandedView && (largeOnly || (collapsible && this._listCollapsed()))' in card
    assert 'this._oldOverflow = this._expandedPageOverflow ?? this._oldOverflow' in card
    assert 'class="title-icon title-expand-toggle" style="${titleIconStyle}" data-toggle-expanded-view' in card
    assert 'class="title-icon title-static-icon" style="${titleIconStyle}" aria-hidden="true"' in card
    assert 'class="card-title-copy" data-toggle-list' in card
    assert '{ value: "card_and_large", label: "In Karte und Großansicht" }' in card
    assert '{ value: "card_only", label: "Nur in der Karte" }' in card
    assert '{ value: "large_only", label: "Nur in Großansicht" }' in card
    assert 'querySelectorAll("[data-toggle-expanded-view]")' in card
    assert 'this._expandedViewWasCollapsed || this._config.content_display === "large_only"' in card
    assert "mit Esc schließt du sie ebenfalls" in card
    compact_card_css = card.split('@container(max-width:600px)', 1)[1].split('@media(max-width:600px)', 1)[0]
    for rule in [
        'ha-card,.list-collapsed{padding:10px}',
        '.option-row button{display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;min-height:38px;padding:0;gap:0;border-radius:9px}',
        '.option-row button>span{display:none}',
        '.card-title-copy>span{font-size:21px}',
    ]:
        assert rule in compact_card_css
    assert '.field-grid' not in compact_card_css
    assert '@media(max-width:600px){.bring-detail-fields,.transfer-product-top,.ean-lookup-row{grid-template-columns:1fr}' in card
    assert '.view-mobile .field-grid' not in card
    assert ".card-title-toggle>span{font-size:21px}" not in card
    assert 'Bei „Nur in Großansicht“ hat diese Einstellung keine Wirkung.' in card
    assert 'this._subscribePromise = null' in card
    assert 'this._unsubscribe || this._subscribePromise' in card
    assert 'category_sort: "alphabetical"' in card
    assert '{ value: "position", label: "Manuelle Position" }' in card
    assert 'this._compareCategories(a.category, b.category)' in card
    assert 'category?.uncategorized' in card
    assert 'data-increment-plus' in card
    assert 'input.dispatchEvent(new Event("input", { bubbles: true }))' in card
    assert 'data-dialog-quantity="-1"' in card
    assert 'data-dialog-quantity="1"' in card
    assert 'Math.max(1, Number.parseInt(draft.quantity, 10) || 1)' in card
    assert 'Bei „Zwischen Plus und Minus“ wird die Anzahl unabhängig von dieser Einstellung immer angezeigt.' in card
    assert '{ value: "dynamic_global_list", label: "Dynamisch → Global → Diese Liste" }' in card
    assert '{ value: "dynamic_list_global", label: "Dynamisch → Diese Liste → Global" }' in card
    assert 'show_labels: true' in card
    assert 'this._config.show_labels && item.labels?.length' in card
    assert 'show_chips: true' in card
    assert 'category_chip_layout: "none"' in card
    assert '{ value: "stacked", label: "Untereinander" }' in card
    assert '{ value: "wrap", label: "Nebeneinander" }' in card
    assert '{ value: "compact", label: "Nebeneinander (kompakt)" }' in card
    assert 'category_chip_colors: true' in card
    assert 'name: "category_chip_colors"' in card
    assert 'show_important_chips: true' in card
    assert 'important_chip_color_rgb: [244, 67, 54]' in card
    assert 'type: `${HA_LM_API}/chips/important/list`' in card
    assert 'type: `${HA_LM_API}/chips/important/set`' in card
    assert "_categoryProductChips()" in card
    assert "category-product:${product.id}" in card
    assert "chip.category || this._chipCategories.get(chip.id)" in card
    assert 'show_chip_popup_button: true' in card
    assert 'show_browser_chips: true' in card
    assert 'browser_chips_for_products: false' in card
    assert 'allow_save_browser_chips: true' in card
    assert 'filter_chips: true' in card
    assert 'chips_limit: 8' in card
    assert 'number: { min: 0, max: 50' in card
    assert 'chip_color_mode: "scope_fallback"' in card
    assert 'data-toggle-chips' in card
    assert 'data-open-chip-dialog' in card
    assert 'data-chip-category' in card
    assert 'categories/chips/resolve' in card
    assert 'data-dialog-chip' in card
    assert 'this._config.filter_chips !== false' in card
    assert 'this._config.show_chips === false' in card
    assert 'chip_color_global_rgb' in card
    assert 'chip_color_list_type_rgb' in card
    assert 'chip_color_list_rgb' in card
    assert 'chip_color_browser_rgb' in card
    assert 'data-save-browser-chip' in card
    assert 'data-delete-all-browser-chips' in card
    assert 'button[data-close-browser-chip-menu]' in card
    assert 'querySelectorAll("[data-close-browser-chip-menu]")' not in card
    assert 'scope: "list", list_type: null, list_id: this._listId()' in card
    assert 'a.name.localeCompare(b.name' in card
    assert 'Das Ausblenden entfernt keine Zuordnungen.' in card
    assert 'Das Hinzufügen mit Enter bleibt weiterhin möglich.' in card
    assert 'await this._updateExistingQuantity(existing, quantity)' in card
    assert 'entry.id === item.product_id' in card


def test_inventory_card_supports_chips_without_dishes() -> None:
    card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-inventory-card.js")

    assert 'label: "Chips"' in card
    assert 'show_chips: true' in card
    assert 'show_important_chips: true' in card
    assert 'show_browser_chips: true' in card
    assert 'browser_chips_for_products: false' in card
    assert 'category_chip_layout: "none"' in card
    assert 'type: `${HA_LM_API}/chips/important/list`' in card
    assert 'type: `${HA_LM_API}/chips/important/set`' in card
    assert 'categories/chips/resolve' in card
    assert 'data-open-chip-dialog' in card
    assert 'data-save-browser-chip' in card
    assert 'chip_color_list_type_rgb' in card
    assert 'scope: "list", list_type: null, list_id: this._listId()' in card
    assert 'addEventListener("mousedown", async (event)' in card
    assert 'await this._performInputAction();' in card
    assert '_setInventoryActionStatus(result.entry, previous' in card
    assert 'haListManagerInventoryCardText("ui.stock_increased_result", {p0:(name), p1:(previous), p2:(next)}, this._hass)' in card
    assert 'class="inventory-action-status" role="status"' in card
    assert "Gerichte" not in card
    assert "dishes/" not in card


def test_recent_card_polish_is_wired_consistently() -> None:
    shopping = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")
    inventory = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-inventory-card.js")
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")
    history = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-history-card.js")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert "_isPanelDashboardView" in shopping
    assert "_isPanelDashboardView" in inventory
    assert 'node.matches?.("hui-panel-view")' in shopping
    assert "show_clear_completed_button" in shopping
    assert "data-clear-completed" in shopping
    assert 'option_row_position: "bottom"' in shopping
    assert 'show_category_toggle_button: true' in shopping
    assert 'data-toggle-categories' in shopping
    assert '<main>${content}</main>${this._config.option_row_position === "bottom" ? options : ""}' in shopping
    assert 'product ? "Packungsmenge" : "Menge"' in shopping
    assert "Gesamtmenge:" in shopping
    assert "Fest aus der Produktdatenbank übernommen" in shopping
    assert 'class="fixed-product-amount"' in shopping
    assert ".tandoor-ingredient-main{justify-self:start;width:fit-content;max-width:100%;touch-action:pan-y}" in shopping
    assert ".tandoor-option{justify-self:start;width:fit-content;max-width:100%;padding-left:30px;touch-action:pan-y}" in shopping
    assert "this._setInventoryActionStatus(result.entry, previous" in inventory
    for card, selector in [(shopping, ".card-title"), (inventory, ".inventory-header"), (todo, ".title")]:
        header_rules = [set(rule.split(";")) for rule in re.findall(rf"{re.escape(selector)}\{{([^{{}}]*)\}}", card)]
        for height, margin in [(50, "0 0 8px"), (54, "0 0 4px")]:
            assert any({f"height:{height}px", f"min-height:{height}px", f"margin:{margin}"} <= rule for rule in header_rules)
        assert f".list-collapsed {selector}{{margin:0}}" in card
    assert 'class="${activeFilter !== "all" ? "active" : ""}" data-open-filter' in todo
    for index in range(1, 6):
        assert f'value: "entity_{index}"' in history
    assert "_formatValue(value)" in history
    assert "https://github.com/TandoorRecipes/recipes" in panel
    assert ".settings-card+.settings-card{margin-top:16px}" in panel


def test_backend_notifications_are_central_and_reusable() -> None:
    database = _localized_source(INTEGRATION / "database.py")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    notifications = _localized_source(INTEGRATION / "notifications.py")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")

    assert "CREATE TABLE notification_profiles" in database
    assert "CREATE TABLE notification_profiles" in database
    assert "CREATE TABLE list_notification_profiles" in database
    for command in [
        "notifications/profiles/list", "notifications/profiles/create",
        "notifications/profiles/update", "notifications/profiles/delete",
        "notifications/assignments/list", "notifications/assignments/set",
        "notifications/test", "notifications/send_list",
    ]:
        assert f'f"{{DOMAIN}}/{command}"' in websocket
    assert '"notify", "send_message"' in notifications
    assert '"notify", "persistent_notification"' in notifications
    assert '"clickAction": profile.click_url' in notifications
    assert '"ntfy", "publish"' in notifications
    assert "EVENT_ITEM_MUTATED" in notifications
    assert "notification_pending_batches" in database
    assert 'supports_quantity_events = list_row["list_type"] != "todo"' in database
    assert '"notify_on_increase": supports_quantity_events' in database
    assert '"notify_on_decrease": supports_quantity_events' in database
    assert 'automatic_mode' in database
    assert 'delay_seconds' in panel
    assert '"notifications", "Benachrichtigungen"' in panel
    assert "data-test-notification" in panel
    assert "data-save-notification-assignments" in panel
    assert "data-notification-tab" in panel
    assert 'list.list_type !== "inventory"' in panel
    assert 'const supportsQuantityEvents = list.list_type !== "todo"' in panel
    assert '...(supportsQuantityEvents ? [["increase", "Anzahl erhöht"], ["decrease", "Anzahl verringert"]] : [])' in panel
    assert 'notify_on_increase: supportsQuantityEvents && eventEnabled("increase")' in panel
    assert "data-notification-target-picker" in panel
    assert "secondary: entity.entity_id" in panel
    assert '!["notify", "send_message", "persistent_notification", "ntfy"].includes(service)' in panel
    assert "notification-message-fields" in panel
    assert "data-send-list" in card
    assert "show_share_button" in card
    assert "data-confirm-share" in card
    assert "data-share-profile" in card


def test_todo_template_editor_uses_colored_comboboxes_and_aligned_recurrence() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert 'data-chip-category-option=' in panel
    assert 'data-chip-label-option=' in panel
    assert '--label-color:' in panel
    assert 'class="label-option-icon"' in panel
    assert 'class="field-grid todo-template-recurrence"' in panel
    assert '.todo-template-recurrence{grid-template-columns:minmax(180px,1fr) minmax(180px,1fr)' in panel


def test_frontend_todo_template_separates_template_and_task_names() -> None:
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert 'data-template-name' in todo
    assert 'data-template-item-name' in todo
    assert 'item_name: draft.item_name.trim()' in todo
    assert 'add_mode: "edit", due_mode: "none", due_time: null' in todo
    assert "_templateRuleFromItem" not in todo


def test_todo_auto_view_matches_other_backend_cards() -> None:
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert "_isPanelDashboardView()" in todo
    assert ': (this._isPanelDashboardView() ? "panel" : "auto")' in todo
    assert 'class="view-${view} chips-position-${esc(this._config.chips_position || "auto")}' in todo


def test_todo_editor_explains_warning_times_and_orders_templates_before_them() -> None:
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    assert todo.index('label: "Vorlagen"') < todo.index('label: "Vorwarnzeiten"')
    assert todo.index('label: "Vorlagen"') > todo.index('label: "Aktionen"')
    for example in ["60 = 1 Stunde", "1.440 = 1 Tag", "10.080 = 1 Woche", "60 Sekunden = 1 Minute"]:
        assert example in todo


def test_todo_template_dialog_summarizes_inherited_values() -> None:
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")

    for text in ["Diese Angaben werden übernommen", "Kategorie", "Labels", "Wiederholung", "Keine – wird nicht aus dem konkreten Datum übernommen", "später im Backend"]:
        assert text in todo


def test_backend_todo_due_rules_are_explained_and_preserve_scroll() -> None:
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    for text in ["Keine Fälligkeit", "Am Tag des Anklickens", "Am folgenden Tag", "Nächster gewählter Wochentag", "nächsten kommenden Montag"]:
        assert text in panel
    assert 'const scrollTop = event.target.closest("[data-dialog-panel]")?.scrollTop || 0' in panel
    assert "if (panel) panel.scrollTop = scrollTop" in panel


def test_new_todo_templates_default_to_edit_and_week_starts_on_monday() -> None:
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    assert 'add_mode: "edit", due_mode: "none"' in todo
    assert 'chip.template_data?.add_mode || "edit"' in todo
    assert 'add_mode: template.add_mode || "edit"' in panel
    weekdays = '[["Montag", 1], ["Dienstag", 2], ["Mittwoch", 3], ["Donnerstag", 4], ["Freitag", 5], ["Samstag", 6], ["Sonntag", 0]]'
    assert weekdays in panel


def test_todo_templates_support_importance_popup_and_category_groups() -> None:
    todo = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-todo-card.js")
    panel = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")

    for setting in ["show_chip_popup_button", "filter_chips", "show_important_chips", "category_chip_layout", "category_chip_colors", "important_chip_color_rgb"]:
        assert f'name: "{setting}"' in todo
    for marker in ["chips/important/list", "chips/important/set", "data-open-chip-dialog", "data-toggle-important-template", "_chipGroupsHtml", "_filteredChips"]:
        assert marker in todo
    assert '["chips", "Chips & Vorlagen", "mdi:gesture-tap-button"]' in panel
