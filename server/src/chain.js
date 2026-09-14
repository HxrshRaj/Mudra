import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const ERC20_ADDRESS = process.env.ERC20_ADDRESS || "0x779877A7B0D9E8603169DdbD7836e478b4624789";

// Minimal ERC-20 ABI - just the read-only pieces we need.
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// A single shared provider talking to a public Sepolia RPC node.
// This is intentionally separate from the wallet's injected provider so the
// balance shown is fetched independently and can be cross-checked against a
// block explorer (Sepolia Etherscan) for the same address.
export const provider = new ethers.JsonRpcProvider(RPC_URL);

export async function getNativeBalance(address) {
  const wei = await provider.getBalance(address);
  return {
    raw: wei.toString(),
    formatted: ethers.formatEther(wei),
    symbol: "ETH",
  };
}

export async function getErc20Balance(address) {
  const contract = new ethers.Contract(ERC20_ADDRESS, ERC20_ABI, provider);
  const [raw, decimals, symbol] = await Promise.all([
    contract.balanceOf(address),
    contract.decimals(),
    contract.symbol(),
  ]);
  return {
    address: ERC20_ADDRESS,
    raw: raw.toString(),
    formatted: ethers.formatUnits(raw, decimals),
    decimals: Number(decimals),
    symbol,
  };
}
