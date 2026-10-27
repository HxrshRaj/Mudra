import crypto from "node:crypto";
import http from "node:http";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import mysql from "mysql2/promise";
import { ethers } from "ethers";
import { SiweMessage } from "siwe";
import { createApp } from "../src/app.js";
import { createPool, migrate } from "../src/db.js";
import { loadConfig } from "../src/config.js";

const ADMIN_URL = process.env.MYSQL_ADMIN_URL || "mysql://root@127.0.0.1:3306";

// A throwaway database per test file, so tests never touch each other's rows.
export async function startServer(envOverrides = {}) {
  const dbName = `mudra_test_${crypto.randomBytes(5).toString("hex")}`;
  const admin = await mysql.createConnection(ADMIN_URL);
  await admin.query(`CREATE DATABASE \`${dbName}\``);
  await admin.end();

  const config = loadConfig({
    CLIENT_ORIGIN: "http://localhost:5173",
    SESSION_SECRET: "test-secret",
    MYSQL_URL: `${ADMIN_URL}/${dbName}`,
    ...envOverrides,
  });
  const pool = createPool(config.mysqlUrl);
  await migrate(pool);
  const MySQLStore = MySQLStoreFactory(session);
  const sessionStore = new MySQLStore({ clearExpired: false }, pool);
  await sessionStore.onReady();
  const app = createApp({ pool, config, sessionStore });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    pool,
    config,
    async stop() {
      await new Promise((r) => server.close(r));
      await sessionStore.close();
      await pool.end();
      const a = await mysql.createConnection(ADMIN_URL);
      await a.query(`DROP DATABASE \`${dbName}\``);
      await a.end();
    },
  };
}

// A tiny cookie-keeping HTTP client (one per simulated browser).
export function client(base) {
  let cookie = "";
  async function call(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      opts = { ...opts, body: JSON.stringify(opts.json) };
    }
    const res = await fetch(base + path, { redirect: "manual", ...opts, headers });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return res;
  }
  return { call, get cookie() { return cookie; } };
}

export async function signIn(c, wallet, { chainId = 11155111, nonceOverride, signer } = {}) {
  const { nonce } = await (await c.call("/api/nonce")).json();
  const msg = new SiweMessage({
    domain: "localhost",
    address: wallet.address,
    statement: "Sign in to Mudra with Ethereum.",
    uri: "http://localhost:5173",
    version: "1",
    chainId,
    nonce: nonceOverride ?? nonce,
  }).prepareMessage();
  const signature = await (signer ?? wallet).signMessage(msg);
  return { message: msg, signature };
}

export async function login(c, wallet, opts) {
  const body = await signIn(c, wallet, opts);
  return c.call("/api/verify", { method: "POST", json: body });
}

export const newWallet = () => ethers.Wallet.createRandom();

// A local stand-in for GitHub's OAuth endpoints, spoken over real HTTP.
export async function startFakeProvider(profile = { id: 4242, login: "octo-harsh" }) {
  const state = { codes: new Map(), tokenCalls: 0, profile };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/token" && req.method === "POST") {
      state.tokenCalls++;
      if (!state.codes.has(body.code) || body.client_secret !== "shh") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "bad_verification_code" }));
      }
      state.codes.delete(body.code); // authorization codes are single-use
      return res.end(JSON.stringify({ access_token: "gho_test_token", token_type: "bearer" }));
    }
    if (req.url === "/user" && req.headers.authorization === "Bearer gho_test_token") {
      return res.end(JSON.stringify(state.profile));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    issueCode() {
      const code = crypto.randomBytes(8).toString("hex");
      state.codes.set(code, true);
      return code;
    },
    stop: () => new Promise((r) => server.close(r)),
  };
}
