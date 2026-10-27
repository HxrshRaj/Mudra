// ethers is large (~300 KB), and the first screen does not need it, so it is loaded on demand.
const loadEthers = () => import("ethers").then((m) => m.ethers ?? m);

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 11155111);
export const CHAIN_ID_HEX = "0x" + CHAIN_ID.toString(16);
const RPC_URL = import.meta.env.VITE_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

// A read-only connection straight to a public Sepolia RPC node, separate
// from whatever provider MetaMask happens to be using internally. This is
// what actually fetches the "real native balance from a public RPC
// endpoint" - it's independently verifiable against a block explorer.
let publicProvider;

export async function getNativeBalance(address) {
  const ethers = await loadEthers();
  publicProvider ??= new ethers.JsonRpcProvider(RPC_URL);
  const wei = await publicProvider.getBalance(address);
  return ethers.formatEther(wei);
}

export async function getInjectedProvider() {
  if (!window.ethereum) return null;
  const ethers = await loadEthers();
  return new ethers.BrowserProvider(window.ethereum);
}

// Asks MetaMask to switch to the target chain, adding it first if the
// wallet doesn't already know about it. Sepolia is a default MetaMask
// network so `wallet_addEthereumChain` is only really exercised for other
// chain ids, but it's included so this isn't hard-coded to one testnet.
export async function ensureChain(ethereum) {
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (switchError) {
    if (switchError.code === 4902) {
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_ID_HEX,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: [RPC_URL],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    } else {
      throw switchError;
    }
  }
}
