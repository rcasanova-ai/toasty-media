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

The script backs up only managed paths that it is about to replace.

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

## Approval Requirement

Do not deploy without explicit production approval.

The script defaults to dry-run mode. A real deployment requires:

```sh
APPROVE_TOASTY_DEPLOY=production scripts/deploy-production.sh --execute
```

## Two Hosts (static site vs render backend)

Production is two machines. Do not conflate them.

| Host | Public name | Server | What Git deploys |
| --- | --- | --- | --- |
| LiteSpeed static | `toasty.media` | LiteSpeed | `js/`, `css/`, `studio/`, … via `.github/workflows/deploy-production.yml` on push to `main`. SSH secrets `TOASTY_SSH_*`. Root `/home/fmxgijyvpq/toasty.media`. |
| Ubuntu render | `render.toasty.media` | nginx → `127.0.0.1:4174` | **Not** in the static filter. `scripts/render-production-server.mjs` + `scripts/toasty-auth-db.py` (`AUTH_DB_HELPER` defaults to the helper next to the Node file). SQLite at `/var/lib/toasty/toasty.sqlite`. |

`scripts/` is excluded from the LiteSpeed filter on purpose. Adding the auth helper there would publish Python onto the public web root and would **not** update the process that actually runs `AUTH_DB_HELPER`.

The broadcast unit in `scripts/toasty-broadcast.service` (`WorkingDirectory=/opt/toasty-media`, `broadcast-server.mjs`) is RTMP, not the render API. Do not restart it for an auth-helper change.

### Canonical helper deploy (render host only)

`scripts/deploy-render-helper.sh` copies **only** `scripts/toasty-auth-db.py` to `TOASTY_RENDER_HELPER_PATH`, restarts `TOASTY_RENDER_UNIT`, and sha256-compares local Git to the remote file.

It does not copy the database, `.env`, secrets, nginx, or `render-production-server.mjs`.

Required environment (no defaults — guessing the path is how the last divergence happened):

```sh
export TOASTY_RENDER_SSH_HOST=...
export TOASTY_RENDER_SSH_USER=...
export TOASTY_RENDER_SSH_PORT=22
export TOASTY_RENDER_SSH_KEY=...          # optional
export TOASTY_RENDER_HELPER_PATH=/absolute/path/to/toasty-auth-db.py
export TOASTY_RENDER_UNIT=the-systemd-unit.service
scripts/deploy-render-helper.sh --dry-run
APPROVE_TOASTY_RENDER_HELPER=production scripts/deploy-render-helper.sh --execute
```

`TOASTY_RENDER_HELPER_PATH` must be the file `AUTH_DB_HELPER` already points at on that host (default: `<directory-of-render-production-server.mjs>/toasty-auth-db.py`).

This agent environment has no render-host SSH key, so the helper cannot be copied from here. Until those variables are set and the script is executed, production continues to use whatever helper is already next to the running Node process. That remaining automation gap is: GitHub Actions still has no render-host job, because the only existing deploy secrets target LiteSpeed.
