"""Explicit, optional prefix parsing for free Alexa shopping-list entries."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
import json
from pathlib import Path
import re
from typing import Any
import unicodedata

MAX_QUANTITY = 1_000_000
_MAX_MAPPING_SIZE = 64_000
_MAX_MAPPING_LINES = 1_000
_MAX_PHRASE_SIZE = 200
_LANGUAGE_DIRECTORY = Path(__file__).with_name("alexa_languages")
_UNIT_PATTERN = re.compile(r"[^\W\d_][\wµμ²³/%°.-]{0,19}", re.UNICODE)


class AlexaParseError(ValueError):
    """A configuration error the caller can translate in the user's language."""

    def __init__(self, key: str, **placeholders: Any) -> None:
        self.key = key
        self.placeholders = placeholders
        super().__init__(key)


@dataclass(frozen=True, slots=True)
class ParsedAlexaItem:
    """Only list-entry data; parsing never reads or changes product records."""

    name: str
    quantity: int = 1
    description: str | None = None
    parsed: bool = False
    has_unit: bool = False


@dataclass(frozen=True, slots=True)
class _LanguageRules:
    numbers: tuple[tuple[int, str], ...]
    units: tuple[tuple[str, str], ...]
    number_continuations: frozenset[str]


def _normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


@lru_cache(maxsize=1)
def _language_catalog() -> dict[str, _LanguageRules]:
    """Discover shipped recognition data once; UI translations remain in HA."""
    catalog = {}
    for path in sorted(_LANGUAGE_DIRECTORY.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        code = path.stem
        if (not re.fullmatch(r"[a-z]{2,3}(?:-[a-z0-9]{2,8})*", code)
                or not isinstance(data, dict) or data.get("schema_version") != 1
                or data.get("code") != code):
            raise ValueError(f"Invalid Alexa language resource: {path.name}")
        groups = {}
        for kind in ("numbers", "units"):
            rows = data.get(kind)
            if not isinstance(rows, list) or (kind == "numbers" and not rows):
                raise ValueError(f"Invalid Alexa {kind} resource: {path.name}")
            aliases = {}
            for row in rows:
                if not isinstance(row, dict):
                    raise ValueError(f"Invalid Alexa {kind} resource: {path.name}")
                value, phrase = row.get("value"), row.get("phrase")
                if (not isinstance(phrase, str) or not phrase.strip()
                        or len(phrase) > _MAX_PHRASE_SIZE):
                    raise ValueError(f"Invalid Alexa phrase resource: {path.name}")
                if kind == "numbers":
                    valid = type(value) is int and 1 <= value <= MAX_QUANTITY
                else:
                    valid = isinstance(value, str) and bool(_UNIT_PATTERN.fullmatch(value))
                normalized = _normalize(phrase)
                if not valid or (normalized in aliases and aliases[normalized][0] != value):
                    raise ValueError(f"Invalid Alexa {kind} resource: {path.name}")
                aliases.setdefault(normalized, (value, phrase.strip()))
            groups[kind] = tuple(sorted(aliases.values(), key=lambda row: (row[0], _normalize(row[1]))))
        continuations = data.get("number_continuations", [])
        if not isinstance(continuations, list) or any(
            not isinstance(word, str) or not word.strip() or len(word) > _MAX_PHRASE_SIZE
            for word in continuations
        ):
            raise ValueError(f"Invalid Alexa number continuations: {path.name}")
        catalog[code] = _LanguageRules(groups["numbers"], groups["units"],
                                       frozenset(_normalize(word) for word in continuations))
    if not catalog:
        raise ValueError("No Alexa language resources are installed")
    return catalog


def available_alexa_languages() -> list[dict[str, Any]]:
    """Describe delivered rule sets; counts include every recognized alias."""
    return [{"code": code, "number_min": min(row[0] for row in rules.numbers),
             "number_max": max(row[0] for row in rules.numbers),
             "number_count": len(rules.numbers), "unit_count": len(rules.units)}
            for code, rules in _language_catalog().items()]


def default_alexa_languages(preferred: str | None = None) -> list[str]:
    """Use the matching shipped locale, then its base language, then the first."""
    catalog = _language_catalog()
    preferred = preferred.strip().casefold().replace("_", "-") if isinstance(preferred, str) else ""
    if preferred in catalog:
        return [preferred]
    base = preferred.split("-", 1)[0]
    if base in catalog:
        return [base]
    return [next((code for code in catalog if code.split("-", 1)[0] == base), next(iter(catalog)))]


def alexa_language_rules(language: str, kind: str, query: str = "", offset: int = 0,
                         limit: int = 50) -> dict[str, Any]:
    """Return one bounded, searchable page from one delivered rule set."""
    catalog = _language_catalog()
    if not isinstance(language, str) or language not in catalog:
        raise AlexaParseError("alexa.invalid_languages")
    if (not isinstance(kind, str) or kind not in {"numbers", "units"}
            or not isinstance(query, str) or len(query) > 200
            or type(offset) is not int or offset < 0 or type(limit) is not int or limit < 1):
        raise AlexaParseError("alexa.settings_invalid")
    limit = min(limit, 50)
    query = _normalize(query)
    rules = getattr(catalog[language], kind)
    matches = [(value, phrase) for value, phrase in rules
               if not query or query in str(value).casefold() or query in _normalize(phrase)]
    return {"items": [{"value": value, "phrase": phrase} for value, phrase in matches[offset:offset + limit]],
            "total": len(matches), "offset": offset, "limit": limit, "language": language, "kind": kind}


@lru_cache(maxsize=16)
def _builtin_numbers(languages: tuple[str, ...]) -> dict[str, int]:
    catalog = _language_catalog()
    return {_normalize(phrase): value for language in languages for value, phrase in catalog[language].numbers}


def _builtin_units(languages: tuple[str, ...]) -> dict[str, str]:
    catalog = _language_catalog()
    return {_normalize(phrase): value for language in languages for value, phrase in catalog[language].units}


def _mapping_lines(value: Any, field: str) -> list[tuple[int, str]]:
    if not isinstance(value, str) or len(value) > _MAX_MAPPING_SIZE:
        raise AlexaParseError("alexa.mapping_too_long", field=field)
    lines = value.splitlines()
    if len(lines) > _MAX_MAPPING_LINES:
        raise AlexaParseError("alexa.mapping_too_long", field=field)
    return [(number, line.strip()) for number, line in enumerate(lines, 1)
            if line.strip() and not line.lstrip().startswith("#")]


def _custom_mapping(value: Any, *, unit: bool) -> dict[str, int | str]:
    kind = "unit" if unit else "number"
    result: dict[str, int | str] = {}
    for line_number, line in _mapping_lines(value, kind):
        left, separator, phrase = line.partition("=")
        left, phrase = left.strip(), _normalize(phrase)
        if not separator or not phrase or "=" in phrase or len(phrase) > _MAX_PHRASE_SIZE:
            raise AlexaParseError(f"alexa.invalid_{kind}_mapping", line=line_number)
        if unit:
            if not _UNIT_PATTERN.fullmatch(left):
                raise AlexaParseError("alexa.invalid_unit_mapping", line=line_number)
            parsed: int | str = left
        else:
            if not re.fullmatch(r"[1-9][0-9]{0,6}", left) or int(left) > MAX_QUANTITY:
                raise AlexaParseError("alexa.invalid_number_mapping", line=line_number)
            parsed = int(left)
        if phrase in result and result[phrase] != parsed:
            raise AlexaParseError(f"alexa.conflicting_{kind}_mapping", line=line_number)
        result[phrase] = parsed
    return result


class AlexaParser:
    """Interpret configured prefixes, never inflect or guess product names."""

    def __init__(self, settings: Mapping[str, Any]) -> None:
        catalog = _language_catalog()
        languages = settings.get("languages", default_alexa_languages())
        if (not isinstance(languages, (list, tuple)) or not languages
                or any(not isinstance(language, str) or language not in catalog for language in languages)):
            raise AlexaParseError("alexa.invalid_languages")
        languages = tuple(sorted(set(languages)))
        self._numbers = {**_builtin_numbers(languages),
                         **_custom_mapping(settings.get("number_mappings", ""), unit=False)}
        self._units = {**_builtin_units(languages),
                       **_custom_mapping(settings.get("unit_mappings", ""), unit=True)}
        exceptions = _mapping_lines(settings.get("exceptions", ""), "exceptions")
        if any(len(line) > _MAX_PHRASE_SIZE for _, line in exceptions):
            raise AlexaParseError("alexa.invalid_exceptions")
        self._exceptions = {_normalize(line) for _, line in exceptions}
        self._recognize_numbers = settings.get("recognize_numbers") is True
        self._recognize_units = settings.get("recognize_units") is True
        self._number_continuations = frozenset(word for rules in catalog.values()
                                               for word in rules.number_continuations)

    @staticmethod
    def _prefix(text: str, mapping: Mapping[str, Any]) -> tuple[Any, str] | None:
        # Cutting at original token spans preserves the user's remaining name,
        # even when casefolding expands ß or NFKC changes character widths.
        tokens = list(re.finditer(r"\S+", text))
        parts = [_normalize(token.group()) for token in tokens]
        for length in range(len(parts) - 1, 0, -1):
            phrase = " ".join(parts[:length])
            if phrase in mapping:
                return mapping[phrase], text[tokens[length].start():]
        return None

    def parse(self, text: str) -> ParsedAlexaItem:
        """Return free entry fields, preserving unrecognized complete names."""
        original = text.strip()
        fallback = ParsedAlexaItem(original)
        if not self._recognize_numbers or _normalize(original) in self._exceptions:
            return fallback
        number = self._prefix(original, self._numbers)
        if number is None:
            match = re.match(r"(\S+)\s+(\S.*)$", original, re.DOTALL)
            digits = _normalize(match[1]) if match else ""
            if not re.fullmatch(r"[1-9][0-9]{0,6}", digits) or int(digits) > MAX_QUANTITY:
                return fallback
            number = (int(digits), match[2])
        quantity, name = number
        if not name.strip():
            return fallback
        # An unsupported longer number must not become a smaller quantity
        # followed by an invented article such as "thousand cucumbers".
        if _normalize(name).split()[0] in self._number_continuations:
            return fallback
        if self._recognize_units:
            unit = self._prefix(name, self._units)
            if unit is not None:
                canonical, name = unit
                return ParsedAlexaItem(name, 1, f"{quantity} {canonical}", True, True)
            # A bare quantity+unit has no article. Keep the text intact instead
            # of inventing an item named after the unit.
            if _normalize(name) in self._units:
                return fallback
        return ParsedAlexaItem(name, int(quantity), None, True)
