# Production journey test (needs an authorized account)

Nothing here injects data. Every PASS comes from real evidence stored by the production system. Until this has been run with an authorized account, the production journey is **unverified**.

## Production configuration found on 2026-10-11 (read-only check of the render host)

- Not configured: `RESEND_API_KEY` (no email is delivered), `SVM_PAY_TO` (Solana payments are simulated), `PEEPS_BETA_REQUIRE_INVITE`, `ZCASH_SETTLEMENT_ENABLED`. Configured: whisper binary + model, ffmpeg, a dedicated session secret. The exposed render token has been rotated.
- To test on production you must therefore: install an email key (so the guest link is emailed) and, for the on-chain path, set `SVM_PAY_TO`, `TOASTY_USDC_MINT`, `TOASTY_SOLANA_NETWORK` in `/etc/toasty-render.env` and `systemctl restart toasty-render`. Public devnet values: mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, network `solana-devnet`.

## One-time setup (Ricardo)

1. **Create the test account through the invitation flow.** Open `https://toasty.media/studio/platform-admin.html` (sign in as the platform admin) → left nav **Peeps waitlist**. Register the tester at `https://toasty.media/peeps/waitlist/` (name, email you control, interest, tick consent), refresh the panel, find the row, click **Invite**. The email (or, if `RESEND_API_KEY` is not configured, the link shown in the admin message bar) opens `https://toasty.media/peeps/join/?token=…`: set a password. The account is now ACTIVE.
2. **Fund its Dough** (a new account has $0): sign in at `https://toasty.media/peeps/` → **Dough** → crypto funding with devnet USDC, or use `--pay solana` below. Or just pay the 0.25 introduction with devnet USDC.
3. A second inbox you control for the candidate (e.g. `you+guest@gmail.com`).

## Run the checker

```bash
export PEEPS_EMAIL='tester@example.com'        # the invited account
export PEEPS_PASSWORD='…'                      # never committed, never printed
node scripts/production-journey-check.mjs start --guest-email you+guest@gmail.com
```

It signs in, creates a real request, shows the persisted evidence-based evaluation (how many qualified or were excluded), and authorizes the top qualified candidate (Dough by default; `--pay solana --signature <devnet tx signature>` for the on-chain path, see `peeps/README.md`).

## The human steps (cannot be automated)

1. Candidate inbox: open the email, click the link, **I'm interested**, recording **Yes**, **45 minutes**, availability, **Share my availability**. (If email isn't configured on production, the guest link is not delivered: configure `RESEND_API_KEY` or take the guest link from the request on `https://toasty.media/peeps/app/?request=<id>`.)
2. Requester: open the golden-path page for the request; it books the first mutual time automatically.
3. Guest: reload the guest link, tick consent, **Save my consent**, **Join the session**; in the lobby allow camera/microphone, **Join Jam**.
4. Requester: **3 · Join Jam →**. Follow `docs/LIVE_DEVICE_TEST.md` (talk 30-60 s, start/stop the Studio recording).
5. Requester: paste the transcript with named speakers (or **Insert a sample transcript (demo text)** and say so), **Complete Jam & generate Breadcrumbs**, **Settle Dough**.

## Check progress at any time

```bash
node scripts/production-journey-check.mjs status
```

Stages reported: sign-in, request + evaluation, introduction payment (with Explorer link if on-chain), candidate responded, booked (Jam + Studio session), consent, attendance (emitted by the room), recording registered, transcript, Breadcrumbs, outcome, settlement, optional Zcash. A stage is PASS only when real evidence exists; otherwise PENDING with the reason.

## Security check before filming (Ricardo)

GitHub → repository **Actions** → **Render host security (manual)** → **Run workflow**: choose `inspect` first (prints only yes/no and lengths), then `rotate` if it reports the session secret is missing, equals the render token, or the leaked token is still valid. Rotation signs everyone out.
