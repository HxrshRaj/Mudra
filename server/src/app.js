import express from "express";
import session from "express-session";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { SiweMessage, generateNonce } from "siwe";
import { ethers } from "ethers";
import { getNativeBalance, getErc20Balance } from "./chain.js";
import { upsertUser, getLinkedAccounts } from "./db.js";
import { oauthRouter } from "./oauth.js";

export function createApp({ pool, config, sessionStore }) {
  const app = express();
  if (config.production) app.set("trust proxy", 1); // behind Render/Vercel proxies, so `secure` cookies work

  app.use(express.json({ limit: "20kb" }));
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(
    session({
      name: "mudra.sid",
      secret: config.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        // The frontend and API are on different origins in production, which needs SameSite=None + Secure.
        sameSite: config.production ? "none" : "lax",
        secure: config.production,
        maxAge: 1000 * 60 * 60,
      },
    })
  );

  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { ok: false, error: "too many attempts, try again in a minute" },
  });

  // SIWE step 1: issue a fresh nonce and keep it on the session.
  app.get("/api/nonce", authLimiter, (req, res) => {
    const nonce = generateNonce();
    req.session.nonce = nonce;
    req.session.save((err) => (err ? res.status(500).json({ ok: false, error: "session error" }) : res.json({ nonce })));
  });

  // SIWE step 2: verify the signed message. siwe recovers the signer from the signature and checks
  // the nonce, domain/time window and address; we also pin the chain id.
  app.post("/api/verify", authLimiter, async (req, res) => {
    try {
      const { message, signature } = req.body ?? {};
      if (!message || !signature) {
        return res.status(400).json({ ok: false, error: "message and signature are required" });
      }
      const nonce = req.session.nonce;
      if (!nonce) {
        return res.status(400).json({ ok: false, error: "no nonce on session, call /api/nonce first" });
      }
      // Burn the nonce now: a nonce can be used for one attempt only, so a captured signature cannot be replayed.
      delete req.session.nonce;
      await new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));

      const siweMessage = new SiweMessage(message);
      const result = await siweMessage.verify({ signature, nonce });
      if (!result.success) return res.status(401).json({ ok: false, error: "signature verification failed" });
      if (siweMessage.chainId !== config.chainId) {
        return res.status(401).json({ ok: false, error: `unexpected chainId ${siweMessage.chainId}` });
      }

      const user = await upsertUser(pool, siweMessage.address);
      // Rotate the session id on login to prevent session fixation.
      req.session.regenerate((err) => {
        if (err) return res.status(500).json({ ok: false, error: "session error" });
        req.session.siwe = {
          address: siweMessage.address,
          chainId: siweMessage.chainId,
          issuedAt: siweMessage.issuedAt,
          userId: user.id,
        };
        req.session.save((e) =>
          e ? res.status(500).json({ ok: false, error: "session error" }) : res.json({ ok: true, address: siweMessage.address })
        );
      });
    } catch (err) {
      return res.status(401).json({ ok: false, error: err.message || "verification error" });
    }
  });

  function requireAuth(req, res, next) {
    if (!req.session.siwe?.address) return res.status(401).json({ ok: false, error: "not authenticated" });
    next();
  }

  app.get("/api/me", requireAuth, async (req, res) => {
    const linked = await getLinkedAccounts(pool, req.session.siwe.userId);
    res.json({
      ok: true,
      address: req.session.siwe.address,
      chainId: req.session.siwe.chainId,
      linked: Object.fromEntries(linked.map((a) => [a.provider, { login: a.login, linkedAt: a.linked_at }])),
    });
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.use("/api/oauth", oauthRouter({ pool, config, requireAuth }));

  // On-chain read: native ETH balance + a Sepolia ERC-20 balance, from a public RPC node.
  app.get("/api/balance/:address", async (req, res) => {
    try {
      const { address } = req.params;
      if (!ethers.isAddress(address)) return res.status(400).json({ ok: false, error: "invalid address" });
      const [native, erc20] = await Promise.all([
        getNativeBalance(address),
        getErc20Balance(address).catch((err) => ({ error: err.message })),
      ]);
      res.json({ ok: true, address, native, erc20 });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || "failed to read chain" });
    }
  });

  app.get("/api/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  return app;
}
