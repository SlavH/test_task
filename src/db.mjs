import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "..", "migrations");

export function createPool(config = {}) {
  const connectionString =
    config.databaseUrl || process.env.DATABASE_URL || "";
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const ssl =
    config.ssl ??
    (connectionString.includes("sslmode=require") ||
    /render\.com|neon\.tech|supabase/.test(connectionString) ||
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false);
  return new Pool({
    connectionString,
    ssl,
    max: Number(config.poolMax || process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

async function migrationsTableExists(pool) {
  try {
    await pool.query("SELECT 1 FROM schema_migrations LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

export async function runMigrations(pool) {
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const tableExists = await migrationsTableExists(pool);
  for (const file of files) {
    const version = file;
    let applied = false;
    if (tableExists) {
      const existing = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version],
      );
      applied = Boolean(existing.rowCount);
    }
    if (applied) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [version],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function closePool(pool) {
  if (pool) await pool.end();
}
