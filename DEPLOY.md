# Deploying Atlas

Target: **Supabase Cloud** (Postgres, Auth, Storage) + **Vercel** (the Next.js
app). Both free tiers are enough to start. Everything below is a config change
except three repo additions already made for this purpose:

- `supabase/migrations/20260913000003_storage_bucket.sql` — creates the
  `artifacts` bucket (locally the seed did this; hosted has no seed)
- `scripts/create-admin.ts` (`npm run create-admin`) — creates the org and
  invites the first admin, since there is no seed to do it
- this file

Work through the steps in order. Each step ends with a check.

---

## Step 1 — Put the code on GitHub

Vercel deploys from a Git provider, and there is no remote yet.

1. Go to https://github.com/new. Name it `atlas`, keep it **Private**, do
   **not** add a README or .gitignore (the repo already has them). Create.
2. Back in the terminal:

   ```bash
   cd ~/Projects/atlas
   git remote add origin git@github.com:<your-github-user>/atlas.git
   git push -u origin main
   ```

   If SSH is not set up, use the HTTPS URL GitHub shows instead and sign in
   with a personal access token when prompted.

**Check:** refresh the GitHub page; you should see the commits and the
`supabase/migrations` folder. Confirm `.env.local` is **not** there
(it is gitignored).

---

## Step 2 — Create the Supabase project

1. Go to https://supabase.com/dashboard → **New project**.
2. Organization: yours. Name: `atlas`. Database password: generate a strong
   one and **save it in a password manager** — you need it in step 3 and it
   is not shown again. Region: closest to your users. Create.
3. Wait for the project to finish provisioning (about two minutes).
4. Collect five values. In the left sidebar go to
   **Project Settings → API**:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** key (click Reveal) → `SUPABASE_SERVICE_ROLE_KEY`
     (server-only; never put it in client code or commit it)

   Then click **Connect** at the top of the project page, tab
   **Session pooler** (not Direct, which is IPv6-only on the free tier):
   - the `postgresql://postgres.<ref>:...@...pooler.supabase.com:5432/postgres`
     string with your password filled in → `SUPABASE_DB_URL`. Nothing in the
     app reads this; it is for `psql` convenience only and can be left out of
     Vercel.

   And the project reference (the short id in the project URL,
   `https://supabase.com/dashboard/project/<ref>`) → used in step 3.

5. Create a local, gitignored file holding the hosted values so scripts can
   target production without touching `.env.local`:

   ```bash
   cp .env.example .env.production.local
   ```

   Edit `.env.production.local`: replace the four Supabase values with the
   ones above, set `SITE_URL` to the Vercel URL once you have it (step 6;
   use `https://atlas.vercel.app` as a placeholder for now), set
   `EDGAR_CACHE_DIR=/tmp/edgar`, and **delete the `SEED_USER_PASSWORD` line**.

**Check:** `.env.production.local` exists, is not in `git status`, and holds
a URL of the form `https://<ref>.supabase.co`.

---

## Step 3 — Push the schema

This applies the three migrations (schema, RLS, bucket) to the hosted
database. It never runs the seed.

```bash
cd ~/Projects/atlas
npx supabase login                       # opens a browser once
npx supabase link --project-ref <ref>    # asks for the database password
npx supabase db push
```

**Check:** in the dashboard, **Table Editor** should list `org`, `profile`,
`entity`, `entity_alias`, `artifact`, `artifact_entity`, `quality_score`,
`scenario`, `position_input`, `decision`. **Storage** should show a private
bucket named `artifacts`.

---

## Step 4 — Mirror the auth settings

These live in `supabase/config.toml` locally and do **not** travel with
`db push`. Set each in the dashboard under **Authentication**.

1. **Sign In / Providers → Email**: keep Email enabled. Turn **off**
   "Allow new users to sign up" (Atlas is invite-only; admins still invite).
   Keep "Confirm email" on.
2. **URL Configuration**:
   - Site URL: your app origin, e.g. `https://atlas.vercel.app`
     (update after step 6 if the URL differs)
   - Redirect URLs: add `https://atlas.vercel.app/auth/confirm`
     and `https://atlas.vercel.app/**`
3. **Emails → Templates → Invite user**: replace the body with the contents
   of `supabase/templates/invite.html`. The default template uses an
   implicit-flow link that the server-side confirm route cannot consume;
   the custom one carries `token_hash`, which it can.
   **The dashboard only allows editing templates once custom SMTP is
   enabled**, so do step 5 first if the editor is locked.
4. **Rate Limits**: defaults are fine hosted. (The local config raises the
   sign-in limit only because the dev user switcher signs in on every
   switch; that switcher does not ship.)

**Check:** URL Configuration shows your domain, and the invite template
contains the text `token_hash={{ .TokenHash }}`.

---

## Step 5 — Custom SMTP for invite emails

Supabase's built-in mailer sends only a few emails per hour and only to
addresses on your Supabase team, and the dashboard refuses to edit email
templates until custom SMTP is on. So this is required, not optional.

**No domain yet? Use Gmail with an app password.** Turn on 2-Step
Verification, create an app password at
https://myaccount.google.com/apppasswords, then in SMTP Settings use host
`smtp.gmail.com`, port `465`, username = your Gmail address, password = the
app password, sender = the same address. About 500 messages/day. Swap to a
domain-based sender (below) once the firm has one.

**With a domain:** Resend is the least setup; Postmark, SendGrid, and SES
also work.

1. Sign up at https://resend.com, add and verify a domain you control
   (DNS records they give you), then create an API key.
2. In Supabase: **Project Settings → Authentication → SMTP Settings**,
   enable custom SMTP:
   - Sender email: `atlas@<your-verified-domain>`
   - Sender name: `Atlas`
   - Host: `smtp.resend.com`, Port: `465`
   - Username: `resend`, Password: the API key
3. Save.

No domain yet? Resend lets you send to **your own** signup email without
a verified domain, which is enough to complete step 7 and test. Verify a
domain before inviting colleagues.

**Check:** the SMTP form saves without error. The real test is step 7.

---

## Step 6 — Deploy the app to Vercel

1. Go to https://vercel.com/new, sign in with GitHub, and import the
   `atlas` repository. Framework preset auto-detects **Next.js**; leave the
   build settings alone.
2. Open **Environment Variables** on the import screen and add every line
   from `.env.production.local` (name and value, one per row). That is:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
   | `SUPABASE_DB_URL` | Session pooler URI (optional; unused by the app) |
   | `SITE_URL` | `https://atlas.vercel.app` (fix after first deploy) |
   | `SUPABASE_STORAGE_BUCKET` | `artifacts` |
   | `EDGAR_BASE_URL` | `https://www.sec.gov` |
   | `EDGAR_DATA_BASE_URL` | `https://data.sec.gov` |
   | `EDGAR_USER_AGENT` | `Atlas <your-email>` (the SEC requires a contact) |
   | `EDGAR_CACHE_DIR` | `/tmp/edgar` (the only writable path on Vercel) |

   Do **not** add `SEED_USER_PASSWORD`.
3. Click **Deploy**. The first build takes two to three minutes.
4. Note the assigned URL (Project → Domains). If it is not exactly what you
   used for `SITE_URL`, update `SITE_URL` in Vercel
   (Settings → Environment Variables), update the Site URL and Redirect URLs
   in Supabase (step 4.2), update `.env.production.local`, and **Redeploy**
   from the Deployments tab. Environment variables are baked in at build time.

Notes:
- Vercel builds on Node 22, so the `ws` polyfill for Node 20 no-ops. Nothing
  to change.
- The dev user switcher is gated on `NODE_ENV === "development"` and is
  absent from the production bundle.
- The EDGAR cache in `/tmp` is per-instance and ephemeral. Entity lookups
  just hit the SEC slightly more often; the User-Agent keeps that compliant.

**Check:** open the Vercel URL. You should land on the login page. (No one
can log in yet; that is step 7.)

---

## Step 7 — Create the first admin

There is no seed in production, so the first org and admin come from the
script. It does exactly what the in-app invite does.

```bash
cd ~/Projects/atlas
ENV_FILE=.env.production.local npm run create-admin -- \
  --org "Your Firm Name" \
  --email you@yourfirm.com \
  --name "Your Name"
```

Then open that inbox, click **Accept the invitation**, and set a password.
You are now logged in as the admin.

**Check:** you land in the app with an empty entity list. Visit
`/admin/users` and invite a colleague (any role); they receive the same email
flow. From here on, all user management happens inside the app.

If the invite email never arrives: check the Resend dashboard for a
delivery log. If Resend shows nothing, the SMTP settings (step 5) did not
save. If Resend shows a bounce, the domain is not verified for that
recipient yet.

---

## Step 8 — Optional: your own domain

1. Vercel → Project → Settings → Domains → add `atlas.yourfirm.com`, then
   create the CNAME record it shows at your DNS provider.
2. Change `SITE_URL` in Vercel to the new origin and redeploy.
3. Change the Supabase Site URL and Redirect URLs (step 4.2) to match.

---

## Ongoing

- **Schema changes**: add a migration locally, test with
  `npx supabase db reset`, commit, then `npx supabase db push`. Never edit
  the hosted database by hand; it breaks the append-only guarantee's audit
  trail.
- **Import staging**: batches accumulate in `import_batch`; discarded and
  imported batches keep their staged attachment objects. Harmless; prune with
  the service role if storage fills.
- **App changes**: push to `main`; Vercel deploys automatically. Pull
  requests get preview URLs, but auth redirects only work on the origin
  listed in Supabase, so test auth flows on `main`.
- **Backups**: Supabase free tier has no automatic backups. Pro tier adds
  daily backups; for a system of record that is the right tier once real
  research is in it.
- **Secrets**: the service role key bypasses RLS. It lives only in Vercel's
  environment variables and in `.env.production.local` on your machine.
  If it leaks, rotate it in Project Settings → API.
