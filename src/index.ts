import "./db.js";
import { launchBot } from "./bot.js";
import { startDbBackupLoop } from "./db-backup.js";

launchBot().catch((error) => {
  console.error("Failed to launch bot:", error);
  process.exit(1);
});

startDbBackupLoop();
