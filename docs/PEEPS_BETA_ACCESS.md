# Peeps private beta: waitlist and access

Public path: `toasty.media/peeps/` → **Join the Waitlist** (`/peeps/?waitlist` opens the form directly).
Authorized path: **Sign in** on the same page, which uses the existing Toasty account login (`/auth/login`, `/auth/session`). Signed-in users see **Open Peeps** (`/peeps/app/`, still gated by `js/peeps-app-gate.js`) and **Guided demo** (`/peeps/demo/`).

## Data

Signups go to the `peeps_waitlist` table (SQLite on the render host, created by `scripts/toasty-auth-db.py`). Email is lowercased and UNIQUE; a repeat signup returns "already on the list" and changes nothing. Stored: name, email, company, use case, status (`waitlist` → `invited` → `active`), source, referrer, UTM parameters, consent time, created time.

API: `POST /api/peeps/waitlist` (public, CSRF header + 8/15min per IP + honeypot). Admin, platform admin only: `GET /api/organizations/platform-admin/peeps-waitlist`, `POST …/status`, `POST …/invite`. Both route families were already proxied by nginx, so no nginx change is needed.

## Admin

`/studio/platform-admin.html` → **Peeps waitlist**. Change status with the dropdown. **Invite to Peeps** sends the existing organization-invite email into the chosen organization (default: Toasty Peeps); accepting it marks the person Active.

## Creating a judge / tester account

1. Sign in at `/studio/` as the platform admin, open **Platform Admin → Members & access**, and pick the **Toasty Peeps** organization in the switcher.
2. **Create login now**: name, email, a temporary password (10+ characters), role Member → **Create customer login**. Give them the email and password securely. They sign in at `toasty.media/peeps/` with **Sign in**.
3. Or, if they are on the waitlist, use **Peeps waitlist → Invite to Peeps** instead (emailed link; they create or use an account with that email).
4. Reset a forgotten password with **Reset password** in the same Members table.

There is deliberately no public "Judge Login".
