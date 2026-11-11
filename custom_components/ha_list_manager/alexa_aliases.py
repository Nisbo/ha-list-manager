"""Bounded, exact aliases applied after Alexa quantity and unit recognition."""
from __future__ import annotations

from typing import Any
import unicodedata

from .alexa_parser import AlexaParseError


def _key(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def validate_aliases(value: Any) -> list[dict[str, Any]]:
    """Validate configuration without requiring deleted product targets to exist."""
    if not isinstance(value, list) or len(value) > 200:
        raise AlexaParseError("alexa.aliases_invalid")
    result, seen = [], set()
    count = 0
    for rule in value:
        if not isinstance(rule, dict) or rule.get("target_type") not in ("product", "name"):
            raise AlexaParseError("alexa.aliases_invalid")
        target_field = "product_id" if rule["target_type"] == "product" else "replacement"
        target = rule.get(target_field)
        expressions = rule.get("expressions")
        if (set(rule) != {"expressions", "target_type", target_field}
                or not isinstance(target, str) or not target.strip() or len(target) > 200
                or not isinstance(expressions, list) or not 1 <= len(expressions) <= 20):
            raise AlexaParseError("alexa.aliases_invalid")
        cleaned = []
        for expression in expressions:
            if not isinstance(expression, str) or not expression.strip() or len(expression) > 200:
                raise AlexaParseError("alexa.aliases_invalid")
            normalized = _key(expression)
            if normalized in seen:
                raise AlexaParseError("alexa.alias_duplicate", expression=expression.strip())
            seen.add(normalized)
            cleaned.append(" ".join(expression.split()))
        count += len(cleaned)
        if count > 1000:
            raise AlexaParseError("alexa.aliases_invalid")
        result.append({"expressions": cleaned, "target_type": rule["target_type"],
                       target_field: " ".join(target.split())})
    return result


class AlexaAliases:
    """Resolve one complete name once; replacements never run through aliases again."""

    def __init__(self, rules: list[dict[str, Any]]) -> None:
        self._expressions = {
            _key(expression): {"expression": expression, "target_type": rule["target_type"],
                **({"product_id": rule["product_id"]} if rule["target_type"] == "product"
                   else {"replacement": rule["replacement"]})}
            for rule in rules for expression in rule["expressions"]
        }

    def match(self, name: str) -> dict[str, Any] | None:
        matched = self._expressions.get(_key(name))
        return dict(matched) if matched else None
