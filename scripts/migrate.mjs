import "dotenv/config";
import { loadConfig } from "../src/config.mjs";
import { createPool, closePool } from "../src/db.mjs";
import { runMigrations } from "../src/db.mjs";

const config = loadConfig();
const pool = createPool(config);
try {
  await runMigrations(pool);
  console.log("Migrations applied.");
} finally {
  await closePool(pool);
}
