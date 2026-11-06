"""Data models for HA List Manager."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ListRecord:
    """A backend-managed list."""

    id: str
    name: str
    list_type: str
    provider: str
    external_entity_id: str | None
    icon: str | None
    label_conflict_policy: str
    use_global_categories: bool
    use_type_categories: bool
    use_global_labels: bool
    use_type_labels: bool
    use_list_labels: bool
    use_global_chips: bool
    use_type_chips: bool
    use_dishes: bool
    use_tandoor: bool
    tandoor_skip_small_units: bool
    tandoor_include_ingredients: bool
    tandoor_excluded_units: str
    tandoor_result_limit: int
    enabled: bool
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        result = asdict(self)
        # Bring is a shopping list semantically, but is presented as its own
        # list type so the administration UI can make the external ownership
        # and its different category behavior explicit.
        if self.provider == "bring":
            result["list_type"] = "bring"
        return result


@dataclass(frozen=True, slots=True)
class ListItemRecord:
    """An entry belonging to a backend-managed list."""

    id: str
    list_id: str
    product_id: str | None
    external_uid: str | None
    name: str
    description: str | None
    quantity: int
    category_id: str | None
    category: str | None
    due_at: str | None
    recurrence_interval: int | None
    recurrence_unit: str | None
    completed: bool
    position: int
    created_at: str
    updated_at: str
    offer_only: bool = False
    inventory_source_type: str | None = None
    inventory_source_id: str | None = None
    labels: tuple["LabelRecord", ...] = ()

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ProductRecord:
    """A product stored independently from lists and inventory."""

    id: str
    ean: str | None
    name: str
    original_name: str | None
    brand: str | None
    package_quantity: str | None
    category: str | None
    image_url: str | None
    source: str
    created_at: str
    updated_at: str
    labels: tuple["LabelRecord", ...] = ()
    category_assignments: tuple["ProductCategoryAssignmentRecord", ...] = ()

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class CategoryRecord:
    """A permanent category shared globally, by type, or by one list."""

    id: str
    name: str
    scope: str
    list_type: str | None
    list_id: str | None
    icon: str | None
    color: str | None
    position: int
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ProductCategoryAssignmentRecord:
    """One context-specific category assignment for a product."""

    product_id: str
    category_id: str
    scope: str
    list_type: str | None
    list_id: str | None
    category: CategoryRecord

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class LabelRecord:
    """A reusable marker that can be assigned multiple times."""

    id: str
    name: str
    icon: str | None
    color: str | None
    scope: str
    list_type: str | None
    list_id: str | None
    created_at: str
    updated_at: str
    product_count: int = 0
    item_count: int = 0

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ChipRecord:
    """A reusable quick-add action offered for one or more lists."""

    id: str
    name: str
    priority_name: str
    chip_kind: str
    icon: str | None
    color: str | None
    scope: str
    list_type: str | None
    list_id: str | None
    product_id: str | None
    product_name: str | None
    template_data: dict[str, Any] | None
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class DishItemRecord:
    """One ordered product or free-text ingredient of a dish."""

    id: str
    dish_id: str
    name: str
    product_id: str | None
    product_name: str | None
    product_brand: str | None
    product_package_quantity: str | None
    product_ean: str | None
    quantity: int
    position: int

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class DishRecord:
    """A central reusable group of shopping-list ingredients."""

    id: str
    name: str
    normalized_name: str
    color: str | None
    created_at: str
    updated_at: str
    items: tuple[DishItemRecord, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class InventoryRecord:
    """A product assigned to one backend inventory list."""

    id: str
    list_id: str
    product_id: str
    stock: int
    minimum_stock: int | None
    restock_quantity: int
    restock_mode: str | None
    category_id: str | None
    category_name: str | None
    category: CategoryRecord | None
    hidden: bool
    position: int
    created_at: str
    updated_at: str
    product: ProductRecord
    undo_token: str | None = None

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class InventoryGroupRecord:
    """A list-local group of interchangeable inventory variants."""

    id: str
    list_id: str
    name: str
    minimum_stock: int | None
    restock_quantity: int
    restock_mode: str | None
    category_id: str | None
    category_name: str | None
    category: CategoryRecord | None
    position: int
    created_at: str
    updated_at: str
    member_ids: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        data = asdict(self)
        data["member_ids"] = list(self.member_ids)
        return data


@dataclass(frozen=True, slots=True)
class InventoryRestockSettingsRecord:
    """Automatic shopping-list transfer settings for one inventory."""

    list_id: str
    target_list_id: str | None
    enabled: bool
    mode: str | None
    fixed_quantity: int | None
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ScannerRecord:
    """A barcode scanner known to the backend."""

    id: str
    name: str
    address: str
    enabled: bool
    routing: str
    list_id: str | None
    action: str | None
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ScannerTargetRecord:
    """The list and mode currently receiving scanner events."""

    list_id: str
    action: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class NotificationProfileRecord:
    """A reusable Home Assistant notification destination."""

    id: str
    name: str
    provider: str
    target: str
    title: str | None
    click_url: str | None
    message_format: str
    enabled: bool
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ListNotificationAssignmentRecord:
    """Connect a list to one reusable notification destination."""

    list_id: str
    profile_id: str
    manual_enabled: bool
    automatic_mode: str
    delay_seconds: int
    notify_on_add: bool
    notify_on_increase: bool
    notify_on_decrease: bool
    notify_on_edit: bool
    notify_on_complete: bool
    notify_on_reopen: bool
    notify_on_delete: bool
    profile: NotificationProfileRecord

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class NotificationPendingBatchRecord:
    """A durable group of list changes waiting for delivery."""

    list_id: str
    profile_id: str
    due_at: str
    changes_json: str
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ScanHistoryRecord:
    """One processed or rejected barcode scan."""

    id: str
    scanned_at: str
    scanner_id: str | None
    scanner_name: str | None
    scanner_address: str | None
    source: str
    ean: str
    action: str | None
    list_id: str | None
    product_id: str | None
    product_name: str | None
    inventory_entry_id: str | None
    quantity: int
    stock_before: int | None
    stock_after: int | None
    status: str
    message: str | None

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class TrackedEntityRecord:
    """One Home Assistant entity selected for independent history storage."""

    entity_id: str
    registry_entry_id: str | None
    enabled: bool
    created_at: str
    updated_at: str
    sample_count: int = 0
    hidden_count: int = 0
    first_recorded_at: str | None = None
    last_recorded_at: str | None = None
    ignore_unavailable: bool = True
    unavailable_count: int = 0

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


@dataclass(frozen=True, slots=True)
class EntityStateRecord:
    """An exact state-machine snapshot stored outside Home Assistant Recorder."""

    id: int
    entity_id: str
    state: str
    attributes: dict[str, Any]
    last_changed: str
    last_updated: str
    last_reported: str | None
    recorded_at: str
    source: str = "live"
    original_source: str | None = None
    modified_at: str | None = None
    original: dict[str, Any] | None = None
    hidden: bool = False

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)
