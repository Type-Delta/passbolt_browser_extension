import AuthenticationStatusService from "../authenticationStatusService";
import { SavedAccountsEvents } from "../../event/savedAccountsEvents";
import { enableFetchMocks } from "jest-fetch-mock";
import { ApiClient } from "passbolt-styleguide/src/shared/lib/apiClient/apiClient";
import { ApiClientOptions } from "passbolt-styleguide/src/shared/lib/apiClient/apiClientOptions";
import { findAuthenticatedUser } from "./accountApiGuard";
import SavedAccountsService from "./savedAccountsService";
import SavedAccountRegistry from "./savedAccountRegistry";
import AccountContext from "./accountContext";
import AccountEntity from "../../model/entity/account/accountEntity";
import { defaultAccountDto } from "../../model/entity/account/accountEntity.test.data";
import Keyring from "../../model/keyring";
import PassphraseStorageService from "../session_storage/passphraseStorageService";
import toolbarService from "../toolbar/toolbarService";
import PostLoginService from "../auth/postLoginService";
import AuthLogoutService from "passbolt-styleguide/src/shared/services/api/auth/AuthLogoutService";
import AuthVerifyLoginChallengeService from "../auth/authVerifyLoginChallengeService";
import AuthVerifyServerChallengeService from "../auth/authVerifyServerChallengeService";
import AuthVerifyServerKeyService from "../api/auth/authVerifyServerKeyService";
import MfaAuthenticationRequiredError from "../../error/mfaAuthenticationRequiredError";
let account, user, options, input, factorRequired, meUser, readinessStatus, readinessHeaderUrl, redirectAt, redirects;
beforeEach(() => {
  enableFetchMocks();
  fetch.resetMocks();
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  const dto = defaultAccountDto({ domain: "https://server.test/team" });
  account = new AccountEntity(dto);
  user = {
    id: account.userId,
    username: account.username,
    profile: { first_name: dto.first_name, last_name: dto.last_name },
    gpgkey: { fingerprint: account.userKeyFingerprint },
  };
  options = new ApiClientOptions().setBaseUrl(account.domain);
  input = {
    domain: account.domain,
    username: account.username,
    user_private_armored_key: account.userPrivateArmoredKey,
    passphrase: "ada@passbolt.com",
  };
  factorRequired = true;
  meUser = user;
  readinessStatus = null;
  readinessHeaderUrl = null;
  redirectAt = null;
  redirects = [];
  jest.spyOn(PostLoginService, "exec").mockResolvedValue();
  jest.spyOn(toolbarService, "handleUserLoggedIn").mockResolvedValue();
  jest.spyOn(AuthLogoutService.prototype, "logout").mockResolvedValue();
  jest
    .spyOn(AuthVerifyServerKeyService.prototype, "getServerKey")
    .mockResolvedValue({ armored_key: dto.server_public_armored_key });
  jest.spyOn(AuthVerifyServerChallengeService.prototype, "verifyAndValidateServerChallenge").mockResolvedValue();
  jest.spyOn(AuthVerifyLoginChallengeService.prototype, "verifyAndValidateLoginChallenge").mockResolvedValue(user);
  fetch.mockImplementation(async (url, opts) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/mfa/verify/totp.json")) {
      if (redirectAt === "readiness") {
        redirects.push(url);
        throw new TypeError("Failed to fetch");
      }
      const status = readinessStatus || (factorRequired ? 200 : 400);
      return new Response(
        JSON.stringify({
          header: {
            status: status === 200 ? "success" : "error",
            code: status,
            url: readinessHeaderUrl || parsed.pathname + parsed.search,
          },
          body: status === 200 ? null : "",
        }),
        { status },
      );
    }
    if (parsed.pathname.endsWith("/users/me.json")) {
      if (factorRequired || redirectAt === "me") {
        // Real Fetch redirect:error rejects before the 302 target/body is exposed.
        expect(opts.redirect).toBe("error");
        redirects.push(url);
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({ body: meUser }), { status: 200 });
    }
    return new Response(JSON.stringify({ body: [] }), { status: 200 });
  });
});
afterEach(async () => {
  for (const alarm of await browser.alarms.getAll()) {
    await browser.alarms.clear(alarm.name);
  }
});
it("classifies exact read-only TOTP readiness and never follows the me redirect", async () => {
  await expect(findAuthenticatedUser(options, { checkMfa: true })).rejects.toBeInstanceOf(
    MfaAuthenticationRequiredError,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(redirects).toEqual([]);
  expect(fetch.mock.calls[0][1].redirect).toBe("error");
});
it("keeps new enrollment session-only through list/publish before factor, then requires exact final me", async () => {
  const result = await SavedAccountsService.add(input);
  expect(result.requires_unlock).toBe(true);
  expect(result.url).toBe(`${account.domain}/mfa/verify/totp`);
  expect(new Keyring().findPrivate()).toBeUndefined();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
  expect((await SavedAccountsService.list()).accounts).toEqual([]);
  await SavedAccountsService.publishChanged();
  expect(await SavedAccountsService.pending()).toBeDefined();
  expect(JSON.stringify(await browser.storage.local.get(null))).not.toContain(input.user_private_armored_key);
  factorRequired = false;
  await SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    { tab: { id: 42 } },
  );
  await SavedAccountsService.reconcilePending();
  expect((await SavedAccountRegistry.active()).userId).toBe(user.id);
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect(fetch.mock.calls.some(([url]) => url.includes("/users/me.json"))).toBe(true);
});
it("saved reauthentication creates pending without resetting its original unlock deadline", async () => {
  await SavedAccountRegistry.save(account, true);
  await PassphraseStorageService.set(input.passphrase, 60, account.id);
  const slot = (await browser.storage.session.get(`passphrase:${account.id}`))[`passphrase:${account.id}`];
  const result = await SavedAccountsService.switch(account.id);
  expect(result.requires_unlock).toBe(true);
  expect(result.url).toBe(`${account.domain}/mfa/verify/totp`);
  expect((await SavedAccountsService.pending()).saved).toBe(true);
  await SavedAccountsService.list();
  expect(await SavedAccountsService.pending()).toBeDefined();
  expect((await browser.storage.session.get(`passphrase:${account.id}`))[`passphrase:${account.id}`]).toEqual(slot);
});
it("does not discard pending while the native factor is still required", async () => {
  await SavedAccountsService.savePending(account, input.passphrase, false);
  await expect(SavedAccountsService.reconcilePending()).resolves.toBeNull();
  expect(await SavedAccountsService.pending()).toBeDefined();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});
it.each(["id", "username", "fingerprint"])(
  "rejects final me mismatch for %s without durable enrollment",
  async (field) => {
    await SavedAccountsService.savePending(account, input.passphrase, false);
    await SavedAccountsService.navigate(
      { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
      { tab: { id: 42 } },
    );
    factorRequired = false;
    if (field === "fingerprint") {
      meUser = { ...user, gpgkey: { fingerprint: "0".repeat(40) } };
    } else {
      meUser = {
        ...user,
        [field]: field === "id" ? "different-id" : "other@example.test",
      };
    }
    await expect(SavedAccountsService.reconcilePending()).rejects.toThrow();
    expect(await SavedAccountsService.pending()).toBeUndefined();
    expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
  },
);
it("preserves satisfied and non-MFA identity resolution without declaring MFA", async () => {
  factorRequired = false;
  await expect(findAuthenticatedUser(options, { checkMfa: true })).resolves.toEqual(user);
  expect(fetch.mock.calls.map(([, opts]) => opts.redirect)).toEqual(["error", "error"]);
});
it("keeps the ordinary account guard independent of readiness", async () => {
  factorRequired = false;
  await expect(findAuthenticatedUser(options)).resolves.toEqual(user);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  "https://evil.test/team/mfa/verify/totp.json?api-version=v2",
  "/team-evil/mfa/verify/totp.json?api-version=v2",
  "/team/unrelated.json",
])("rejects a success body claiming wrong readiness path %s", async (path) => {
  readinessHeaderUrl = path;
  await expect(findAuthenticatedUser(options, { checkMfa: true })).rejects.not.toBeInstanceOf(
    MfaAuthenticationRequiredError,
  );
});
it.each(["https://evil.test/x", "https://server.test/team-evil/x", "https://server.test/team/unrelated.json"])(
  "keeps readiness redirect target %s unfollowed and rejected",
  async (target) => {
    redirectAt = "readiness";
    await expect(findAuthenticatedUser(options, { checkMfa: true })).rejects.not.toBeInstanceOf(
      MfaAuthenticationRequiredError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
    // The native Fetch boundary deliberately does not expose or follow target.
    expect(fetch.mock.calls.some(([url]) => url === target)).toBe(false);
  },
);
it("does not turn a non-MFA me redirect failure into a pending account", async () => {
  factorRequired = false;
  redirectAt = "me";
  await expect(SavedAccountsService.add(input)).rejects.not.toBeInstanceOf(MfaAuthenticationRequiredError);
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});
it("does not treat a random 403 readiness response as MFA", async () => {
  readinessStatus = 403;
  await expect(SavedAccountsService.add(input)).rejects.not.toBeInstanceOf(MfaAuthenticationRequiredError);
  expect(await SavedAccountsService.pending()).toBeUndefined();
});

it("keeps public metadata reachable without using MFA as identity proof", async () => {
  options.accountContext = {
    account,
    generation: AccountContext.generation,
    requireIdentity: true,
  };
  const api = new ApiClient(options.setResourceName("settings"));
  await expect(api.findAll()).resolves.toEqual({ body: [] });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain("/team/settings.json");
});
it("fails closed on protected metadata before sending the metadata request", async () => {
  options.accountContext = {
    account,
    generation: AccountContext.generation,
    requireIdentity: true,
  };
  const api = new ApiClient(options.setResourceName("metadata/keys"));
  await expect(api.findAll()).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain("/team/users/me.json");
});
it("lets an unsupported readiness endpoint proceed only through final me", async () => {
  factorRequired = false;
  readinessStatus = 404;
  await expect(findAuthenticatedUser(options, { checkMfa: true })).resolves.toEqual(user);
  expect(fetch.mock.calls.some(([url]) => url.includes("/users/me.json"))).toBe(true);
});
it("keeps unsupported-provider MFA closed rather than inferring it from me failure", async () => {
  readinessStatus = 400;
  await expect(SavedAccountsService.add(input)).rejects.not.toBeInstanceOf(MfaAuthenticationRequiredError);
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});
it.each([
  JSON.stringify({
    header: { status: "success", code: 201, url: "/team/mfa/verify/totp.json?api-version=v2" },
    body: null,
  }),
  JSON.stringify({
    header: { status: "error", code: 200, url: "/team/mfa/verify/totp.json?api-version=v2" },
    body: null,
  }),
  JSON.stringify({
    header: { status: "success", code: 200, url: "/team/mfa/verify/totp.json?api-version=v2" },
    body: {},
  }),
  "<html>proxy error</html>",
])("rejects malformed readiness success without treating it as MFA: %s", async (body) => {
  fetch.mockImplementationOnce(async () => new Response(body, { status: 200 }));
  await expect(findAuthenticatedUser(options, { checkMfa: true })).rejects.not.toBeInstanceOf(
    MfaAuthenticationRequiredError,
  );
});

it("toolbar status recognizes verified TOTP readiness after native redirect:error rejects is-authenticated", async () => {
  options.accountContext = { account, generation: 0, requireIdentity: true };
  fetch.mockImplementationOnce(async (url, opts) => {
    expect(url).toContain("/auth/is-authenticated.json");
    expect(opts.redirect).toBe("error");
    throw new TypeError("Failed to fetch");
  });
  await expect(new AuthenticationStatusService(options).isAuthenticated()).rejects.toBeInstanceOf(
    MfaAuthenticationRequiredError,
  );
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/team/auth/is-authenticated.json",
    "/team/mfa/verify/totp.json",
  ]);
});

it.each([false, true])(
  "binds the native MFA tab before SUCCESS even if popup publication fails, reply disconnected=%s",
  async (disconnected) => {
    const listeners = {};
    const order = [];
    const port = {
      _port: {
        sender: { url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html?passbolt=quickaccess") },
      },
      on: (name, fn) => {
        listeners[name] = fn;
      },
      emitQuiet: jest.fn(async (id, status) => {
        order.push(status);
        if (status === "SUCCESS") {
          order.push(`bound:${(await SavedAccountsService.pending()).tab_id}`);
          if (disconnected) {
            throw new Error("popup disconnected");
          }
        }
      }),
    };
    jest.spyOn(browser.tabs, "create").mockImplementation(async () => {
      order.push("reserve");
      return { id: 42 };
    });
    jest.spyOn(browser.tabs, "update").mockImplementation(async (tabId, { url }) => {
      expect((await SavedAccountsService.pending()).tab_id).toBe(tabId);
      expect(url).toBe(`${account.domain}/mfa/verify/totp`);
      order.push("navigate");
      return { id: tabId, url };
    });
    jest.spyOn(SavedAccountsService, "publishChanged").mockRejectedValue(new Error("popup disconnected"));
    SavedAccountsEvents.listen({ port, name: "QuickAccess" });
    await listeners["passbolt.accounts.add"]("request", input);
    expect(order).toEqual(["reserve", "navigate", "SUCCESS", "bound:42"]);
    expect((await SavedAccountsService.pending()).tab_id).toBe(42);
  },
);
