import { config } from "dotenv";

// Integration tests run against the live local Supabase stack and read the
// same .env.local the app uses. Unit tests may override vars per-case.
config({ path: ".env.local" });
