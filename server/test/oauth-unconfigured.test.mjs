import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, client, login, newWallet } from "./helpers.mjs";

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test("OAuth endpoints answer 501 when no GitHub credentials are configured", async () => {
  const c = client(srv.base);
  const l = await login(c, newWallet());
  assert.equal(l.status, 200, await l.text());
  assert.equal((await c.call("/api/oauth/github/start")).status, 501);
});
