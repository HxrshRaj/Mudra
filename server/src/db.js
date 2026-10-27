import mysql from "mysql2/promise";

// Plain SQL migrations, applied in order and recorded in `schema_migrations`.
const MIGRATIONS = [
  {
    id: "001_users_and_linked_accounts",
    sql: [
      `CREATE TABLE users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        address CHAR(42) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        login_count INT UNSIGNED NOT NULL DEFAULT 1,
        UNIQUE KEY uq_users_address (address)
      ) ENGINE=InnoDB`,
      `CREATE TABLE linked_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        provider VARCHAR(20) NOT NULL,
        provider_user_id VARCHAR(64) NOT NULL,
        login VARCHAR(100) NOT NULL,
        linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_provider_account (provider, provider_user_id),
        UNIQUE KEY uq_user_provider (user_id, provider),
        CONSTRAINT fk_linked_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,
    ],
  },
];

export function createPool(url) {
  return mysql.createPool({ uri: url, connectionLimit: 10, timezone: "Z" });
}

export async function migrate(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id VARCHAR(100) NOT NULL PRIMARY KEY,
       applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`
  );
  const [rows] = await pool.query("SELECT id FROM schema_migrations");
  const done = new Set(rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    for (const stmt of m.sql) await pool.query(stmt);
    await pool.query("INSERT INTO schema_migrations (id) VALUES (?)", [m.id]);
  }
}

// Create the user on first login; afterwards just bump the login counters.
export async function upsertUser(pool, address) {
  const addr = address.toLowerCase();
  await pool.query(
    `INSERT INTO users (address) VALUES (?)
     ON DUPLICATE KEY UPDATE last_login_at = CURRENT_TIMESTAMP, login_count = login_count + 1`,
    [addr]
  );
  const [rows] = await pool.query("SELECT id, address, login_count FROM users WHERE address = ?", [addr]);
  return rows[0];
}

export async function getLinkedAccounts(pool, userId) {
  const [rows] = await pool.query(
    "SELECT provider, provider_user_id, login, linked_at FROM linked_accounts WHERE user_id = ?",
    [userId]
  );
  return rows;
}

// Returns "linked" | "conflict" (this provider account already belongs to another wallet).
export async function linkAccount(pool, userId, provider, providerUserId, login) {
  const [owner] = await pool.query(
    "SELECT user_id FROM linked_accounts WHERE provider = ? AND provider_user_id = ?",
    [provider, providerUserId]
  );
  if (owner.length && owner[0].user_id !== userId) return "conflict";
  await pool.query(
    `INSERT INTO linked_accounts (user_id, provider, provider_user_id, login) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE provider_user_id = VALUES(provider_user_id), login = VALUES(login)`,
    [userId, provider, providerUserId, login]
  );
  return "linked";
}

export async function unlinkAccount(pool, userId, provider) {
  const [res] = await pool.query("DELETE FROM linked_accounts WHERE user_id = ? AND provider = ?", [
    userId,
    provider,
  ]);
  return res.affectedRows > 0;
}
