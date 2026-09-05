import type { SqliteDriver } from "../sqlite/driver";

/**
 * Prefix every internal table SQLite itself creates (`sqlite_sequence`,
 * `sqlite_stat1`, and so on) carries — never application data, so a Backup
 * has nothing to lose by excluding the whole family rather than naming each
 * one it happens to know about today.
 */
const SQLITE_INTERNAL_PREFIX = "sqlite_";

/** SQLite's own verbatim prefix for a virtual table's `CREATE` statement, stored as-is in `sqlite_master.sql` (case-sensitive — this is what SQLite itself emits, not user-typed SQL). */
const VIRTUAL_TABLE_PREFIX = "CREATE VIRTUAL TABLE";

interface TableRow {
  name: string;
  /** `sqlite_master.sql` — null for an internal `sqlite_sequence`-style row, which carries no `CREATE` text of its own. */
  sql: string | null;
}

/**
 * Wraps an identifier in backticks, doubling any backtick already inside it
 * — the same escaping SQLite itself uses, and the same quoting style every
 * migration in ../sqlite/migrations already writes table and column names
 * in (see 0000_initial.sql). Exported for ./parse.ts and ./restore.ts
 * (issue #197): both need to build a `CREATE TABLE`-quoted identifier back
 * out of a plain table/column name string the same way this file already
 * does, and a second, independently-written escaper is exactly the kind of
 * thing that could quietly drift from this one — the identical reasoning
 * `backupTableNames`'s own header comment gives for sharing "every table"
 * between `dumpDatabase` and ../backup/meta.ts.
 */
export function quoteIdent(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

/** `Uint8Array` -> uppercase hex, with no library and no `Buffer` — this package has no Node built-ins to reach for (ADR 0007's own driver seam is what lets it stay that way). */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex.toUpperCase();
}

/**
 * Renders one raw SQLite value as a literal that can sit inside a `VALUES`
 * list, matched to the four kinds of value a driver's `execute` can
 * actually hand back for this schema (../sqlite/schema.ts declares only
 * `text` and `integer` columns, but this function does not assume that —
 * see its own `boolean`/blob branches below, which schema.ts never
 * produces today but which drizzle's own `{ mode: "boolean" }` columns on
 * `projects`/`sections` normally decode into once a *reader* passes them
 * back through drizzle; this dump reads with a bare `SELECT`, bypassing
 * drizzle entirely, so what actually lands here is SQLite's own
 * integer/text/blob/null, never a decoded JS boolean — this function
 * still handles one defensively rather than throwing on a value shape a
 * future column could plausibly produce).
 *
 * This is the one place a subtle mistake would corrupt every Backup this
 * app ever produces, so each branch is deliberately narrow:
 *
 * - `NULL`, unquoted — SQLite's own literal, not the string `"null"`.
 * - A number, bare — SQLite has no quoting for numeric literals.
 * - A string, single-quoted, with every embedded `'` doubled — SQL's own
 *   escaping. Nothing else needs escaping: unlike a shell or a regex,
 *   SQLite string literals have no backslash-escape syntax at all, so a
 *   newline, a backslash, or an emoji all sit between the quotes verbatim,
 *   as the exact bytes they already are. `dump.test.ts` proves this against
 *   a body carrying all four at once, then round-trips it back out.
 * - A blob (`Uint8Array`), as `X'<hex>'` — SQLite's own blob-literal syntax.
 * - A `bigint` (a driver may hand one back for an integer past
 *   `Number.MAX_SAFE_INTEGER`, e.g. node:sqlite's own documented behaviour),
 *   stringified bare, the same as a plain number.
 */
export function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "string") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // Every column this schema declares is text or integer
      // (../sqlite/schema.ts) — real Device data can never actually reach
      // this branch. It exists so a future column that somehow produces
      // NaN/Infinity fails loudly here rather than writing an unquoted,
      // syntactically-invalid token into the dump that only breaks on
      // replay, far from the write that caused it.
      throw new Error(`backup: cannot dump a non-finite number (${value})`);
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (value instanceof Uint8Array) {
    return `X'${toHex(value)}'`;
  }
  throw new Error(`backup: cannot dump a value of type ${typeof value}`);
}

/**
 * Every table `sqlite_master` knows about, split into the entity/ledger
 * tables a Backup carries and the search-index tables it doesn't —
 * `dumpDatabase` below and `../backup/meta.ts`'s row-count pass both need
 * exactly this list, and computing it in one place is what keeps the two
 * from ever quietly disagreeing about what "every table" means (the same
 * reasoning ../sqlite/row-mapping.ts's own header comment gives for why its
 * translation lives in exactly one place rather than once per caller).
 *
 * Reads `sqlite_master` rather than naming tables here, so a table added by
 * a migration this file was never told about — issue #196, running in
 * parallel with this one, adds a column to seven existing tables, and any
 * future migration could add a whole new table — is picked up automatically
 * the next time a Backup is taken, with no change to this function.
 *
 * A table is excluded when:
 * - its name is prefixed `sqlite_` (SQLite's own internal bookkeeping —
 *   `sqlite_sequence` and friends — never application data); or
 * - its own `CREATE` statement is a `CREATE VIRTUAL TABLE` (an FTS5 index —
 *   `entries_fts`, `tasks_fts`, `task_descriptions_fts`, ../sqlite/
 *   migrations/index.ts's own header comment for how each came to exist);
 *   or
 * - its name is prefixed with a virtual table's own name plus `_` — FTS5's
 *   own convention for the shadow tables it creates alongside the virtual
 *   table itself (`_data`, `_idx`, `_content`, `_docsize`, `_config`; see
 *   ADR 0014 for why `entries_fts` has no `rowid` binding to `entries`, a
 *   separate fact from the shadow tables this exclusion is about). These
 *   are derived entirely from the entity tables a Backup already carries —
 *   Restore (#197) rebuilds them from scratch rather than replaying them.
 */
async function listBackupTables(driver: SqliteDriver): Promise<TableRow[]> {
  const result = await driver.execute(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
    [],
    "all",
  );
  const tables: TableRow[] = result.rows.map((row) => {
    const [name, sql] = row as [string, string | null];
    return { name, sql };
  });

  const virtualTableNames = tables
    .filter((table) => table.sql?.startsWith(VIRTUAL_TABLE_PREFIX))
    .map((table) => table.name);

  return tables.filter((table) => {
    if (table.sql === null || table.name.startsWith(SQLITE_INTERNAL_PREFIX)) {
      return false;
    }
    return !virtualTableNames.some(
      (virtualName) => table.name === virtualName || table.name.startsWith(`${virtualName}_`),
    );
  });
}

/** The names `listBackupTables` above keeps, in the same order — `../backup/meta.ts`'s row-count pass needs just the names, not each table's own `CREATE` text. */
export async function backupTableNames(driver: SqliteDriver): Promise<string[]> {
  return (await listBackupTables(driver)).map((table) => table.name);
}

export interface ColumnInfo {
  name: string;
}

/**
 * Every column `table` actually has, in on-disk order — `pragma table_info`
 * orders by `cid`, the same order a bare `SELECT *` against this table
 * would return, so building the explicit column list from this rather than
 * trusting `SELECT *` is belt-and-braces, not a behaviour change: it's what
 * lets the `INSERT` statement below name every column explicitly rather
 * than depending on that ordering staying implicit.
 *
 * Exported for ./parse.ts (issue #197): Restore's "structure is validated
 * against the schema this build knows" rule (issue #197's own framing)
 * means asking this Device's own already-migrated database what columns a
 * table actually has right now, the same live-introspection technique this
 * function already uses for dumping rather than a hand-maintained list —
 * see `listBackupTables`'s own header comment for why reading
 * `sqlite_master` beats naming tables here, the identical argument applied
 * a second time to columns.
 */
export async function tableColumns(driver: SqliteDriver, tableName: string): Promise<ColumnInfo[]> {
  const result = await driver.execute(`PRAGMA table_info(${quoteIdent(tableName)})`, [], "all");
  return result.rows.map((row) => {
    const columns = row as unknown[];
    // pragma table_info's own column order: cid, name, type, notnull,
    // dflt_value, pk (https://www.sqlite.org/pragma.html#pragma_table_info)
    // — index 1 is `name`.
    return { name: columns[1] as string };
  });
}

/**
 * A SQL text dump of every table this Device's database holds, minus its
 * FTS5 search indexes and their shadow tables (`listBackupTables` above) —
 * the core of a Backup (issue #195, CONTEXT.md's Backup entry). Reading the
 * database's own schema (`sqlite_master`, `pragma table_info`) rather than
 * naming tables or columns here is what lets this survive a migration —
 * issue #196's own new column on seven tables included — with no edit to
 * this file.
 *
 * For each table kept, this emits that table's own `CREATE TABLE` statement
 * verbatim from `sqlite_master.sql`, followed by one `INSERT INTO
 * <table> (<columns>) VALUES (...)` per row, columns and rows both read
 * through `driver.execute` — the one seam this package ever talks to a
 * database through (ADR 0007) — never through drizzle, so nothing here
 * depends on ../sqlite/schema.ts agreeing with what's actually on disk.
 *
 * No `WHERE` clause anywhere: every row this driver can see comes back,
 * tombstones (`deleted_at is not null`) included, and the `kv` table and
 * `meologue_migrations` ledger travel exactly like every entity table — a
 * Backup that quietly omitted a table because it didn't look important
 * enough is the ADR 0016 failure this ticket exists to not repeat (issue
 * #195's own framing: "is my data safe", not "can I read the interesting
 * parts").
 *
 * The returned string is plain, semicolon-terminated SQL with one statement
 * per line — no `--> statement-breakpoint` markers, unlike
 * ../sqlite/migrations/index.ts's own migration files. Those markers exist
 * because ../sqlite/migrator.ts has no transaction to run several
 * statements inside (ADR 0007's amendment, ADR 0028) and has to run each
 * one individually with its own swallow-or-rethrow logic; a Backup's dump
 * has no such constraint; it's read back with `node:sqlite`'s own
 * `exec()`, or `sqlite3`'s own CLI, either of which already runs a
 * multi-statement string as a single batch (`dump.test.ts`'s round-trip
 * test proves exactly this, feeding the output straight to a second, fresh
 * `NodeSqliteDriver`).
 */
export async function dumpDatabase(driver: SqliteDriver): Promise<string> {
  const tables = await listBackupTables(driver);
  const statements: string[] = [];

  for (const table of tables) {
    // Every kept table has a non-null `sql` — listBackupTables already
    // filters out the one case (an internal `sqlite_%` row) where it isn't.
    statements.push(`${(table.sql as string).trim()};`);

    const columns = await tableColumns(driver, table.name);
    if (columns.length === 0) {
      continue;
    }
    const columnList = columns.map((column) => quoteIdent(column.name)).join(", ");
    const selectSql = `SELECT ${columnList} FROM ${quoteIdent(table.name)}`;
    const { rows } = await driver.execute(selectSql, [], "all");
    for (const row of rows) {
      const values = (row as unknown[]).map(escapeSqlValue).join(", ");
      statements.push(`INSERT INTO ${quoteIdent(table.name)} (${columnList}) VALUES (${values});`);
    }
  }

  return statements.join("\n");
}
