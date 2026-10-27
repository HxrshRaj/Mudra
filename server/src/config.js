import "dotenv/config";

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 4000),
    clientOrigin: env.CLIENT_ORIGIN || "http://localhost:5173",
    chainId: Number(env.CHAIN_ID || 11155111),
    sessionSecret: env.SESSION_SECRET || "dev-secret-do-not-use-in-prod",
    production: env.NODE_ENV === "production",
    mysqlUrl: env.MYSQL_URL || "mysql://root@127.0.0.1:3306/mudra",
    github: {
      clientId: env.GITHUB_CLIENT_ID || "",
      clientSecret: env.GITHUB_CLIENT_SECRET || "",
      redirectUri: env.GITHUB_REDIRECT_URI || "http://localhost:4000/api/oauth/github/callback",
      authorizeUrl: env.GITHUB_AUTHORIZE_URL || "https://github.com/login/oauth/authorize",
      tokenUrl: env.GITHUB_TOKEN_URL || "https://github.com/login/oauth/access_token",
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    },
  };
}
