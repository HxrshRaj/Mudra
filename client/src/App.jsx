import { useCallback, useEffect, useState } from "react";
import { SiweMessage } from "siwe";
import "./App.css";
import * as api from "./api";
import { CHAIN_ID, ensureChain, getInjectedProvider, getNativeBalance } from "./chain";

function short(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
}

export default function App() {
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [session, setSession] = useState(null); // { address, chainId } once SIWE-verified
  const [nativeBalance, setNativeBalance] = useState(null);
  const [erc20, setErc20] = useState(null);
  const [protectedData, setProtectedData] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | connecting | signing | loading | error
  const [error, setError] = useState(null);

  // On load, ask the backend if we already have a valid session (e.g. after
  // a page refresh) - this is the same 401-guarded route used everywhere.
  useEffect(() => {
    api
      .fetchMe()
      .then((data) => setSession({ address: data.address, chainId: data.chainId }))
      .catch(() => setSession(null));
  }, []);

  const loadBalances = useCallback(async (addr) => {
    try {
      const [native, backendBalances] = await Promise.all([
        getNativeBalance(addr),
        api.fetchBalance(addr),
      ]);
      setNativeBalance(native);
      setErc20(backendBalances.erc20);
    } catch (err) {
      console.error("Failed to load balances", err);
      setError(`Could not load balances: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    if (address) loadBalances(address);
  }, [address, loadBalances]);

  // Keep local state in sync with wallet-side account/network switches.
  useEffect(() => {
    const ethereum = window.ethereum;
    if (!ethereum) return;

    const onAccountsChanged = (accounts) => {
      if (accounts.length === 0) {
        setAddress(null);
        setSession(null);
      } else {
        setAddress(accounts[0]);
        setSession(null); // wallet changed -> previous SIWE session no longer applies
      }
    };
    const onChainChanged = (hexChainId) => setChainId(Number(hexChainId));

    ethereum.on?.("accountsChanged", onAccountsChanged);
    ethereum.on?.("chainChanged", onChainChanged);
    return () => {
      ethereum.removeListener?.("accountsChanged", onAccountsChanged);
      ethereum.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  async function connectWallet() {
    setError(null);
    if (!window.ethereum) {
      setError("MetaMask (or another injected wallet) was not found. Please install it.");
      return;
    }
    try {
      setStatus("connecting");
      const provider = getInjectedProvider();
      const accounts = await provider.send("eth_requestAccounts", []);
      await ensureChain(window.ethereum);
      const network = await provider.getNetwork();
      setAddress(accounts[0]);
      setChainId(Number(network.chainId));
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err.message || "Failed to connect wallet");
    }
  }

  async function signInWithEthereum() {
    setError(null);
    try {
      setStatus("signing");
      const provider = getInjectedProvider();
      const signer = await provider.getSigner();

      const { nonce } = await api.fetchNonce();

      const siweMessage = new SiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Mudra with Ethereum.",
        uri: window.location.origin,
        version: "1",
        chainId,
        nonce,
      });
      const preparedMessage = siweMessage.prepareMessage();

      // This is the real MetaMask signing prompt - the user reviews and
      // approves the exact SIWE message text before anything is signed.
      const signature = await signer.signMessage(preparedMessage);

      const result = await api.verifySignature(preparedMessage, signature);
      setSession({ address: result.address, chainId });
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      // A rejected signature, a tampered payload, or a nonce mismatch all
      // land here as a genuine failure - nothing is assumed to succeed.
      setError(err.message || "Sign-in failed");
    }
  }

  async function callProtectedRoute() {
    setError(null);
    try {
      const data = await api.fetchMe();
      setProtectedData(data);
    } catch (err) {
      setProtectedData(null);
      setError(`Protected route call failed (${err.status ?? "?"}): ${err.message}`);
    }
  }

  async function signOut() {
    await api.logout().catch(() => {});
    setSession(null);
    setProtectedData(null);
  }

  const wrongNetwork = chainId !== null && chainId !== CHAIN_ID;

  return (
    <div className="app">
      <header>
        <h1>Mudra</h1>
        <p className="subtitle">Sign-In with Ethereum + live on-chain balances (Sepolia testnet)</p>
      </header>

      <main>
        {!address && (
          <button className="primary" onClick={connectWallet} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting..." : "Connect Wallet"}
          </button>
        )}

        {address && (
          <section className="card">
            <h2>Wallet</h2>
            <p>
              <strong>Address:</strong> <code title={address}>{short(address)}</code>
            </p>
            <p>
              <strong>Chain ID:</strong> {chainId}{" "}
              {wrongNetwork && <span className="warn">(expected {CHAIN_ID} - Sepolia)</span>}
            </p>
            <p>
              <strong>Native balance:</strong>{" "}
              {nativeBalance !== null ? `${nativeBalance} ETH` : "loading..."}
            </p>
            <p>
              <strong>LINK (ERC-20) balance:</strong>{" "}
              {erc20 ? `${erc20.formatted} ${erc20.symbol}` : erc20?.error ? erc20.error : "loading..."}
            </p>
          </section>
        )}

        {address && !session && (
          <section className="card">
            <h2>Sign-In with Ethereum</h2>
            <p>Prove you control this address by signing a one-time message. No transaction, no gas.</p>
            <button className="primary" onClick={signInWithEthereum} disabled={status === "signing"}>
              {status === "signing" ? "Waiting for signature..." : "Sign-In with Ethereum"}
            </button>
          </section>
        )}

        {session && (
          <section className="card success">
            <h2>Authenticated</h2>
            <p>
              Backend session verified for <code>{short(session.address)}</code>.
            </p>
            <div className="button-row">
              <button onClick={callProtectedRoute}>Call protected route (/api/me)</button>
              <button className="secondary" onClick={signOut}>
                Sign out
              </button>
            </div>
            {protectedData && (
              <pre className="json">{JSON.stringify(protectedData, null, 2)}</pre>
            )}
          </section>
        )}

        {error && <p className="error">{error}</p>}
      </main>

      <footer>
        <p>
          Backend and on-chain reads run against Ethereum Sepolia via a public RPC endpoint - see{" "}
          <code>README.md</code> for how to verify this against a block explorer.
        </p>
      </footer>
    </div>
  );
}
