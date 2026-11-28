// One-off check (pre-10.6 fix, 2026-11-28): list accounts whose username is
// now reserved for group mentions (`@all`, `@everyone`, role names…).
//
// Such a person can no longer be mentioned by name (`@all` means everyone),
// and nobody new can take the name. Read only: it changes nothing. Rename the
// accounts it lists (ADMIN_CONSOLE.md §24; today a database edit) or ask the
// people to pick another username.
//
// Usage (with that environment's DATABASE_URL in the shell, never committed):
//   DATABASE_URL=… node scripts/list-reserved-username-conflicts.mjs
//
// The list comes from RESERVED_FOR_GROUP_MENTIONS in lib/username.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The reserved group-mention names, read from lib/username.ts (one source). */
export function readReservedGroupNames(source = fs.readFileSync(path.join(root, "lib/username.ts"), "utf8")) {
  const match = source.match(/RESERVED_FOR_GROUP_MENTIONS\s*=\s*\[([\s\S]*?)\]/);
  if (!match) throw new Error("RESERVED_FOR_GROUP_MENTIONS not found in lib/username.ts");
  return [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL to the database to check.");
    process.exit(1);
  }
  const names = readReservedGroupNames();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Ids and usernames only: no emails or names in the output.
    const { rows } = await client.query(
      `SELECT id, username, display_username AS "displayUsername"
         FROM users
        WHERE deleted_at IS NULL
          AND (lower(username) = ANY($1) OR lower(display_username) = ANY($1))
        ORDER BY username`,
      [names]
    );
    if (rows.length === 0) {
      console.log(`No account uses a reserved name (${names.length} checked).`);
      return;
    }
    console.log(`${rows.length} account(s) use a name now reserved for group mentions:`);
    for (const r of rows) console.log(`  ${r.id}  @${r.username ?? r.displayUsername}`);
    process.exitCode = 2;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
