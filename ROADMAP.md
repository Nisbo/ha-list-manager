# Release preparation and deferred work

## First public beta: 1.0.0b1

- Shopping, To-do and inventory workflows with their own dashboard cards.
- Products, categories, labels, chips/templates, groups and replenishment.
- Backend scanner processing, per-list scripts and notifications.
- Long-term entity history with its own history card.
- Persistent backup archive and confirmed whole-database restoration.
- Original-card import for shopping, To-do and simplified inventory, including
  an import without entries and grouped explanations of excluded settings.
- Native Home Assistant translations in English and German.
- An independent bilingual wiki with matching complete screenshots, worked
  category/label examples and script examples.
- Initial database schema 1 and matching regression checks.

The first public beta is distributed as a pre-release from the `beta` branch.
See the README for HACS installation and enable pre-release versions for this
repository. A stable release will follow beta testing.

## Deferred work

- **Native HA actions for automations:** Add them when a concrete use case
  requires automations to modify lists or stock. The authenticated WebSocket API
  and per-list script callbacks already exist. Revisit selection UX and ambiguous
  product names before implementation.
- **Multiple inventory undo steps:** Add an ordered booking history with checks
  for later stock changes and resulting shopping orders. The current quick undo
  exposes only the last booking for its original 60-second window.
- **Further UI languages:** English and German are available. Add further native
  catalogs as needed, with semantic English keys and matching placeholders.
- **HTML/offline export:** Deferred for discussion. A Telegram interface would be
  a separate integration rather than a replacement for the card interface.
- **Additional inventory import data:** The current deliberate scope excludes
  EAN databases, variant groups and replenishment rules. Extend it only with a
  concrete requirement and a safe preview/reconciliation design.

## Documentation maintenance

Maintain the [English wiki](https://github.com/Nisbo/ha-list-manager/wiki) and
[German wiki](https://github.com/Nisbo/ha-list-manager/wiki/Home-DE) together.
New screenshots should show complete controls in the matching language with
neutral example data, without the HA sidebar or account name. Keep the short
administration hints short; detailed script variable references and examples
belong in the wiki. `examples/list-script-notification.yaml` is an optional
maintained example and is never installed automatically.
