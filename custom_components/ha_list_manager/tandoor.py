"""Small read-only client for a configured Tandoor Recipes instance."""

from __future__ import annotations

import asyncio
from html.parser import HTMLParser
from typing import Any
from time import monotonic
from urllib.parse import urljoin, urlparse

from aiohttp import ClientError, ClientResponseError, ClientTimeout

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from .localization import text as localized_text


class TandoorError(Exception):
    """Raised when Tandoor cannot provide a usable response."""


class _TandoorTextParser(HTMLParser):
    """Turn Tandoor's formatted instructions into safe, readable plain text."""

    _BLOCK_TAGS = {"br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._BLOCK_TAGS and tag != "br":
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _plain_tandoor_text(value: Any) -> str:
    """Return normalized plain text while preserving intentional line breaks."""
    parser = _TandoorTextParser()
    parser.feed(str(value or ""))
    parser.close()
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines()]
    return "\n".join(line for line in lines if line)


def normalize_tandoor_url(value: str | None) -> str | None:
    """Return a normalized HTTP(S) base URL."""
    url = str(value or "").strip().rstrip("/")
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(localized_text("backend.tandoor_url_invalid"))
    return url


class TandoorClient:
    """Fetch recipes without exposing the API token to Lovelace."""

    def __init__(self, hass: HomeAssistant, base_url: str, token: str) -> None:
        self._session = async_get_clientsession(hass)
        self._base_url = normalize_tandoor_url(base_url) or ""
        self._token = token.strip()
        self._cache: dict[tuple[str, tuple[tuple[str, Any], ...]], tuple[float, Any]] = {}
        self._image_cache: dict[int, tuple[float, bytes, str]] = {}

    async def _get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        if not self._base_url or not self._token:
            raise TandoorError(localized_text("backend.tandoor_setup_incomplete"))
        url = urljoin(f"{self._base_url}/", path.lstrip("/"))
        try:
            async with self._session.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=ClientTimeout(total=15),
            ) as response:
                response.raise_for_status()
                payload = await response.json()
                if not isinstance(payload, dict):
                    raise TandoorError(localized_text("backend.tandoor_response_invalid"))
                return payload
        except ClientResponseError as error:
            if error.status in {401, 403}:
                raise TandoorError(localized_text("backend.tandoor_token_rejected")) from error
            raise TandoorError(localized_text("backend.tandoor_http_error", status=error.status)) from error
        except (ClientError, TimeoutError, ValueError) as error:
            raise TandoorError(localized_text("backend.tandoor_unreachable", p0=error)) from error

    async def _get_cached(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        ttl: float = 300,
    ) -> Any:
        """Cache stable lookup data so typing does not repeat expensive requests."""
        key = (path, tuple(sorted((params or {}).items())))
        cached = self._cache.get(key)
        now = monotonic()
        if cached is not None and cached[0] > now:
            return cached[1]
        payload = await self._get(path, params=params)
        self._cache[key] = (now + ttl, payload)
        return payload

    async def async_test(self) -> dict[str, Any]:
        """Verify authentication with the smallest useful recipe request."""
        payload = await self._get("/api/recipe/", params={"page_size": 1})
        return {"recipe_count": int(payload.get("count", 0))}

    async def async_categories(self, limit: int = 100) -> list[dict[str, Any]]:
        """Return the recipe books used as Tandoor recipe categories."""
        payload = await self._get_cached(
            "/api/recipe-book/",
            params={"page_size": max(1, min(100, limit)), "sort_order": "name"},
        )
        results = payload.get("results") or []
        return sorted(
            [
                {"id": int(item["id"]), "name": str(item.get("name") or localized_text("backend.tandoor_category")).strip()}
                for item in results
                if item.get("id") is not None
            ],
            key=lambda item: item["name"].casefold(),
        )

    async def async_search(
        self,
        query: str,
        limit: int = 100,
        category_id: int | None = None,
        include_ingredients: bool = True,
    ) -> list[dict[str, Any]]:
        """Return compact recipe search results."""
        page_size = max(1, min(100, limit))
        normalized_query = query.strip().casefold()
        if category_id is not None and not normalized_query:
            category_payload = await self._get_cached(
                "/api/recipe-book-entry/",
                params={"book": category_id, "page_size": page_size},
            )
            results = [
                item.get("recipe_content") or {}
                for item in category_payload.get("results") or []
            ]
        else:
            payload = await self._get(
                "/api/recipe/",
                params={"query": query.strip(), "page_size": page_size, "sort_order": "name"},
            )
            results = payload.get("results") or []
            if normalized_query:
                results = [
                    item for item in results
                    if normalized_query in str(item.get("name") or "").casefold()
                ]
                if include_ingredients:
                    ingredient_payload = await self._get_cached(
                        "/api/ingredient/", params={"page_size": 100}
                    )
                    ingredient_recipes: dict[int, dict[str, Any]] = {}
                    for ingredient in ingredient_payload.get("results") or []:
                        food = ingredient.get("food") or {}
                        searchable = " ".join(
                            str(value or "")
                            for value in (
                                food.get("name"),
                                food.get("full_name"),
                                ingredient.get("note"),
                                ingredient.get("original_text"),
                            )
                        ).casefold()
                        if normalized_query not in searchable:
                            continue
                        for recipe in ingredient.get("used_in_recipes") or []:
                            if recipe.get("id") is not None:
                                ingredient_recipes[int(recipe["id"])] = recipe
                    merged = {
                        int(item["id"]): item
                        for item in results
                        if item.get("id") is not None
                    }
                    merged.update(
                        {
                            recipe_id: recipe
                            for recipe_id, recipe in ingredient_recipes.items()
                            if recipe_id not in merged
                        }
                    )
                    results = list(merged.values())
            if category_id is not None:
                category_payload = await self._get_cached(
                    "/api/recipe-book-entry/",
                    params={"book": category_id, "page_size": 100},
                )
                category_recipe_ids = {
                    int(recipe["id"])
                    for entry in category_payload.get("results") or []
                    if (recipe := entry.get("recipe_content") or {}).get("id") is not None
                }
                results = [
                    item for item in results
                    if item.get("id") is not None and int(item["id"]) in category_recipe_ids
                ]
        selected_results = sorted(
            results,
            key=lambda item: str(item.get("name") or "").casefold(),
        )[:page_size]
        compact_results = [
            item for item in selected_results
            if item.get("id") is not None
            and not any(
                key in item
                for key in ("image", "servings", "working_time", "waiting_time")
            )
        ]
        if compact_results:
            details = await asyncio.gather(
                *(
                    self._get_cached(f"/api/recipe/{int(item['id'])}/")
                    for item in compact_results
                ),
                return_exceptions=True,
            )
            enriched = {
                int(detail["id"]): detail
                for detail in details
                if isinstance(detail, dict) and detail.get("id") is not None
            }
            selected_results = [
                enriched.get(int(item["id"]), item)
                if item.get("id") is not None else item
                for item in selected_results
            ]
        recipes = [
            {
                "id": int(item["id"]),
                "name": str(item.get("name") or localized_text("backend.tandoor_recipe")),
                "image": self._absolute_url(item.get("image")),
                "servings": item.get("servings"),
                "servings_text": str(item.get("servings_text") or ""),
                "working_time": item.get("working_time"),
                "waiting_time": item.get("waiting_time"),
            }
            for item in selected_results
            if item.get("id") is not None
        ]
        return sorted(recipes, key=lambda item: item["name"].casefold())

    async def async_recipe(self, recipe_id: int) -> dict[str, Any]:
        """Return one recipe with ordered ingredients and preparation steps."""
        recipe = await self._get(f"/api/recipe/{recipe_id}/")
        ingredients: list[dict[str, Any]] = []
        steps: list[dict[str, Any]] = []
        ordered_steps = sorted(recipe.get("steps") or [], key=lambda item: item.get("order", 0))
        for position, step in enumerate(ordered_steps, start=1):
            step_name = _plain_tandoor_text(step.get("name"))
            instruction = _plain_tandoor_text(step.get("instruction"))
            if step_name or instruction:
                steps.append(
                    {
                        "id": int(step["id"]) if step.get("id") is not None else position,
                        "name": step_name or None,
                        "instruction": instruction,
                    }
                )
            for ingredient in step.get("ingredients") or []:
                food = ingredient.get("food") or {}
                unit = ingredient.get("unit") or {}
                if ingredient.get("id") is None or not food.get("name"):
                    continue
                ingredients.append(
                    {
                        "id": int(ingredient["id"]),
                        "food_id": food.get("id"),
                        "name": str(food["name"]).strip(),
                        "amount": ingredient.get("amount"),
                        "unit": str(unit.get("name") or "").strip() or None,
                        "note": str(ingredient.get("note") or "").strip() or None,
                        "no_amount": bool(ingredient.get("no_amount")),
                    }
                )
        return {
            "id": int(recipe["id"]),
            "name": str(recipe.get("name") or localized_text("backend.tandoor_recipe")),
            "image": self._absolute_url(recipe.get("image")),
            "servings": recipe.get("servings"),
            "servings_text": str(recipe.get("servings_text") or ""),
            "working_time": recipe.get("working_time"),
            "waiting_time": recipe.get("waiting_time"),
            "ingredients": ingredients,
            "steps": steps,
        }

    async def async_recipe_image(self, recipe_id: int) -> tuple[bytes, str]:
        """Fetch one recipe image through the authenticated backend connection."""
        cached = self._image_cache.get(recipe_id)
        now = monotonic()
        if cached is not None and cached[0] > now:
            return cached[1], cached[2]
        recipe = await self._get_cached(f"/api/recipe/{recipe_id}/", ttl=300)
        image_url = self._absolute_url(recipe.get("image"))
        if not image_url:
            raise TandoorError(localized_text("backend.recipe_image_missing"))
        base = urlparse(self._base_url)
        image = urlparse(image_url)
        if image.scheme not in {"http", "https"} or image.netloc != base.netloc:
            raise TandoorError(localized_text("backend.recipe_image_wrong_instance"))
        try:
            async with self._session.get(
                image_url,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=ClientTimeout(total=20),
            ) as response:
                response.raise_for_status()
                content_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0]
                if not content_type.startswith("image/"):
                    raise TandoorError(localized_text("backend.tandoor_image_invalid"))
                data = await response.read()
                if not data or len(data) > 10 * 1024 * 1024:
                    raise TandoorError(localized_text("backend.recipe_image_invalid"))
        except ClientResponseError as error:
            raise TandoorError(localized_text("backend.tandoor_image_http_error", status=error.status)) from error
        except (ClientError, TimeoutError) as error:
            raise TandoorError(localized_text("backend.recipe_image_unreachable", p0=error)) from error
        self._image_cache[recipe_id] = (now + 300, data, content_type)
        return data, content_type

    def _absolute_url(self, value: Any) -> str | None:
        text = str(value or "").strip()
        return urljoin(f"{self._base_url}/", text) if text else None
