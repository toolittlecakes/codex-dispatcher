import { createHash, randomBytes } from "node:crypto";

export type GitHubOAuthConfig = {
  clientId: string;
  redirectUri: string;
};

export type GitHubAuthorizeRequest = {
  url: string;
  state: string;
  codeVerifier: string;
};

export function buildGitHubAuthorizeRequest(config: GitHubOAuthConfig): GitHubAuthorizeRequest {
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return {
    url: url.toString(),
    state,
    codeVerifier,
  };
}

export function buildGitHubDeviceCodeBody(clientId: string): URLSearchParams {
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("scope", "read:user");
  return body;
}

export function buildGitHubDeviceTokenBody(clientId: string, deviceCode: string): URLSearchParams {
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("device_code", deviceCode);
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
  return body;
}

export function buildGitHubWebTokenBody(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("client_id", input.clientId);
  body.set("client_secret", input.clientSecret);
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  body.set("code_verifier", input.codeVerifier);
  return body;
}
