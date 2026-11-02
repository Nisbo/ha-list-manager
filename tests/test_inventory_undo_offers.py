"""Real SQLite checks for reversible bookings and independent offer markers."""
import runpy
import sqlite3
import time
from pathlib import Path

_fixture = runpy.run_path(str(Path(__file__).with_name('test_inventory_restock.py')))['_fixture']


def test_undo_stock_and_transferred_amount_preserves_existing_shopping_quantity():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._create_item(shopping.id, 'Milch', None, 3, None, None, None, [], None, None)
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, 'fixed', 6)
        result = db._adjust_inventory_with_restock(entry.id, -1)
        assert result['transfer']['quantity'] == 6
        undone = db._undo_inventory_booking(result['undo_token'], True)
        assert undone['entry']['stock'] == 2
        assert db._list_items(shopping.id)[0].quantity == 3
        with db._connect() as con:
            assert con.execute('SELECT COUNT(*) FROM inventory_restock_transfers').fetchone()[0] == 0
        try:
            db._undo_inventory_booking(result['undo_token'], True)
        except ValueError:
            pass
        else:
            raise AssertionError('The same booking was undone twice')


def test_undo_stock_only_keeps_order_history_and_latch():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, 'fixed', 6)
        result = db._adjust_inventory_with_restock(entry.id, -1)
        original = db._preview_inventory_restock(inventory.id)['items'][0]
        undone = db._undo_inventory_booking(result['undo_token'], False)
        assert undone['transfer_kept'] and undone['entry']['stock'] == 2
        assert db._list_items(shopping.id)[0].quantity == 6
        with db._connect() as con:
            assert con.execute('SELECT latched FROM inventory_restock_state').fetchone()[0] == 1
            assert con.execute('SELECT transferred_at FROM inventory_restock_transfers').fetchone()[0] == original['last_automatic_transfer']['transferred_at']


def test_undo_does_not_overwrite_newer_inventory_changes():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        first = db._adjust_inventory_with_restock(entry.id, -1)
        db._adjust_inventory_with_restock(entry.id, 3)
        try:
            db._undo_inventory_booking(first['undo_token'])
        except ValueError as error:
            assert 'inzwischen' in str(error)
        else:
            raise AssertionError('A newer booking was overwritten')
        assert db._list_inventory(inventory.id)[0].stock == 4


def test_changed_shopping_position_allows_only_stock_undo():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, 'one_to_one', 1)
        result = db._adjust_inventory_with_restock(entry.id, -1)
        with db._connect() as con:
            con.execute('UPDATE list_items SET quantity=8 WHERE id=?', (result['transfer']['item_id'],))
        try:
            db._undo_inventory_booking(result['undo_token'], True)
        except ValueError as error:
            assert 'Einkaufsposition' in str(error)
        else:
            raise AssertionError('An edited shopping position was overwritten')
        assert db._list_inventory(inventory.id)[0].stock == 1
        db._undo_inventory_booking(result['undo_token'], False)
        assert db._list_items(shopping.id)[0].quantity == 8


def test_undo_expires_and_new_entry_undo_keeps_product():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._undo_inventory_booking(entry.undo_token)
        assert db._list_inventory(inventory.id) == []
        with db._connect() as con:
            assert con.execute('SELECT id FROM products WHERE id=?', (entry.product_id,)).fetchone()[0] == entry.product_id
        new = db._create_inventory_entry(inventory.id, entry.product_id, 3, None, None, None, False)
        result = db._adjust_inventory_with_restock(new.id, 2)
        remaining = db._inventory_bookings[result['undo_token']]['expires'] - time.monotonic()
        assert 59 < remaining <= 60, remaining
        db._inventory_bookings[result['undo_token']]['expires'] = 0
        try:
            db._undo_inventory_booking(result['undo_token'])
        except ValueError as error:
            assert '60 Sekunden' in str(error)
        else:
            raise AssertionError('Expired token accepted')


def test_correction_undo_restores_only_stock_not_settings():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        changed = db._update_inventory_entry(entry.id, 7, 4, None, 'Neu', False)
        undone = db._undo_inventory_booking(changed.undo_token)
        assert undone['entry']['stock'] == 2
        assert undone['entry']['minimum_stock'] == 4
        assert undone['entry']['category_name'] == 'Neu'


def test_undo_group_does_not_overwrite_another_member_booking():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        product = db._create_product(None, 'Hafer', None, None, None, None, None, 'manual', [], [])
        second = db._create_inventory_entry(inventory.id, product.id, 2, None, None, None, False)
        db._create_inventory_group(inventory.id, 'Milchgruppe', 4, None, None, [entry.id, second.id])
        first = db._adjust_inventory_with_restock(entry.id, -1)
        db._adjust_inventory_with_restock(second.id, -1)
        try:
            db._undo_inventory_booking(first['undo_token'])
        except ValueError:
            pass
        else:
            raise AssertionError('A changed group must invalidate an undo')


def test_offer_marker_is_independent_of_labels_and_survives_ordinary_updates():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        item = db._create_item(shopping.id, 'Milch', None, 1, None, None, None, [], None, None, offer_only=True)
        assert item.offer_only and not item.labels
        assert db._list_items(shopping.id)[0].offer_only
        updated = db._update_item(item.id, item.name, None, 3, None, None, None, False, [], None, None)
        assert updated.offer_only
        updated = db._update_item(item.id, item.name, None, 3, None, None, None, False, [], None, None, offer_only=False)
        assert not updated.offer_only
        todo = db._create_list('Aufgaben', 'todo', None, 'local', None, 'specific', True, True, True)
        try:
            db._create_item(todo.id, 'Aufgabe', None, 1, None, None, None, [], None, None, offer_only=True)
        except ValueError:
            pass
        else:
            raise AssertionError('To-do item accepted a product offer flag')


def test_schema_one_reopen_preserves_offer_markers_and_other_item_fields():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        item = db._create_item(shopping.id, 'Milch', None, 4, None, None, None, [], None, None)
        marked = db._create_item(shopping.id, 'Brot', None, 2, None, None, None, [], None, None, offer_only=True)
        db._initialize()
        restored = db._get_item(item.id)
        assert restored.quantity == 4 and not restored.offer_only
        assert db._get_item(marked.id).offer_only and db._get_item(marked.id).quantity == 2
        assert db._schema_version() == 1
        with db._connect() as con:
            assert con.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'


def test_undo_restores_previous_last_transfer_instead_of_erasing_it():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, 'continuous', 1)
        first = db._adjust_inventory_with_restock(entry.id, -1)
        original = db._preview_inventory_restock(inventory.id)['items'][0]['last_automatic_transfer']
        second = db._adjust_inventory_with_restock(entry.id, -1)
        db._undo_inventory_booking(second['undo_token'], True)
        row = db._preview_inventory_restock(inventory.id)['items'][0]
        assert row['last_automatic_transfer'] == original
        assert db._list_items(shopping.id)[0].quantity == 1


def test_undo_deletes_only_new_shopping_position_and_rolls_back_on_failure():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, 'fixed', 6)
        booked = db._adjust_inventory_with_restock(entry.id, -1)
        with db._connect() as con:
            con.executescript("CREATE TRIGGER fail_undo BEFORE UPDATE OF stock ON inventory_entries BEGIN SELECT RAISE(ABORT, 'test failure'); END;")
        try:
            db._undo_inventory_booking(booked['undo_token'], True)
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError('Injected undo failure did not abort')
        assert db._list_inventory(inventory.id)[0].stock == 1
        assert db._list_items(shopping.id)[0].quantity == 6
        with db._connect() as con:
            con.execute('DROP TRIGGER fail_undo')
        db._undo_inventory_booking(booked['undo_token'], True)
        assert db._list_items(shopping.id) == []
        assert db._list_inventory(inventory.id)[0].stock == 2
