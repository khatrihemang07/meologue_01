import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` is the only drizzle-kit command used on this
// project — it produces SQL from the schema without touching a live
// database. `drizzle-kit push` must never be run here: it diffs the schema
// against a live database and applies the result directly, without
// recording anything in our migration ledger (see ./src/sqlite/migrator.ts
// and ADR 0007), so the ledger and reality would silently diverge.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/sqlite/schema.ts",
  out: "./src/sqlite/migrations",
});
