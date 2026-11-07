# IT Executive Partners - Recruit (temporary isolated scaffold)

This folder is a **temporary staging location** in the Toasty Media repository, awaiting the dedicated private `it-executive-partners` GitHub repository. It contains no references to or dependency on Toasty's auth, sessions or backend. It must be moved intact when the private repository exists.

Routes:
- `/itexecutivepartners/`: independent brand landing page (intentionally noindex).
- `/itexecutivepartners/pilot/`: **fictional** deterministic qualification demo. Zero API calls, no candidate persistence, no production claim. Keep internal.

## Security and release gate

Do not publicize the site or collect real candidates until legal entity/operating details, official business contact email, privacy notice, consent language, and independent hosting/authentication are verified. Provisional email link must be replaced. Publishing at a Toasty domain creates a visible hosting association; move to a dedicated domain when available.

## Intended production boundaries

- Dedicated private repository, separate CI/CD pipeline and environment variables.
- Dedicated Supabase project (not an existing Toasty/Santati project); separate Auth, Postgres, Storage and RLS.
- Recruitment information remains in the separate project; no copies into Santati CRM, organizational memory or Peeps production.
- Santati intelligence is **licensed as a private API**, not extracted. Only explicitly authorized, minimized inputs are sent to an API intermediary; no public branding or browser-exposed keys. Contractual privacy and retention controls required before exchanging real information.
- Peeps Dub/agent concepts become a **versioned isolated adapter** after a code-level extraction audit; no automatic sharing of Peeps users, Dubs or data.
- All automated candidate qualification is assistive, grounded in approved job-related evidence, explainable and reviewable by a human. Do not infer protected characteristics or use SHD psychological profiling for hiring decisions.
- The client browser never receives a service secret, raw API token, database service-role key, or cross-tenant credentials.

## When Supabase is provisioned

1. Copy the SQL migration from `supabase/migrations/0001_initial.sql` into the **new project** and review the RLS policies.
2. Define an administrative invitation process. Never expose a public sign-up route with admin rights.
3. Add independent server-side APIs for role intake, candidate consent, evidence approval, matching, interviews and 100-day plan.
4. Put the licensed intelligence adapter behind authenticated server routes, with timeout, budgets, audit logs and human decision authority.
5. Replace the fictional pilot with authenticated test data, then run authorization, RLS, privacy and workflow regression tests.
6. Move code out of Toasty to the dedicated private repo and deploy from it. Toasty can reverse-proxy the independent application during incubation.

## Missing information to replace (not blockers for this scaffold)

Official email/domain; Kristine's actual process templates and 100-day plan; Supabase project URL and keys (secrets must be deployment-only); independent GitHub repo; API licensing contract and endpoint.

This scaffold **does not** mean the Talent module or Peeps agent core has been extracted or integrated.
