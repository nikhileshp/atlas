/**
 * First-admin bootstrap for a hosted (unseeded) Atlas instance.
 *
 * Creates one org and invites one admin user into it by email, mirroring
 * exactly what the in-app invite does (actions/admin.ts): the org and role
 * claims ride in app_metadata, and a profile row is written. The invitee
 * receives the invite email and sets a password via /auth/confirm. After
 * that, further users are invited from /admin/users inside the app.
 *
 * Usage (env file holds the HOSTED Supabase URL + service role key):
 *   ENV_FILE=.env.production.local npx tsx scripts/create-admin.ts \
 *     --org "Meridian Capital Partners" \
 *     --email you@firm.com \
 *     --name "Your Name"
 *
 * Re-running with the same --org name reuses the existing org.
 */

import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local" });

import "../lib/ws-polyfill";
import { createClient } from "@supabase/supabase-js";
import { env } from "../lib/env";

function arg(flag: string): string {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    console.error(`Missing ${flag}. See the header of scripts/create-admin.ts.`);
    process.exit(1);
  }
  return v;
}

function fail(step: string, error: unknown): never {
  console.error(`create-admin failed at: ${step}`);
  console.error(error);
  process.exit(1);
}

async function main(): Promise<void> {
  const orgName = arg("--org");
  const email = arg("--email").trim().toLowerCase();
  const displayName = arg("--name");

  const admin = createClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // org (idempotent on name)
  const { data: existing, error: lookupErr } = await admin
    .from("org")
    .select("id")
    .eq("name", orgName)
    .maybeSingle();
  if (lookupErr) fail("lookup org", lookupErr);

  let orgId = existing?.id as string | undefined;
  if (!orgId) {
    const { data, error } = await admin
      .from("org")
      .insert({ name: orgName })
      .select("id")
      .single();
    if (error || !data) fail("create org", error);
    orgId = data.id;
    console.log(`Created org "${orgName}" (${orgId})`);
  } else {
    console.log(`Using existing org "${orgName}" (${orgId})`);
  }

  // invite (sends the email; SITE_URL must be the hosted origin)
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    email,
    { redirectTo: `${env("SITE_URL")}/auth/confirm` },
  );
  if (inviteErr || !invited.user) fail("invite user", inviteErr);
  const userId = invited.user.id;

  const { error: metaErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { org_id: orgId, role: "admin" },
  });
  if (metaErr) fail("set app_metadata", metaErr);

  const { error: profileErr } = await admin.from("profile").insert({
    user_id: userId,
    org_id: orgId,
    email,
    display_name: displayName,
    role: "admin",
  });
  if (profileErr) fail("insert profile", profileErr);

  console.log(`Invited ${email} as admin. Check that inbox for the invite link.`);
}

main().catch((e) => fail("unexpected", e));
