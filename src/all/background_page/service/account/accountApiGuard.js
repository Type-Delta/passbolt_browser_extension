import MfaAuthenticationRequiredError from "../../error/mfaAuthenticationRequiredError";
import { ApiClient } from "passbolt-styleguide/src/shared/lib/apiClient/apiClient";
import { ApiClientOptions } from "passbolt-styleguide/src/shared/lib/apiClient/apiClientOptions";
import AccountContext from "./accountContext";

const originalSendRequest = ApiClient.prototype.sendRequest;
const originalParseResponse = ApiClient.prototype.parseResponseJson;
const responseContexts = new WeakMap();

/** Resolve the authenticated identity from the server, never from OpenPGP user IDs. */
export async function findAuthenticatedUser(options, { checkMfa = false } = {}) {
  // Stock CE 5.16 exposes TOTP readiness without redirecting or clearing a valid MFA cookie.
  // Opt in only for login and pending reconciliation; this is not a generic provider status route.
  if (checkMfa) {
    await assertMfaReadiness(options);
  }
  const context = options.accountContext;
  if (context) {
    AccountContext.assert(context.generation);
  }
  const client = new ApiClient(new ApiClientOptions().setBaseUrl(options.getBaseUrl()).setResourceName("users"));
  const url = client.buildUrl(`${client.baseUrl}/me`);
  const response = await originalSendRequest.call(client, "GET", url, null, { redirect: "error" });
  const json = await originalParseResponse.call(client, response);
  if (context) {
    AccountContext.assert(context.generation);
  }
  if (!json.body?.id || !json.body?.username) {
    throw new Error("The server did not return an authenticated user identity.");
  }
  return json.body;
}

/** Read-only CE 5.16 TOTP readiness. It never follows the destructive MFA error redirect. */
export async function assertMfaReadiness(options) {
  const context = options.accountContext;
  if (context) {
    AccountContext.assert(context.generation);
    if (options.getBaseUrl().toString().replace(/\/+$/, "") !== context.account.domain.replace(/\/+$/, "")) {
      throw new Error("An account request cannot leave its server base URL.");
    }
  }
  const readinessClient = new ApiClient(
    new ApiClientOptions().setBaseUrl(options.getBaseUrl()).setResourceName("mfa/verify/totp"),
  );
  const readinessUrl = readinessClient.buildUrl(readinessClient.baseUrl.toString());
  const response = await originalSendRequest.call(readinessClient, "GET", readinessUrl, null, { redirect: "error" });
  if (context) {
    AccountContext.assert(context.generation);
  }
  if (response.status === 200) {
    const json = await originalParseResponse.call(readinessClient, response);
    if (context) {
      AccountContext.assert(context.generation);
    }
    if (
      json.header?.status !== "success" ||
      json.header?.code !== 200 ||
      json.header?.url !== `${readinessUrl.pathname}${readinessUrl.search}` ||
      json.body !== null
    ) {
      throw new Error("The server did not return a valid MFA readiness response.");
    }
    throw new MfaAuthenticationRequiredError(null, {
      mfa_providers: ["totp"],
    });
  }
  if (response.status !== 400 && response.status !== 404) {
    await originalParseResponse.call(readinessClient, response);
    throw new Error("The server did not return a valid MFA readiness status.");
  }
}

export async function assertAuthenticatedAccount(options, account, readinessOptions) {
  const user = await findAuthenticatedUser(options, readinessOptions);
  if (
    user.id !== account.userId ||
    user.username.toLowerCase() !== account.username.toLowerCase() ||
    user.gpgkey?.fingerprint?.toUpperCase() !== account.userKeyFingerprint?.toUpperCase()
  ) {
    const error = new Error("The server cookie belongs to another account. Sign in to the selected account.");
    error.name = "AccountIdentityMismatchError";
    throw error;
  }
  return user;
}

// Installed only in the extension bundle. Shared API services keep using their existing client.
ApiClient.prototype.sendRequest = async function (method, url, body, options) {
  const context = this.options.accountContext;
  if (context) {
    AccountContext.assert(context.generation);
    const base = new URL(context.account.domain);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) {
      throw new Error("An account request cannot leave its server base URL.");
    }
    // Authentication and MFA endpoints must remain reachable before /users/me is authorized.
    const relative = url.pathname.slice(base.pathname.replace(/\/$/, "").length);
    const publicEndpoint = method === "GET" && /^\/(?:settings|healthcheck\/status)\.json$/.test(relative);
    const authenticationEndpoint =
      /^\/auth\/(?:login|verify|logout|is-authenticated)\.json$/.test(relative) ||
      /^\/mfa\/verify(?:\/|\.)/.test(relative);
    if (context.requireIdentity && !publicEndpoint && !authenticationEndpoint) {
      await assertAuthenticatedAccount(this.options, context.account);
      AccountContext.assert(context.generation);
    }
  }
  const response = await originalSendRequest.call(this, method, url, body, {
    ...options,
    redirect: options?.redirect === "manual" ? "manual" : "error",
  });
  if (context) {
    AccountContext.assert(context.generation);
    responseContexts.set(response, context);
  }
  return response;
};

ApiClient.prototype.parseResponseJson = async function (response) {
  const context = responseContexts.get(response);
  const result = await originalParseResponse.call(this, response);
  if (context) {
    AccountContext.assert(context.generation);
  }
  return result;
};
