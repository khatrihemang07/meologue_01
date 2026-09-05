import type { SqliteDriver } from "../sqlite/driver";
import { backupTableNames, tableColumns } from "./dump";

/**
 * Reads `database.sql` — the lossless SQL dump `dump.ts`'s `dumpDatabase`
 * writes into every Backup — back into typed rows, for Restore (#197) to
 * apply. This is the one place that stands between an arbitrary file on
 * disk and this Device's real database, so it holds a rule that sounds
 * contradictory but is not:
 *
 * - **Structure is validated against the schema this build knows.**
 *   `database.sql` is never handed to `driver.execute` as a raw multi-
 *   statement blob — that would mean trusting a file picked off disk to
 *   contain exactly the SQL this Device is willing to run, which is
 *   exactly the "restore" equivalent of the SQL-injection mistake every
 *   other write in this codebase already avoids by binding parameters
 *   instead of interpolating them. Every statement here is instead parsed
 *   by hand into a table name, a column list and a tuple of literal
 *   values; ../backup/restore.ts then re-inserts those values through its
 *   own parameterized statements. A statement this parser cannot make
 *   sense of — not "a table or column it doesn't recognise" (see below),
 *   but genuinely malformed SQL, a column/value count mismatch, an
 *   unterminated string — refuses the whole file with a reason naming what
 *   was wrong, rather than silently skipping the one statement it choked
 *   on.
 * - **Version skew is best-effort.** A table or column this build's own
 *   already-migrated database doesn't have — an older Backup predating a
 *   later migration, or (less commonly) a newer one naming something this
 *   build has never heard of — is silently dropped from the parsed result,
 *   reported in `skippedTables`/`skippedColumns` rather than refusing the
 *   whole file. `CONTEXT.md`'s own Backup entry exists precisely so an
 *   older Backup can restore and let the running app's migrations bring it
 *   forward from there, and a newer Backup should restore whatever of it
 *   still fits rather than refuse outright because of one field it
 *   predates.
 *
 * "The schema this build knows" is read live off the very database Restore
 * is about to write into — `backupTableNames`/`tableColumns` (./dump.ts),
 * the identical `sqlite_master`/`pragma table_info` introspection
 * `dumpDatabase` itself already uses to decide what a Backup covers — never
 * a hand-maintained list here that could quietly drift from either. An
 * already-open database has already run every migration this build ships
 * with (../sqlite/open.ts always calls `migrate()` first), so this is
 * exactly "what this build knows," with no second copy to keep in sync.
 */

/** One row's parsed content, keyed by column name — only the columns both the file and this build's live schema agree on; see this file's own header comment for why a column either side doesn't recognise is never a key here. */
export interface ParsedRow {
  values: Record<string, unknown>;
}

/** One table's worth of parsed rows — only present when `database.sql` actually declared this table (a `CREATE TABLE` statement for it) *and* this build's own database still has a table by that name. A table entirely absent from the file (an older Backup that predates it) never gets an entry here at all, which is what lets ../backup/restore.ts leave that table completely untouched rather than treating "zero rows in the file" the same as "the file says this table is empty." */
export interface ParsedTable {
  name: string;
  rows: ParsedRow[];
}

export interface ParseBackupSuccess {
  ok: true;
  tables: ParsedTable[];
  /** Every table name the file mentioned that this build's live schema doesn't have — reported, not swallowed (issue #197's own "report what was skipped rather than swallowing it"). */
  skippedTables: string[];
  /** Every `table.column` this build's live schema doesn't have, for a table it does otherwise recognise — `"tasks.some_future_field"`, not a bare column name, since the same column name could plausibly appear on more than one table. */
  skippedColumns: string[];
}

export interface ParseBackupFailure {
  ok: false;
  /** Names what was structurally wrong, for a toast or a log line to show verbatim — never a stack trace or an internal parser state dump. */
  reason: string;
}

export type ParseBackupResult = ParseBackupSuccess | ParseBackupFailure;

// Two alternatives, not one: every migration in ../sqlite/migrations quotes
// its table names with backticks via drizzle-kit's own generator (see
// ./dump.ts's `quoteIdent` doc comment), but ../sqlite/migrator.ts's own
// ledger table is hand-written SQL with no quoting at all — `CREATE TABLE
// ${LEDGER_TABLE} (...)`, LEDGER_TABLE being the bare string
// "meologue_migrations" — so `sqlite_master.sql` for that one table comes
// back unquoted. Group 1 catches the backtick-quoted form, group 2 the
// bare identifier.
const CREATE_TABLE_PATTERN = /^CREATE TABLE (?:`((?:[^`]|``)*)`|(\S+))/i;
const INSERT_INTO_PATTERN = /^INSERT INTO `((?:[^`]|``)*)`\s*\(/i;
// Anchored to the start of whatever immediately follows the column list's
// own closing paren — dumpDatabase always writes "VALUES (" right there,
// with nothing else between — rather than a bare `/VALUES\s*\(/` search
// that could, in principle, find a false match inside a value's own text
// (an Entry body that happens to contain the literal words "VALUES (").
const VALUES_KEYWORD_PATTERN = /^\s*VALUES\s*\(/i;

/** Undoes `dump.ts`'s `quoteIdent` — the doubled-backtick escaping SQLite itself uses. */
function unquoteIdent(quoted: string): string {
  return quoted.replaceAll("``", "`");
}

function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Splits `database.sql`'s full text into individual statements on a
 * top-level `;` — one that isn't sitting inside a single-quoted string
 * literal, since a stored Entry body can itself contain a literal `;`
 * right next to a quote. Mirrors `../sqlite/migrator.ts`'s own
 * `splitStatements`, but on `;` boundaries rather than drizzle-kit's
 * `--> statement-breakpoint` marker, because `dumpDatabase` (./dump.ts)
 * writes plain `;`-terminated SQL with no such marker (see its own header
 * comment for why).
 */
function splitTopLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    current += char;
    if (char === "'") {
      if (inString && sql[i + 1] === "'") {
        // A doubled '' inside a string is one escaped quote, not the
        // string's end — consume both characters as a unit so the quote
        // right after isn't mistaken for a fresh opening quote.
        current += sql[i + 1];
        i += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (char === ";" && !inString) {
      statements.push(current.slice(0, -1));
      current = "";
    }
  }
  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Finds the index of the `)` that closes the `(` at `openIndex`, skipping
 * over any single-quoted string content in between (so a value like
 * `'call me (maybe)'` doesn't fool the depth count) — the identical
 * "walk the text respecting quote state" technique
 * `../platform/tauri-sqlite-driver.ts`'s `toNumberedPlaceholders` already
 * uses for a different reason (finding `?` placeholders outside strings).
 * Returns -1 if the text ends before the matching `)` is found.
 */
function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "'") {
        if (text[i + 1] === "'") {
          i += 1;
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (char === "'") {
      inString = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Splits a parenthesised tuple's *inner* text (no outer parens) into its top-level comma-separated value tokens, respecting quoted strings the same way `findMatchingParen` does. */
function splitTopLevelValues(inner: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (inString) {
      current += char;
      if (char === "'") {
        if (inner[i + 1] === "'") {
          current += inner[i + 1];
          i += 1;
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
    } else if (char === ",") {
      tokens.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0 || tokens.length > 0) {
    tokens.push(current.trim());
  }
  return tokens;
}

/**
 * The inverse of `dump.ts`'s `escapeSqlValue`: turns one literal token back
 * into the JS value it came from. Returns `undefined` for a token that
 * matches none of the four literal shapes `escapeSqlValue` can ever
 * actually produce (`NULL`, a bare number, a single-quoted string, an
 * `X'<hex>'` blob) — see that function's own header comment for why its
 * `boolean` branch is dead in practice and has no literal shape reserved
 * for it here.
 */
function parseSqlLiteral(token: string): { ok: true; value: unknown } | { ok: false } {
  if (token === "NULL") {
    return { ok: true, value: null };
  }
  if (/^-?\d+(\.\d+)?$/.test(token)) {
    return { ok: true, value: Number(token) };
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    const inner = token.slice(1, -1);
    return { ok: true, value: inner.replaceAll("''", "'") };
  }
  if (token.length >= 3 && /^X'[0-9A-Fa-f]*'$/.test(token)) {
    const hex = token.slice(2, -1);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return { ok: true, value: bytes };
  }
  return { ok: false };
}

interface ParsedInsert {
  table: string;
  columns: string[];
  values: string[];
}

/** Parses one `INSERT INTO \`table\` (\`col\`, ...) VALUES (...)` statement's shape — table name, column names and the raw (still-string) value tokens — or `null` if the statement doesn't match that exact shape `dumpDatabase` always emits. */
function parseInsertStatement(statement: string): ParsedInsert | null {
  const tableMatch = INSERT_INTO_PATTERN.exec(statement);
  if (tableMatch === null) {
    return null;
  }
  const table = unquoteIdent(tableMatch[1] ?? "");
  const columnsOpenIndex = tableMatch[0].length - 1;
  const columnsCloseIndex = findMatchingParen(statement, columnsOpenIndex);
  if (columnsCloseIndex === -1) {
    return null;
  }
  const columnList = statement.slice(columnsOpenIndex + 1, columnsCloseIndex);
  const columns = columnList
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = /^`((?:[^`]|``)*)`$/.exec(part);
      return match === null ? null : unquoteIdent(match[1] ?? "");
    });
  if (columns.some((column) => column === null)) {
    return null;
  }

  const afterColumns = statement.slice(columnsCloseIndex + 1);
  const valuesMatch = VALUES_KEYWORD_PATTERN.exec(afterColumns);
  if (valuesMatch === null) {
    return null;
  }
  const valuesOpenIndex = columnsCloseIndex + 1 + valuesMatch.index + valuesMatch[0].length - 1;
  const valuesCloseIndex = findMatchingParen(statement, valuesOpenIndex);
  if (valuesCloseIndex === -1) {
    return null;
  }
  const valuesInner = statement.slice(valuesOpenIndex + 1, valuesCloseIndex);
  const values = splitTopLevelValues(valuesInner);

  return { table, columns: columns as string[], values };
}

/**
 * Parses `database.sql`'s full text against `targetDriver`'s own live
 * schema — see this file's own header comment for the structural-refusal
 * vs. version-skew-skip split this function exists to enforce.
 */
export async function parseBackupDatabase(
  databaseSql: string,
  targetDriver: SqliteDriver,
): Promise<ParseBackupResult> {
  const knownColumnsByTable = new Map<string, Set<string>>();
  for (const name of await backupTableNames(targetDriver)) {
    const columns = await tableColumns(targetDriver, name);
    knownColumnsByTable.set(name, new Set(columns.map((column) => column.name)));
  }

  const rowsByTable = new Map<string, ParsedRow[]>();
  const skippedTables = new Set<string>();
  const skippedColumns = new Set<string>();

  for (const statement of splitTopLevelStatements(databaseSql)) {
    const createMatch = CREATE_TABLE_PATTERN.exec(statement);
    if (createMatch !== null) {
      const name =
        createMatch[1] !== undefined ? unquoteIdent(createMatch[1]) : (createMatch[2] as string);
      if (knownColumnsByTable.has(name)) {
        if (!rowsByTable.has(name)) {
          rowsByTable.set(name, []);
        }
      } else {
        skippedTables.add(name);
      }
      continue;
    }

    if (/^INSERT INTO\b/i.test(statement)) {
      const parsed = parseInsertStatement(statement);
      if (parsed === null) {
        return {
          ok: false,
          reason: `database.sql is not a Backup this build can read: unparseable INSERT statement (${truncate(statement)})`,
        };
      }
      if (parsed.columns.length !== parsed.values.length) {
        return {
          ok: false,
          reason: `database.sql is not a Backup this build can read: \`${parsed.table}\` names ${parsed.columns.length} column(s) but supplies ${parsed.values.length} value(s)`,
        };
      }

      const knownColumns = knownColumnsByTable.get(parsed.table);
      if (knownColumns === undefined) {
        // The whole table is unknown to this build — already recorded by
        // this table's own CREATE TABLE statement above (dumpDatabase
        // always writes one before any of its rows), so this row is
        // simply dropped, not double-reported.
        skippedTables.add(parsed.table);
        continue;
      }

      const rowValues: Record<string, unknown> = {};
      for (let i = 0; i < parsed.columns.length; i += 1) {
        const column = parsed.columns[i] as string;
        const rawValue = parsed.values[i] as string;
        if (!knownColumns.has(column)) {
          skippedColumns.add(`${parsed.table}.${column}`);
          continue;
        }
        const literal = parseSqlLiteral(rawValue);
        if (!literal.ok) {
          return {
            ok: false,
            reason: `database.sql is not a Backup this build can read: \`${parsed.table}\`.\`${column}\` has an unreadable value (${truncate(rawValue)})`,
          };
        }
        rowValues[column] = literal.value;
      }

      const rows = rowsByTable.get(parsed.table);
      if (rows === undefined) {
        // A row for a table whose own CREATE TABLE statement never
        // appeared earlier in the file — dumpDatabase never produces this
        // ordering, so this is exactly the "genuinely malformed" case this
        // parser refuses rather than best-effort-skips.
        return {
          ok: false,
          reason: `database.sql is not a Backup this build can read: an INSERT into \`${parsed.table}\` appears before that table's own CREATE TABLE statement`,
        };
      }
      rows.push({ values: rowValues });
      continue;
    }

    return {
      ok: false,
      reason: `database.sql is not a Backup this build can read: unrecognised statement (${truncate(statement)})`,
    };
  }

  const tables: ParsedTable[] = Array.from(rowsByTable.entries()).map(([name, rows]) => ({
    name,
    rows,
  }));

  return {
    ok: true,
    tables,
    skippedTables: Array.from(skippedTables).sort(),
    skippedColumns: Array.from(skippedColumns).sort(),
  };
}
