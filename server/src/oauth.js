import crypto from "node:crypto";
import { Router } from "express";
import { linkAccount, unlinkAccount } from "./db.js";

// GitHub OAuth 2.0 authorization-code flow, used to link a GitHub account to a wallet that is
// already signed in with SIWE. The provider URLs are configurable so the flow can be tested
// against a local provider and pointed at github.com in production.
export function oauthRouter({ pool, config, requireAuth }) {
  const r = Router();
  const gh = config.github;

  const configured = (req, res, next) =>
    gh.clientId && gh.clientSecret
      ? next()
      : res.status(501).json({ ok: false, error: "GitHub OAuth is not configured on this server" });

  r.get("/github/start", requireAuth, configured, (req, res) => {
    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;
    const url = new URL(gh.authorizeUrl);
    url.searchParams.set("client_id", gh.clientId);
    url.searchParams.set("redirect_uri", gh.redirectUri);
    url.searchParams.set("scope", "read:user");
    url.searchParams.set("state", state);
    req.session.save((err) =>
      err ? res.status(500).json({ ok: false, error: "session error" }) : res.redirect(302, url.toString())
    );
  });

  r.get("/github/callback", requireAuth, configured, async (req, res) => {
    const { code, state, error } = req.query;
    const expected = req.session.oauthState;
    delete req.session.oauthState; // one-time use, even when the check below fails
    // Persist the burn before doing anything else, so a replayed callback can never see the old state.
    try {
      await new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
    } catch {
      return res.status(500).json({ ok: false, error: "session error" });
    }

    const sameState =
      typeof state === "string" &&
      typeof expected === "string" &&
      state.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected));
    if (!sameState) return res.status(400).json({ ok: false, error: "invalid or missing OAuth state" });
    if (error) return res.status(400).json({ ok: false, error: `provider returned error: ${error}` });
    if (typeof code !== "string" || !code) return res.status(400).json({ ok: false, error: "missing code" });

    try {
      const tokenRes = await fetch(gh.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: gh.clientId,
          client_secret: gh.clientSecret,
          code,
          redirect_uri: gh.redirectUri,
        }),
      });
      const token = await tokenRes.json();
      if (!tokenRes.ok || !token.access_token) {
        return res.status(502).json({ ok: false, error: token.error || "token exchange failed" });
      }
      const userRes = await fetch(`${gh.apiUrl}/user`, {
        headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
      });
      if (!userRes.ok) return res.status(502).json({ ok: false, error: "could not read GitHub profile" });
      const profile = await userRes.json();

      const result = await linkAccount(pool, req.session.siwe.userId, "github", String(profile.id), profile.login);
      if (result === "conflict") {
        return res.status(409).json({ ok: false, error: "that GitHub account is already linked to another wallet" });
      }
      // The access token is used once and deliberately not stored.
      return res.redirect(302, `${config.clientOrigin}/?linked=github`);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message || "OAuth error" });
    }
  });

  r.delete("/github", requireAuth, async (req, res) => {
    const removed = await unlinkAccount(pool, req.session.siwe.userId, "github");
    res.json({ ok: true, removed });
  });

  return r;
}
