import { config as loadEnv } from "dotenv";
import Database from "better-sqlite3";

loadEnv();

function fail(message: string): never {
  console.error(`HEALTHCHECK_FAIL: ${message}`);
  process.exit(1);
}

function main() {
  const botToken = process.env.BOT_TOKEN;
  const dbPath = process.env.DATABASE_PATH ?? "./shop.db";

  if (!botToken || botToken.trim().length < 20) {
    fail("BOT_TOKEN is missing or invalid");
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    const row = db.prepare("SELECT 1 as ok").get() as { ok: number } | undefined;
    if (!row || row.ok !== 1) {
      fail("Database ping failed");
    }
  } catch (error: any) {
    fail(`Database open/query failed: ${error?.message ?? "unknown"}`);
  } finally {
    try {
      db?.close();
    } catch {
      // no-op
    }
  }

  console.log("HEALTHCHECK_OK");
}

main();
