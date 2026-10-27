import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { startServer, client, login, signIn, newWallet } from "./helpers.mjs";

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test("health reports the database as reachable", async () => {
  const r = await client(srv.base).call("/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, db: true });
});

test("protected route rejects a request with no session", async () => {
  assert.equal((await client(srv.base).call("/api/me")).status, 401);
});

test("full SIWE login creates the user and /api/me returns the wallet", async () => {
  const c = client(srv.base), w = newWallet();
  assert.equal((await login(c, w)).status, 200);
  const me = await (await c.call("/api/me")).json();
  assert.equal(me.address, w.address);
  assert.equal(me.chainId, 11155111);
  const [rows] = await srv.pool.query("SELECT login_count FROM users WHERE address = ?", [w.address.toLowerCase()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].login_count, 1);
});

test("logging in again increments login_count instead of creating a second user", async () => {
  const w = newWallet();
  await login(client(srv.base), w);
  await login(client(srv.base), w);
  const [rows] = await srv.pool.query("SELECT login_count FROM users WHERE address = ?", [w.address.toLowerCase()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].login_count, 2);
});

test("the session id is rotated on login (no session fixation)", async () => {
  const c = client(srv.base), w = newWallet();
  const body = await signIn(c, w); // this call set the pre-login session cookie
  const before = c.cookie;
  assert.equal((await c.call("/api/verify", { method: "POST", json: body })).status, 200);
  assert.notEqual(c.cookie, before);
});

test("sessions are stored in MySQL", async () => {
  const [rows] = await srv.pool.query("SELECT COUNT(*) AS n FROM sessions");
  assert.ok(rows[0].n > 0);
});

test("a captured signature cannot be replayed from another session or the same one", async () => {
  const c = client(srv.base), w = newWallet();
  const body = await signIn(c, w);
  assert.equal((await c.call("/api/verify", { method: "POST", json: body })).status, 200);
  const attacker = client(srv.base);
  assert.equal((await attacker.call("/api/verify", { method: "POST", json: body })).status, 400);
  await attacker.call("/api/nonce");
  assert.equal((await attacker.call("/api/verify", { method: "POST", json: body })).status, 401);
});

test("the nonce is burned after one attempt, even a failed one", async () => {
  const c = client(srv.base), w = newWallet();
  const body = await signIn(c, w, { signer: ethers.Wallet.createRandom() });
  assert.equal((await c.call("/api/verify", { method: "POST", json: body })).status, 401);
  assert.equal((await c.call("/api/verify", { method: "POST", json: body })).status, 400);
});

test("a message signed with a different nonce than the server issued is rejected", async () => {
  assert.equal((await login(client(srv.base), newWallet(), { nonceOverride: "abcdefgh12345678" })).status, 401);
});

test("a signature from another key is rejected", async () => {
  assert.equal((await login(client(srv.base), newWallet(), { signer: ethers.Wallet.createRandom() })).status, 401);
});

test("a message for the wrong chain id is rejected", async () => {
  assert.equal((await login(client(srv.base), newWallet(), { chainId: 1 })).status, 401);
});

test("verify with a missing body or no nonce is rejected", async () => {
  const c = client(srv.base);
  assert.equal((await c.call("/api/verify", { method: "POST", json: {} })).status, 400);
  assert.equal((await c.call("/api/verify", { method: "POST", json: { message: "x", signature: "y" } })).status, 400);
});

test("logout ends the session", async () => {
  const c = client(srv.base);
  await login(c, newWallet());
  assert.equal((await c.call("/api/me")).status, 200);
  await c.call("/api/logout", { method: "POST" });
  assert.equal((await c.call("/api/me")).status, 401);
});

test("an invalid balance address is a 400", async () => {
  assert.equal((await client(srv.base).call("/api/balance/not-an-address")).status, 400);
});

test("auth endpoints are rate limited", async () => {
  const c = client(srv.base);
  let last;
  for (let i = 0; i < 40; i++) last = await c.call("/api/nonce");
  assert.equal(last.status, 429);
});
