import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, startFakeProvider, client, login, newWallet } from "./helpers.mjs";

let srv, gh;
before(async () => {
  gh = await startFakeProvider();
  srv = await startServer({
    GITHUB_CLIENT_ID: "cid-123",
    GITHUB_CLIENT_SECRET: "shh",
    GITHUB_REDIRECT_URI: "http://localhost:4000/api/oauth/github/callback",
    GITHUB_AUTHORIZE_URL: `${gh.base}/authorize`,
    GITHUB_TOKEN_URL: `${gh.base}/token`,
    GITHUB_API_URL: gh.base,
  });
});
after(async () => { await srv.stop(); await gh.stop(); });

async function startFlow(c) {
  const r = await c.call("/api/oauth/github/start");
  assert.equal(r.status, 302);
  return new URL(r.headers.get("location"));
}
const callback = (c, code, state) => c.call(`/api/oauth/github/callback?code=${code}&state=${state}`);

test("starting the flow requires a wallet session", async () => {
  assert.equal((await client(srv.base).call("/api/oauth/github/start")).status, 401);
});

test("start redirects to the provider with client_id, scope and a random state", async () => {
  const c = client(srv.base);
  await login(c, newWallet());
  const url = await startFlow(c);
  assert.equal(url.origin + url.pathname, `${gh.base}/authorize`);
  assert.equal(url.searchParams.get("client_id"), "cid-123");
  assert.equal(url.searchParams.get("scope"), "read:user");
  assert.match(url.searchParams.get("state"), /^[0-9a-f]{48}$/);
});

test("happy path: the callback links the GitHub account to the wallet", async () => {
  gh.state.profile = { id: 4242, login: "octo-harsh" };
  const c = client(srv.base);
  await login(c, newWallet());
  const state = (await startFlow(c)).searchParams.get("state");
  const r = await callback(c, gh.issueCode(), state);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "http://localhost:5173/?linked=github");
  const me = await (await c.call("/api/me")).json();
  assert.equal(me.linked.github.login, "octo-harsh");
});

test("the access token is never stored", async () => {
  const [cols] = await srv.pool.query("SHOW COLUMNS FROM linked_accounts");
  assert.ok(!cols.some((col) => /token|secret/i.test(col.Field)));
});

test("a wrong state is rejected before the provider is ever called (CSRF protection)", async () => {
  const c = client(srv.base);
  await login(c, newWallet());
  await startFlow(c);
  const calls = gh.state.tokenCalls;
  assert.equal((await callback(c, gh.issueCode(), "deadbeef")).status, 400);
  assert.equal(gh.state.tokenCalls, calls);
});

test("the state is single-use", async () => {
  gh.state.profile = { id: 777, login: "second-user" };
  const c = client(srv.base);
  await login(c, newWallet());
  const state = (await startFlow(c)).searchParams.get("state");
  assert.equal((await callback(c, gh.issueCode(), state)).status, 302);
  assert.equal((await callback(c, gh.issueCode(), state)).status, 400);
});

test("a token-exchange failure is reported as 502 and links nothing", async () => {
  gh.state.profile = { id: 888, login: "unlucky" };
  const c = client(srv.base);
  await login(c, newWallet());
  const state = (await startFlow(c)).searchParams.get("state");
  assert.equal((await callback(c, "not-a-real-code", state)).status, 502);
  assert.deepEqual((await (await c.call("/api/me")).json()).linked, {});
});

test("one GitHub account cannot be linked to two wallets", async () => {
  gh.state.profile = { id: 999, login: "shared-account" };
  const a = client(srv.base), b = client(srv.base);
  await login(a, newWallet());
  await login(b, newWallet());
  const sa = (await startFlow(a)).searchParams.get("state");
  assert.equal((await callback(a, gh.issueCode(), sa)).status, 302);
  const sb = (await startFlow(b)).searchParams.get("state");
  assert.equal((await callback(b, gh.issueCode(), sb)).status, 409);
});

test("a linked account can be removed", async () => {
  gh.state.profile = { id: 1001, login: "temp" };
  const c = client(srv.base);
  await login(c, newWallet());
  const state = (await startFlow(c)).searchParams.get("state");
  await callback(c, gh.issueCode(), state);
  const r = await (await c.call("/api/oauth/github", { method: "DELETE" })).json();
  assert.equal(r.removed, true);
  assert.deepEqual((await (await c.call("/api/me")).json()).linked, {});
});
