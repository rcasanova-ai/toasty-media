# Production Inventory Classification

Read-only production inventory source:

- SSH alias: `toasty-spaceship`
- Production root: `/home/fmxgijyvpq/toasty.media`
- Inventory date: 2026-08-26

Excluded paths were only confirmed by name and not traversed:

- `dominion-investor-dashboard/`
- `incitech/`

## Already Represented Locally

- New Toasty Media homepage structure: represented by `site/index.html`.
- New Ricardo profile structure: represented by `site/ricardo/index.html`.
- Primary Toasty Media logos and Ricardo imagery: represented under `shared/brand/toasty-media/`.
- Toasty Studio foundation: represented under `studio/`, `js/`, and `css/`.

## Missing Locally And Migrated

- `5-Day Executive Program.pdf`
- `Eloquence Cheat Sheet.pdf`
- `casanova_case_study.pdf`
- `ricardo_casanova_resumeJune2026.pdf`
- `eloquencebonus/`
- `thank-you.html`
- `articles/csuite_ai_scam.html`
- `site/assets/images/books/cover.png`
- `site/assets/images/books/CasanovaUnrequited.png`
- `site/assets/images/books/StoriesWithWingsCover_FinalJPG.jpg`
- `site/assets/images/media/articleshero.jpg`
- `site/assets/images/media/publicspeakinghero.jpg`
- `site/assets/images/media/speaking1.png`
- `site/assets/images/media/talkshero2.jpg`
- `site/assets/images/cognitive-casanova/*.png`

## Legacy Content Worth Preserving But Not Surfacing Prominently

- `articles/csuite_ai_scam.html`: production copy was a stub, so the local version preserves the URL and editorial intent without keeping broken legacy nav or placeholder form behavior.
- `site/assets/images/cognitive-casanova/*.png`: preserved as Ricardo/Cognitive Casanova thought-leadership thumbnails, not promoted as a Toasty sub-brand.
- Toasty Talks imagery such as `talkshero2.jpg`: preserved for future series pages.
- Production Ricardo implementation: superseded by `site/ricardo/index.html`; `/ricardo/` is preserved as a redirect.

## Obsolete And Not Migrated

- Toasty Apparel homepage section and product imagery:
  - `images/BullishAF.jpg`
  - `images/OilersGiggityHoodie.png`
  - `images/UglySweater.png`
  - `images/apparelhero.jpg`
  - `images/ToastyApparelHLOGO.png`
- ToastyTea as a homepage pillar:
  - `images/ToastyTeaHLOGO.png`
  - `images/Toast and Tea 3 PNG.png`

Historical assets can remain archived in production until explicitly retired, but the redesigned homepage should not bring them back as pillars.

## Unrelated And Excluded

- `dominion-investor-dashboard/`
- `incitech/`

These paths are unrelated to Toasty Media repo management and must never be copied, backed up by the Toasty deployment script, modified, deleted, synced, deployed over, or included in Git history.

## URL Preservation Notes

- `/` redirects to `/site/`.
- `/site/` is the new homepage.
- `/ricardo/` redirects to `/site/ricardo/`.
- `/articles/csuite_ai_scam.html` is preserved.
- `/eloquencebonus/` and child pages are preserved.
- `/thank-you.html` is preserved.
- Root PDF download paths are preserved.
