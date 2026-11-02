"""Real SQLite counterpart of the card's non-cascading product-save flow."""
from pathlib import Path
import runpy
import tempfile
import types

_helpers = runpy.run_path(str(Path(__file__).with_name('test_scopes.py')))


def test_product_default_save_only_moves_the_explicitly_updated_shopping_item():
    module = _helpers['_database_module']()
    for scope in ('global', 'list_type', 'list'):
        for move in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                db = module.HaListManagerDatabase(types.SimpleNamespace(), Path(directory) / 'items.db')
                db._initialize()
                shopping = _helpers['_list'](db, 'Groceries')
                other = _helpers['_list'](db, 'Other groceries')

                def category(name, kind, list_id=None):
                    return db._create_category(name, kind, 'shopping' if kind == 'list_type' else None,
                                               list_id, None, None, None)

                original = [category('Global old', 'global'), category('Type old', 'list_type'),
                            category('Local old', 'list', shopping.id), category('Other local', 'list', other.id)]
                target = category('New default', scope, shopping.id if scope == 'list' else None)
                product = db._create_product(None, 'Milk', None, None, '1 l', None, None, 'manual', [],
                                             [entry.id for entry in original])
                current = db._create_item(shopping.id, 'Milk', None, 1, original[2].id, None, None, [], product.id, None)
                sibling = db._create_item(shopping.id, 'Milk again', None, 2, original[2].id, None, None, [], product.id, None)
                elsewhere = db._create_item(other.id, 'Milk elsewhere', None, 3, original[3].id, None, None, [], product.id, None)
                before = [db._get_item(item.id) for item in (current, sibling, elsewhere)]
                retained = [entry.id for entry in original if entry.scope != scope or
                            (scope == 'list' and entry.list_id != shopping.id)]
                updated = db._update_product(product.id, None, 'Milk', None, None, '1 l', None, None, [], retained + [target.id])
                assert {entry.category_id for entry in updated.category_assignments} == set(retained + [target.id])
                # Saving product defaults alone must not invoke list-wide category synchronization.
                assert [db._get_item(item.id) for item in (current, sibling, elsewhere)] == before
                db._update_item(current.id, 'Milk', None, 1, target.id if move else original[2].id,
                                None, None, False, [], product.id, None)
                assert db._get_item(current.id).category_id == (target.id if move else original[2].id)
                assert db._get_item(sibling.id) == before[1]
                assert db._get_item(elsewhere.id) == before[2]
