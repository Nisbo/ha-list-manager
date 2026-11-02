"""Each concurrent scan must retain its own inventory booking."""
import asyncio
import importlib
import sys
from types import ModuleType, SimpleNamespace

import pytest

from test_list_scripts import _fixture, _manager


@pytest.mark.parametrize("action", ["add", "register", "correct"])
def test_simultaneous_first_assignments_preserve_each_booking(monkeypatch, action):
    async def scenario(db, inventory):
        hass, _, package = _manager(db)
        facts = ModuleType(package + ".open_facts")
        facts.OpenFactsLookupError = RuntimeError
        async def unused(*_args):
            raise AssertionError("Known products must not query Open Food Facts")
        facts.async_lookup_open_facts = unused
        monkeypatch.setitem(sys.modules, facts.__name__, facts)
        monkeypatch.delitem(sys.modules, package + ".scanner", raising=False)
        scanner_module = importlib.import_module(package + ".scanner")
        scanner = scanner_module.ScannerManager(hass, db, SimpleNamespace(options={}))
        product = db._create_product("8715700117140", "Ketchup", None, "Heinz", "425 g", None, None, "manual", [], [])
        original_list = db.async_list_inventory
        reads = 0
        both_read = asyncio.Event()
        async def synchronized_initial_read(list_id):
            nonlocal reads
            rows = await original_list(list_id)
            if reads < 2:
                reads += 1
                if reads == 2:
                    both_read.set()
                await both_read.wait()
            return rows
        monkeypatch.setattr(db, "async_list_inventory", synchronized_initial_read)
        results = await asyncio.gather(*[
            scanner.async_process_scan(ean=product.ean, list_id=inventory.id,
                action=action, quantity=amount, corrected_stock=amount if action == "correct" else None,
                source="simulation", offer_to_card=False)
            for amount in (2, 3)
        ])
        entries = db._list_inventory(inventory.id)
        added = next(row for row in entries if row.product_id == product.id)
        if action == "add":
            assert added.stock == 5
        elif action == "register":
            assert added.stock == 0
        else:
            assert {result["history"]["stock_after"] for result in results} == {2, 3}
            assert added.stock in {2, 3}
        assert all(result["history"]["status"] == "success" for result in results)
        assert sorted(result["history"]["quantity"] for result in results) == [2, 3]
    directory, db, _, inventory, _ = _fixture()
    with directory:
        asyncio.run(scenario(db, inventory))
