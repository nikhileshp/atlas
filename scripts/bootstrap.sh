#!/usr/bin/env bash
# One command from clean checkout to running system:
# dependencies -> containers -> migrations -> seed -> dev server.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] || cp .env.example .env.local

npm install
npx supabase start
npx supabase db reset   # applies supabase/migrations in order
npm run seed
npm run dev
