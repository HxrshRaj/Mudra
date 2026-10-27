import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { createApp } from "./app.js";

const config = loadConfig();
const pool = createPool(config.mysqlUrl);
await migrate(pool);

// Sessions live in MySQL too, so logins survive a restart.
const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({ clearExpired: true, expiration: 1000 * 60 * 60 }, pool);

await sessionStore.onReady(); // the sessions table must exist before the first request

const app = createApp({ pool, config, sessionStore });
app.listen(config.port, () => {
  console.log(`Mudra server listening on http://localhost:${config.port}`);
});
