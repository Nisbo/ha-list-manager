"""Interpret Bring's combined quantity and details field."""

from __future__ import annotations

import re

_COUNT_ONLY = re.compile(r"^\s*(\d+)\s*$")
_COUNT_WITH_DETAILS = re.compile(r"^\s*(\d+)\s*[x×]\s*(.+)$", re.IGNORECASE)


def split_bring_description(description: str | None) -> tuple[int, str | None]:
    """Split Bring's one text field into item count and user-visible details."""
    text = str(description or "").strip()
    if not text:
        return 1, None
    count_only = _COUNT_ONLY.fullmatch(text)
    if count_only:
        return max(1, int(count_only.group(1))), None
    counted = _COUNT_WITH_DETAILS.fullmatch(text)
    if counted:
        return max(1, int(counted.group(1))), counted.group(2).strip() or None
    return 1, text


def parse_bring_quantity(description: str | None) -> int:
    """Return a count only when Bring's text expresses one unambiguously."""
    return split_bring_description(description)[0]


def parse_bring_details(description: str | None) -> str | None:
    """Return the measurement or free text without an item-count prefix."""
    return split_bring_description(description)[1]


def format_bring_description(
    quantity: int, description: str | None
) -> str | None:
    """Create a Bring-readable count plus optional measurement/free text."""
    quantity = max(1, int(quantity))
    details = parse_bring_details(description)
    if details:
        return details if quantity == 1 else f"{quantity} x {details}"
    return None if quantity == 1 else str(quantity)
