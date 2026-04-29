import { describe, expect, test } from "bun:test";
import {
  buildGitHubAuthorizeRequest,
  buildGitHubDeviceCodeBody,
  buildGitHubDeviceTokenBody,
  buildGitHubWebTokenBody,
} from "../src/github-oauth";

describe("GitHub OAuth helpers", () => {
  test("builds browser authorization URL with PKCE and CSRF state", () => {
    const request = buildGitHubAuthorizeRequest({
      clientId: "client-id",
      redirectUri: "https://relay.example.test/auth/github/callback",
    });
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://relay.example.test/auth/github/callback");
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("state")).toBe(request.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(40);
    expect(request.codeVerifier.length).toBeGreaterThan(40);
  });

  test("builds GitHub device flow requests for CLI login", () => {
    expect(Object.fromEntries(buildGitHubDeviceCodeBody("client-id"))).toEqual({
      client_id: "client-id",
      scope: "read:user",
    });
    expect(Object.fromEntries(buildGitHubDeviceTokenBody("client-id", "device-code"))).toEqual({
      client_id: "client-id",
      device_code: "device-code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  test("builds web token exchange body with server-side secret and PKCE verifier", () => {
    expect(
      Object.fromEntries(
        buildGitHubWebTokenBody({
          clientId: "client-id",
          clientSecret: "client-secret",
          code: "code",
          redirectUri: "https://relay.example.test/auth/github/callback",
          codeVerifier: "verifier",
        }),
      ),
    ).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      code: "code",
      redirect_uri: "https://relay.example.test/auth/github/callback",
      code_verifier: "verifier",
    });
  });
});
