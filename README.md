# Mudra

A small full-stack app demonstrating genuine Web3 integration: connect a MetaMask
wallet, authenticate with **Sign-In with Ethereum (SIWE)**, and read live balances
straight from the chain.

- **Frontend:** React (Vite) + [`ethers.js`](https://docs.ethers.org/v6/) v6
- **Backend:** Node.js + Express + MySQL, session-based auth, real SIWE signature
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
    src/app.js        routes: /api/nonce, /api/verify, /api/me, /api/logout, /api/balance/:address, /api/health
    src/oauth.js      GitHub OAuth link/unlink (/api/oauth/github/*)
    src/db.js         MySQL pool, migrations, user and linked-account queries
    src/index.js      boot: migrate, session store, listen
    src/chain.js      ethers provider + native/ERC-20 balance reads
    test/             25 tests (SIWE, OAuth) against real MySQL
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

### Automated tests (server)

25 tests run with `node --test` against a **real MySQL** database (one throwaway database per test file) and real
`ethers` wallets, with no browser or MetaMask needed:

```bash
cd server && npm ci
MYSQL_ADMIN_URL=mysql://root:password@127.0.0.1:3306 npm test
```

- **SIWE login (14 tests):** valid login creates the user and `/api/me` works; a second login increments
  `login_count` instead of adding a user; the session id is rotated on login; sessions are stored in MySQL;
  a captured signature cannot be replayed from another session or reused; the nonce is burned after one attempt
  even if it failed; wrong nonce, another key's signature, wrong chain id, missing body, no session, logout; the
  auth endpoints are rate limited (429).
- **GitHub OAuth (9 tests)**, against a local stand-in provider spoken to over real HTTP: the start step needs a
  wallet session and builds the right redirect with a random `state`; the callback links the account; a wrong
  `state` is rejected before the provider is ever called; the `state` is single-use; a failed token exchange
  returns 502 and links nothing; one GitHub account cannot be linked to two wallets; accounts can be unlinked;
  no access token is stored; the endpoints answer 501 when OAuth is not configured.

Writing these tests found a real bug: on the very first request after a cold start, the session table might not
exist yet and the nonce was silently not saved. The server now waits for the session store before listening and
returns an error if a session cannot be saved.

CI (`.github/workflows/ci.yml`) runs the server tests against a `mysql:8` service, lints and builds the client, and
runs a Lighthouse budget check.

## GitHub account linking (OAuth 2.0)

After signing in with a wallet you can link a GitHub account (authorization-code flow with a one-time `state`
check). Only the GitHub user id and login are stored, never the access token.

1. Create an OAuth App at github.com/settings/developers with the callback URL from `GITHUB_REDIRECT_URI`.
2. Put `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_REDIRECT_URI` in `server/.env`.

The flow is tested against a local stand-in for GitHub's endpoints; it has **not** been run against github.com
because that needs your own OAuth App credentials.

## Data (MySQL)

`users` (one row per wallet, login counters), `linked_accounts` (provider accounts, unique per provider id and per
user) and `sessions`. Migrations are plain SQL in `server/src/db.js`, applied on start and recorded in
`schema_migrations`. Set `MYSQL_URL`. Tests were run locally against MariaDB 10.11 (MySQL-compatible) and in CI
against `mysql:8`.

## Frontend performance

Lighthouse (mobile profile, simulated throttling) on the built client, before and after splitting `ethers` and
`siwe` into on-demand chunks and fixing the audit findings (details in [`docs/performance.md`](docs/performance.md)):

| | before | after |
|---|---|---|
| Performance | 89 | 100 |
| Accessibility | 90 | 100 |
| SEO | 82 | 100 |
| Page weight | 351 KiB | 73 KiB |
| First / Largest Contentful Paint | 2.8 s / 3.1 s | 1.2 s / 1.7 s |

CI fails if performance, accessibility or SEO drop below the budget in `client/lighthouserc.json`.

## Deploying

Frontend: `client/vercel.json` or `client/netlify.toml` (single-page-app rewrite). Backend: `server/Dockerfile` and
`render.yaml` (needs an external MySQL, because Render has no managed MySQL). **Not deployed yet**: the files are
ready, but no live URL exists until you connect the repos and set the environment variables.

## Notes / limitations

- Sessions are stored in MySQL (`express-mysql-session`), so logins survive a server restart.
- `SESSION_SECRET` in `.env.example` is a placeholder — always set a real
  random secret outside of local development.
- In production (`NODE_ENV=production`) the cookie is `Secure` and `SameSite=None`, which needs HTTPS on both the frontend and the API.
