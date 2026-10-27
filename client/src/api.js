// Thin wrapper around the backend API. `credentials: "include"` is required
// on every call so the SIWE session cookie (set by the server) is sent back
// on subsequent requests - that cookie is what makes /api/me actually
// protected instead of decorative.
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error || `Request failed with status ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return data;
}

export function fetchNonce() {
  return apiFetch("/api/nonce");
}

export function verifySignature(message, signature) {
  return apiFetch("/api/verify", {
    method: "POST",
    body: JSON.stringify({ message, signature }),
  });
}

export function fetchMe() {
  return apiFetch("/api/me");
}

export function logout() {
  return apiFetch("/api/logout", { method: "POST" });
}

export function fetchBalance(address) {
  return apiFetch(`/api/balance/${address}`);
}

// OAuth link flow: a full-page redirect to the backend, which sends the browser to GitHub and back.
export function githubStartUrl() {
  return `${API_URL}/api/oauth/github/start`;
}

export function unlinkGithub() {
  return apiFetch("/api/oauth/github", { method: "DELETE" });
}
