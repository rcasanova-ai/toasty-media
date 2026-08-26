# Toasty Media Deployment

## Local And Production Paths

- Local repository: `/Users/ricardocasanova/Projects/toasty-media`
- Production SSH alias: `toasty-spaceship`
- Production root: `/home/fmxgijyvpq/toasty.media`

## Managed Deployment Scope

The Git-managed Toasty Media deployment scope includes:

- Root entrypoint: `index.html`
- Public site: `site/`
- Ricardo preserved route: `ricardo/`
- Toasty Studio: `studio/`
- Shared site CSS and JS: `css/`, `js/`
- Canonical shared brand assets: `shared/brand/`
- Toasty content assets: `assets/`, `site/assets/`
- Articles: `articles/`
- Eloquence bonus pages: `eloquencebonus/`
- Toasty-owned PDFs/downloadables at the production root
- `thank-you.html`

## Excluded Paths

These paths are unrelated and must remain completely untouched:

- `/home/fmxgijyvpq/toasty.media/dominion-investor-dashboard/`
- `/home/fmxgijyvpq/toasty.media/incitech/`

Do not inspect deeply, copy, migrate, back up, modify, delete, sync, deploy over, or include them in Git history.

## Migration Rules

- Production is a source for missing legacy/current Toasty content.
- Production is not automatically authoritative over the redesigned local site.
- Do not replace the new homepage, Ricardo page, branding decisions, or local architecture with older production versions merely because they are live.
- Preserve useful public URLs where practical.
- Do not bring back ToastyTea or Toasty Apparel as homepage pillars.
- Treat Cognitive Casanova as Ricardo's thought-leadership/content presence, not a Toasty sub-brand.
- Avoid duplicate assets unless URL preservation or page portability requires a copy.

## Backup Procedure

Before a real deployment, `scripts/deploy-production.sh --execute` creates a timestamped backup directory on production:

```text
/home/fmxgijyvpq/toasty.media/_backups/toasty-media-YYYYMMDD-HHMMSS/
```

The script backs up only managed paths that it is about to replace. It does not back up or traverse excluded paths.

## Rollback Procedure

Rollback is manual and approval-gated:

1. SSH to `toasty-spaceship`.
2. Inspect the relevant timestamped backup under `_backups/`.
3. Copy only the affected backed-up files/directories back into `/home/fmxgijyvpq/toasty.media`.
4. Validate the restored URLs.

Never use a destructive full-root mirror rollback.

## URL Preservation

Preserved paths include:

- `/`
- `/site/`
- `/ricardo/`
- `/site/ricardo/`
- `/articles/csuite_ai_scam.html`
- `/eloquencebonus/`
- `/eloquencebonus/cheatsheet.html`
- `/eloquencebonus/executive5dayplan.html`
- `/thank-you.html`
- `/5-Day Executive Program.pdf`
- `/Eloquence Cheat Sheet.pdf`
- `/casanova_case_study.pdf`
- `/ricardo_casanova_resumeJune2026.pdf`

## Deployment Validation

Before deployment:

- Confirm `pwd` is `/Users/ricardocasanova/Projects/toasty-media`.
- Confirm `git status` is clean or only contains intentional deployment-script edits.
- Run internal link/path checks.
- Run JS syntax checks.
- Run local HTTP smoke tests for the homepage, Ricardo page, Studio pages, articles, Eloquence bonus pages, and PDF links.
- Run `bash -n scripts/deploy-production.sh`.
- Run `scripts/deploy-production.sh --dry-run`.

After deployment approval and execution:

- Validate `/`, `/site/`, `/ricardo/`, `/site/ricardo/`, `/articles/csuite_ai_scam.html`, `/eloquencebonus/`, `/thank-you.html`, and root PDF links.
- Confirm excluded directories still exist and were not modified by the deployment.

## Approval Requirement

Do not deploy without explicit production approval.

The script defaults to dry-run mode. A real deployment requires:

```sh
APPROVE_TOASTY_DEPLOY=production scripts/deploy-production.sh --execute
```
