// backend/src/db/index.ts
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import path from "path";
import fs from "fs";

export async function initDB(): Promise<Database> {
  // ----------------------------
  // Paths
  // ----------------------------
  const dbPath = path.resolve(process.cwd(), "data/database.sqlite"); // database file
  const schemaPath = path.resolve(__dirname, "schema.sql");            // schema.sql

  // Ensure /data directory exists
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`📂 Created data directory at ${dataDir}`);
  }

  // ----------------------------
  // Open DB
  // ----------------------------
  console.log("🗄️ Opening database at:", dbPath);
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  // Enable foreign keys (important for ON DELETE CASCADE)
  await db.exec("PRAGMA foreign_keys = ON;");

  // ----------------------------
  // Check if tables exist
  // ----------------------------
  const check = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1;"
  );

  // ----------------------------
  // Apply schema if DB is empty
  // ----------------------------
  if (!check) {
    console.log("⚙️ No tables found — applying schema.sql...");
    const schema = fs.readFileSync(schemaPath, "utf8");
    await db.exec(schema);
    console.log("✅ Schema applied successfully.");
  } else {
    console.log("✅ Database already initialized.");
  }

  return db;
}