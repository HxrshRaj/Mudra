import "dotenv/config";
import express from "express";
import session from "express-session";
import cors from "cors";
import { SiweMessage, generateNonce } from "siwe";
import { ethers } from "ethers";
import { getNativeBalance, getErc20Balance } from "./chain.js";

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const CHAIN_ID = Number(process.env.CHAIN_ID || 11155111);

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  })
);

app.use(
  session({
    name: "mudra.sid",
    secret: process.env.SESSION_SECRET || "dev-secret-do-not-use-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true when served over https in production
      maxAge: 1000 * 60 * 60, // 1 hour
    },
  })
);

// ---------------------------------------------------------------------------
// SIWE step 1: issue a fresh nonce and stash it on the session.
// The frontend embeds this nonce in the message it asks MetaMask to sign.
// ---------------------------------------------------------------------------
app.get("/api/nonce", (req, res) => {
  const nonce = generateNonce();
  req.session.nonce = nonce;
  // Session must exist before we can rely on the cookie coming back, so save explicitly.
  req.session.save(() => res.json({ nonce }));
});

// ---------------------------------------------------------------------------
// SIWE step 2: verify the signed message against the nonce we issued.
// This is a real cryptographic signature check via the `siwe` library
// (which recovers the signing address from the signature and compares it
// to the address claimed in the message) - not a stub.
// ---------------------------------------------------------------------------
app.post("/api/verify", async (req, res) => {
  try {
    const { message, signature } = req.body;
    if (!message || !signature) {
      return res.status(400).json({ ok: false, error: "message and signature are required" });
    }

    if (!req.session.nonce) {
      return res.status(400).json({ ok: false, error: "no nonce on session, call /api/nonce first" });
    }

    const siweMessage = new SiweMessage(message);

    // .verify() recovers the signer from `signature` and throws if it does
    // not match siweMessage.address, if the signature is malformed, if the
    // message is expired/not-yet-valid, or if the nonce doesn't match.
    const result = await siweMessage.verify({
      signature,
      nonce: req.session.nonce,
    });

    if (!result.success) {
      return res.status(401).json({ ok: false, error: "signature verification failed" });
    }

    if (siweMessage.chainId !== CHAIN_ID) {
      return res.status(401).json({ ok: false, error: `unexpected chainId ${siweMessage.chainId}` });
    }

    // Prevent session fixation: rotate the session id on successful login.
    const address = siweMessage.address;
    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ ok: false, error: "session error" });
      }
      req.session.siwe = { address, chainId: siweMessage.chainId, issuedAt: siweMessage.issuedAt };
      req.session.save(() => res.json({ ok: true, address }));
    });
  } catch (err) {
    // Any thrown error (bad signature, tampered message, expired nonce, etc.)
    // is treated as an authentication failure, never as success.
    return res.status(401).json({ ok: false, error: err.message || "verification error" });
  }
});

// ---------------------------------------------------------------------------
// Protected route: only reachable with a session that survived a real
// SIWE verification above. No session / expired session -> 401.
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!req.session.siwe || !req.session.siwe.address) {
    return res.status(401).json({ ok: false, error: "not authenticated" });
  }
  next();
}

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ ok: true, address: req.session.siwe.address, chainId: req.session.siwe.chainId });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// On-chain read: native ETH balance + a well-known Sepolia ERC-20 balance,
// fetched live from a public RPC node (independent of MetaMask's provider).
// Public route - reading a balance for an address is not sensitive, and
// gating it behind auth would just make manual verification harder.
// ---------------------------------------------------------------------------
app.get("/api/balance/:address", async (req, res) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ ok: false, error: "invalid address" });
    }
    const [native, erc20] = await Promise.all([
      getNativeBalance(address),
      getErc20Balance(address).catch((err) => ({ error: err.message })),
    ]);
    res.json({ ok: true, address, native, erc20 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "failed to read chain" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Mudra server listening on http://localhost:${PORT}`);
});
