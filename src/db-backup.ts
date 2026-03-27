import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appConfig } from "./config.js";
import { repo } from "./db.js";

function cleanupOldBackups(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => ({ file: f, full: join(dir, f), ts: Number(f.split("-")[1]?.replace(".sqlite", "")) || 0 }))
    .filter((x) => x.ts > 0)
    .sort((a, b) => a.ts - b.ts);

  const cutoff = Date.now() - appConfig.DB_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const item of files) {
    if (item.ts < cutoff) {
      try {
        rmSync(item.full, { force: true });
      } catch {
        // keep loop alive
      }
    }
  }
}

async function makeBackup() {
  mkdirSync(appConfig.DB_BACKUP_DIR, { recursive: true });
  const ts = Date.now();
  const file = join(appConfig.DB_BACKUP_DIR, `shop-${ts}.sqlite`);
  await repo.backupTo(file);
  cleanupOldBackups(appConfig.DB_BACKUP_DIR);
  console.log(`DB backup created: ${file}`);
}

export function startDbBackupLoop() {
  void makeBackup().catch((e) => console.error("Initial DB backup failed:", e));
  setInterval(() => {
    void makeBackup().catch((e) => console.error("Scheduled DB backup failed:", e));
  }, appConfig.DB_BACKUP_INTERVAL_MINUTES * 60 * 1000);
}
