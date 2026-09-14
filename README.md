# Mudra

A small full-stack app demonstrating genuine Web3 integration: connect a MetaMask
wallet, authenticate with **Sign-In with Ethereum (SIWE)**, and read live balances
straight from the chain.

- **Frontend:** React (Vite) + [`ethers.js`](https://docs.ethers.org/v6/) v6
- **Backend:** Node.js + Express, session-based auth, real SIWE signature
  verification via the [`siwe`](https://www.npmjs.com/package/siwe) library
- **Network:** Ethereum **Sepolia** testnet
- **RPC:** [`https://ethereum-sepolia-rpc.publicnode.com`](https://ethereum-sepolia-rpc.publicnode.com) — a free public RPC, no API key needed
- **On-chain read:** live native ETH balance + the balance of a well-known
  Sepolia ERC-20 (Chainlink test **LINK** token,
  `0x779877A7B0D9E8603169DdbD7836e478b4624789`)

## How it works

1. **Connect Wallet** — the frontend calls `eth_requestAccounts` on the
   injected wallet (MetaMask) via `ethers.BrowserProvider`, then makes sure
   the wallet is on Sepolia (chain id `11155111`), prompting a network
   switch/add if not.
2. **Balances** — once connected, the frontend opens its *own* connection to
   a public Sepolia RPC node (`ethers.JsonRpcProvider`, independent of
   MetaMask's internal provider) to fetch the native ETH balance, and asks
   the backend to read the LINK ERC-20 `balanceOf` for the same address.
3. **Sign-In with Ethereum** —
   - Frontend calls `GET /api/nonce`. The backend generates a nonce and
     stores it on the session (cookie), returning the nonce.
   - Frontend builds a standard SIWE message (via the `siwe` package) that
     includes that nonce, and asks the wallet to sign it
     (`personal_sign` under the hood) — MetaMask pops up showing the exact
     message text for the user to approve. No transaction, no gas.
   - Frontend `POST`s the message + signature to `/api/verify`. The backend
     uses `siwe`'s `SiweMessage.verify()` to **recover the signing address
     from the signature** and checks it against the claimed address, the
     nonce, and the chain id. Only on success does it create an
     authenticated session (rotating the session id to avoid fixation).
4. **Protected route** — `GET /api/me` returns the authenticated address
   only if the session was actually created by a successful `/api/verify`
   call. Anything else (no cookie, expired session, failed verification) →
   `401`.

## Project layout

```
Mudra/
  server/            Express backend
    src/index.js      routes: /api/nonce, /api/verify, /api/me, /api/logout, /api/balance/:address
    src/chain.js       ethers provider + native/ERC-20 balance reads
    test/siwe.test.mjs integration test hitting a running server with real ethers wallets
  client/             React (Vite) frontend
    src/App.jsx        UI + wallet/SIWE flow
    src/chain.js        public-RPC balance read + chain-switch helper
    src/api.js          fetch wrapper for the backend (sends session cookie)
```

## Setup

Requires Node.js 18+ and MetaMask installed in your browser.

### 1. Backend

```bash
cd server
npm install
cp .env.example .env
npm start
```

Runs on `http://localhost:4000`. `.env.example` documents every variable
(RPC URL, chain id, session secret, CORS origin, ERC-20 address) — the
defaults already point at the public Sepolia RPC and the Sepolia LINK token.

### 2. Frontend

```bash
cd client
npm install
cp .env.example .env
npm run dev
```

Runs on `http://localhost:5175` (fixed in `vite.config.js` so it always
matches the backend's `CLIENT_ORIGIN`). Open that URL in a browser with
MetaMask installed.

## Testing it yourself with MetaMask

1. Install [MetaMask](https://metamask.io) and switch it to (or let the app
   prompt you to add) the **Sepolia** test network.
2. Get some free Sepolia ETH from a faucet, e.g.
   [sepoliafaucet.com](https://sepoliafaucet.com) or
   [Google Cloud's Sepolia faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia),
   if your address doesn't already have any.
3. Open `http://localhost:5175`, click **Connect Wallet**, and approve the
   connection in MetaMask.
4. The page shows your address, chain id, live native ETH balance, and LINK
   balance. **Cross-check the ETH figure** against
   [Sepolia Etherscan](https://sepolia.etherscan.io) for the same address —
   it should match exactly (it reads from the same kind of public RPC node).
5. Click **Sign-In with Ethereum**. MetaMask will show a signature request
   with the full SIWE message text (domain, address, nonce, etc.) — approve
   it. This is a message signature, not a transaction, so it costs no gas.
6. Once signed in, click **Call protected route (/api/me)** — it returns
   your address, proving the session is real.
7. Click **Sign out**, then try calling the protected route again (e.g.
   refresh the page) — it goes back to requiring sign-in, since the session
   cookie was destroyed server-side.

### Confirming the security properties (already verified in this repo)

`server/test/siwe.test.mjs` is an integration test that runs against the
live backend using real `ethers` wallets (no UI/MetaMask needed, since it
tests the cryptographic and session logic directly):

```bash
cd server
npm start &          # in one terminal
npm run test:siwe    # in another
```

It exercises, against the running server:

- ✅ A validly signed SIWE message → `200`, authenticated, `/api/me` works.
- ❌ A signature with one byte flipped → `401`, rejected, no session created.
- ❌ A message that *claims* address A but is actually signed by wallet B
  (impersonation) → `401`, rejected.
- ❌ Reusing/mismatching a nonce from a different session → `401`, rejected.
- ❌ `/api/me` with no session cookie at all → `401`.

This was run against the actual server for this build; sample output:

```
Verify (valid sig) status: 200 { ok: true, address: '0x...' }
/api/me status: 200 { ok: true, address: '0x...', chainId: 11155111 }
Verify (TAMPERED sig) status: 401 { ok: false, error: 'verification error' }
/api/me after tampered verify, status: 401 { ok: false, error: 'not authenticated' }
Verify (wrong signer / impersonation) status: 401 { ok: false, error: 'verification error' }
Verify (nonce mismatch / replay) status: 401 { ok: false, error: 'verification error' }
```

The on-chain balance read (`GET /api/balance/:address`) was also verified
during development against a known Sepolia address
(`0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`): the API returned
`60.848102800728318185 ETH` / `67.111000000000101 LINK`, matching
[Sepolia Etherscan's](https://sepolia.etherscan.io/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045)
"ETH BALANCE" and the [LINK token holder page](https://sepolia.etherscan.io/token/0x779877A7B0D9E8603169DdbD7836e478b4624789?a=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045)
exactly.

## Notes / limitations

- Sessions are stored in-memory (`express-session`'s default `MemoryStore`),
  which is fine for a demo but not for a real deployment — swap in a proper
  session store (Redis, etc.) for production use.
- `SESSION_SECRET` in `.env.example` is a placeholder — always set a real
  random secret outside of local development.
- The cookie is issued with `secure: false` for local HTTP development; set
  it to `true` and serve over HTTPS in any real deployment.
