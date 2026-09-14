// Manual integration test for the SIWE flow against the running server.
// Simulates what MetaMask would do: hold a private key, sign a SIWE message,
// and POST it to the backend. Uses a throwaway test wallet (no real funds).
import { ethers } from "ethers";
import { SiweMessage } from "siwe";

const BASE = "http://localhost:4000";

async function fetchWithCookies(url, opts = {}, jar = {}) {
  const headers = { ...(opts.headers || {}) };
  if (jar.cookie) headers.cookie = jar.cookie;
  const res = await fetch(url, { ...opts, headers, redirect: "manual" });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    // keep just the cookie pair (strip attributes) for simplicity
    jar.cookie = setCookie.split(";")[0];
  }
  return res;
}

async function main() {
  const wallet = ethers.Wallet.createRandom();
  console.log("Test wallet address:", wallet.address);

  const jar = {};

  // Step 1: get nonce
  let res = await fetchWithCookies(`${BASE}/api/nonce`, {}, jar);
  const { nonce } = await res.json();
  console.log("Got nonce:", nonce, "cookie:", jar.cookie ? "yes" : "no");

  // Step 2: build SIWE message
  const siweMessage = new SiweMessage({
    domain: "localhost",
    address: wallet.address,
    statement: "Sign in to Mudra with Ethereum.",
    uri: "http://localhost:5173",
    version: "1",
    chainId: 11155111,
    nonce,
  });
  const preparedMessage = siweMessage.prepareMessage();

  // Step 3: sign with the wallet (this is the real cryptographic signature MetaMask would produce)
  const signature = await wallet.signMessage(preparedMessage);

  // Step 4a: verify with GOOD signature
  res = await fetchWithCookies(
    `${BASE}/api/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: preparedMessage, signature }),
    },
    jar
  );
  console.log("Verify (valid sig) status:", res.status, await res.json());

  // Step 5: hit protected route with the now-authenticated session cookie
  res = await fetchWithCookies(`${BASE}/api/me`, {}, jar);
  console.log("/api/me status:", res.status, await res.json());

  // Step 6: TAMPER test - get a fresh nonce/session, then flip a character in the signature
  const jar2 = {};
  res = await fetchWithCookies(`${BASE}/api/nonce`, {}, jar2);
  const { nonce: nonce2 } = await res.json();
  const siweMessage2 = new SiweMessage({
    domain: "localhost",
    address: wallet.address,
    statement: "Sign in to Mudra with Ethereum.",
    uri: "http://localhost:5173",
    version: "1",
    chainId: 11155111,
    nonce: nonce2,
  });
  const preparedMessage2 = siweMessage2.prepareMessage();
  const goodSig = await wallet.signMessage(preparedMessage2);
  // Flip a hex character inside the "r" component (well away from the
  // trailing v byte, where a single flipped bit can coincidentally
  // preserve the recovery parity and still recover the same address).
  // A flip here corrupts the actual signature math.
  const idx = 20;
  const ch = goodSig[idx];
  const replacement = ch === "a" ? "b" : "a";
  const tamperedSig = goodSig.slice(0, idx) + replacement + goodSig.slice(idx + 1);

  res = await fetchWithCookies(
    `${BASE}/api/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: preparedMessage2, signature: tamperedSig }),
    },
    jar2
  );
  console.log("Verify (TAMPERED sig) status:", res.status, await res.json());

  res = await fetchWithCookies(`${BASE}/api/me`, {}, jar2);
  console.log("/api/me after tampered verify, status:", res.status, await res.json());

  // Step 6b: impersonation test - sign validly as wallet B, but claim to be wallet A
  const walletB = ethers.Wallet.createRandom();
  const jar2b = {};
  res = await fetchWithCookies(`${BASE}/api/nonce`, {}, jar2b);
  const { nonce: nonce2b } = await res.json();
  const impersonationMessage = new SiweMessage({
    domain: "localhost",
    address: wallet.address, // claims to be the FIRST wallet
    statement: "Sign in to Mudra with Ethereum.",
    uri: "http://localhost:5173",
    version: "1",
    chainId: 11155111,
    nonce: nonce2b,
  }).prepareMessage();
  const wrongSignerSig = await walletB.signMessage(impersonationMessage); // but actually signed by wallet B
  res = await fetchWithCookies(
    `${BASE}/api/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: impersonationMessage, signature: wrongSignerSig }),
    },
    jar2b
  );
  console.log("Verify (wrong signer / impersonation) status:", res.status, await res.json());

  // Step 7: replay test - try to reuse the first (already-consumed) nonce
  const jar3 = {};
  res = await fetchWithCookies(`${BASE}/api/nonce`, {}, jar3); // fresh session+nonce for jar3
  res = await fetchWithCookies(
    `${BASE}/api/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: preparedMessage, signature }), // reuse step 3's message/sig with a DIFFERENT session's nonce
    },
    jar3
  );
  console.log("Verify (nonce mismatch / replay) status:", res.status, await res.json());
}

main().catch((err) => {
  console.error("Test script error:", err);
  process.exit(1);
});
