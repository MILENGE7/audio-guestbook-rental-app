const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");
const schemaPath = path.join(ROOT, "db", "schema.sql");
const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/audio_guestbook";
const ssl = process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString, ssl });

async function main() {
  const schema = await fs.readFile(schemaPath, "utf8");
  await pool.query(schema);
  console.log("PostgreSQL schema is ready.");
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
