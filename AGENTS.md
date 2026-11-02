# HA List Manager

Home Assistant custom integration with a shared SQLite backend, an
administrator-only panel, three list cards and a separate entity-history card.
The technical domain is `ha_list_manager`. This is a separate project from the
original frontend-only Improved Shopping List Card.

## Preserve working behavior

- Make incremental changes and inspect affected paths before editing.
- Keep shopping, inventory and To-do workflows distinct. To-do tasks never
  require product records.
- Products, shopping entries and inventory stock are separate data.
- Process scanners and script events once in the backend, without requiring an
  open card.
- Normal authenticated HA users operate the three list cards; administration
  and configuration remain administrator-only.
- Preserve focus, scroll position, live updates and mobile behavior.
- Use native Home Assistant translation resources in `translations/en.json`
  and `translations/de.json`, with short semantic English keys. Do not add a
  generated dictionary or translation build step.
- Preserve user data and IDs through updates. Public database schema changes
  require explicit versioning and data-preserving upgrades; never delete a
  database to resolve a schema mismatch.

## Validation

Use Python 3.14 and Node.js 24:

```sh
python -m pip install -r requirements-test.txt
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q -p no:cacheprovider tests
node tools/test-frontend.cjs
```

The isolated tests use Home Assistant doubles. Changes affecting installation,
storage or HA integration behavior also need an appropriate real HA test.
Keep useful tests in the repository, outside the installed integration folder.
Do not publish local databases, credentials, private captures or test reports.

## Git identity and publication

Every assistant-created commit must use **Nisbo** for both author and committer,
with `26260572+Nisbo@users.noreply.github.com`. Never use an inferred machine
identity, a personal name or a private email. This also applies to temporary
clones, merge preparation, release commits and the wiki.

Before every commit, explicitly set the author and committer identities and
verify both `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT`.
Do not rely on global Git configuration. Preserve third-party attribution.
Verify the GitHub account is **Nisbo** before pushing or publishing releases.
Do not rewrite published history without authorization.

Keep a logical backup before large changes. Publish only the repository,
branch and release scope authorized by the user; the public beta branch is
`beta`. Do not mix in the original card repository or private development
history.
