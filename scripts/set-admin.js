const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");
loadEnvFile(path.join(ROOT, ".env"));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/audio_guestbook";
const ssl = process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString, ssl });

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), 100000, 32, "sha256").toString("hex");
}

const ENTER_CODES = [10, 13, 4];
const CTRL_C_CODE = 3;
const BACKSPACE_CODES = [127, 8];

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("This script needs an interactive terminal to hide your password input."));
      return;
    }

    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let input = "";
    const onData = (chunk) => {
      const code = chunk.toString().charCodeAt(0);

      if (ENTER_CODES.includes(code)) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
        return;
      }

      if (code === CTRL_C_CODE) {
        process.stdout.write("\n");
        process.exit(1);
        return;
      }

      if (BACKSPACE_CODES.includes(code)) {
        input = input.slice(0, -1);
        return;
      }

      input += chunk.toString();
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("Usage: node scripts/set-admin.js <email>");
    process.exitCode = 1;
    return;
  }

  const password = await promptHidden("New admin password: ");
  const confirm = await promptHidden("Confirm password: ");

  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exitCode = 1;
    return;
  }
  if (password !== confirm) {
    console.error("Passwords did not match.");
    process.exitCode = 1;
    return;
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);

  await pool.query("DELETE FROM admin_users WHERE email <> $1", [email]);
  await pool.query(`
    INSERT INTO admin_users (email, password_hash, password_salt)
    VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt
  `, [email, hash, salt]);

  console.log(`Admin credentials set for ${email}. Any other admin accounts were removed.`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
