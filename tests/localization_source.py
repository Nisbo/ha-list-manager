"""Resolve static text references for source-shape tests, never runtime tests.

These tests inspect layout/wiring rather than whether German is hardcoded.
Behavior tests continue to execute the actual localized production modules.
"""
import json
from pathlib import Path
import re

from native_translation_test_support import native_catalog

CATALOG = native_catalog("de")
_JS_CALL = r'''haListManager\w+Text\(\s*["']([^"'\n]+)["']\s*(?:,\s*\{\s*\}\s*(?:,\s*(?:this\._hass|hass|undefined|language|null)\s*)?)?\)'''
_PY_CALL = r'''(?<![\w.])(?:german_text|localized_text|system_text|text)\(\s*["']([^"'\n]+)["'](?=\s*[,\)])'''


def localized_source(path: Path) -> str:
    source = path.read_text()
    if path.suffix == ".js":
        def markup(match):
            return CATALOG["frontend"][match[1]]
        source = re.sub(r'\$\{\s*' + _JS_CALL + r'\s*\}', markup, source)
        source = re.sub(_JS_CALL, lambda match: json.dumps(CATALOG["frontend"][match[1]], ensure_ascii=False), source)
        keys = re.findall(r'haListManager\w+Text\(\s*["\']([^"\']+)["\']', source)
        if keys:
            source += "\n" + "\n".join("// " + CATALOG["frontend"][key] for key in keys if key in CATALOG["frontend"])
    elif path.suffix == ".py":
        source = re.sub(_PY_CALL + r'\s*\)', lambda match: json.dumps(CATALOG["backend"][match[1]], ensure_ascii=False), source)
        keys = re.findall(_PY_CALL, source)
        source += "\n" + "\n".join("# " + CATALOG["backend"][key] for key in keys)
    return source
