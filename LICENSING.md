# Licensing

Velum separates its open-source software from its fictional world, characters,
stories, archived diaries, and branding.

## Software — MIT

Unless otherwise noted, the source code and technical documentation in this
repository are licensed under the MIT License.

This includes:

- `src/` — schemas, generation pipeline, validators
- `scripts/` — command-line tools
- `tests/` — test code and schema fixtures
- `docs/` — technical specifications
- `.github/` — CI workflows

See [LICENSE](./LICENSE).

## World and characters — CC BY-NC 4.0

The fictional world of Velum and everything written inside it are licensed
under [Creative Commons Attribution-NonCommercial 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/).

This includes:

- `world/` — eras, places, institutions, arcs, threads, event cards, ticks
- `characters/` — profiles, canon, states, relationships, memories
- `characters/*/stories/` — Character Story sources: manifests, plans, briefs,
  and episode bodies, in every language and in every state (draft, reviewed,
  published). These live under `characters/` and are covered by this license
  like everything else there
- `characters/*/diaries/` — every generated diary entry, in every language
  (the archived Season 1 diaries)
- `characters/*/snapshots/` — compiled Persona Snapshots
- `tests/fixtures/voice/` — voice reference samples
- Character designs and illustrations published alongside this repository

You may read, quote, translate, remix, and build on this material for
non-commercial purposes, with attribution. Commercial use requires permission.

The world and its characters are production assets for PixTale, which is why
this material is not MIT-licensed alongside the code.

### PixApps products

The non-commercial restriction above binds third parties, not the rights
holder. PixApps — the publisher of both Velum and PixTale — retains full
rights to this material, and its own products and services (including the
PixTale app and the PixTale proxy) are expressly licensed to reproduce,
adapt, and distribute it commercially. This covers in particular the
distribution surfaces consumed by PixTale:

- `world/feed/` — the Diary/World feed, including the derived 512×512
  portrait assets
- `world/feed/stories/` — the published Character Story feed (`index.json`
  and one file per published season, with episode bodies)
- `world/appraisal/` — compiled World Appraisal Snapshots
- `characters/*/snapshots/` — compiled Persona Snapshots
- `world/personas.json` — the distribution pin

This clause makes the commercial use by PixApps products explicit; it grants
no rights to anyone else.

## Branding

The Velum and PixTale names, logos, wordmarks, visual identity, and other
PixApps brand elements are not covered by either license above. No trademark
rights are granted, and no right to present an independent deployment as the
official Velum or PixTale publication.

## Generated content and its provenance

Both kinds of narrative content in this repository are fiction, produced with a
large language model (Gemma, on Cloudflare Workers AI) from the structured
inputs stored here. They differ in how much a human was involved. See the
disclosure in [README.md](./README.md).

- **Stories** (`characters/*/stories/`, and the published feed in
  `world/feed/stories/`) are drafted by the model and then **reviewed and
  edited by a human**. Nothing is published automatically: only the episodes a
  human has selected, edited, and marked as published reach the feed.
- **Diaries** (`characters/*/diaries/`) are the archived Season 1 experiment
  (the Experimental Diary Season 1 / Archive). They were generated and
  published automatically, without human selection, until the schedule was
  stopped on 2026-10-03. They are kept, not deleted, as a record of the
  experiment.

Where a diary references a real-world work, brand, or person, that is a model
artifact and not an editorial claim. Report anything that looks like a genuine
attribution problem as an issue.
