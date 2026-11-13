import "../../../../../test/mocks/mockSsoDataStorage";
import { enableFetchMocks } from "jest-fetch-mock";
import AuthLoginController from "./authLoginController";
import IsMfaRequiredController from "./isMfaRequiredController";
import OpenTrustedDomainTabController from "../tab/openTrustedDomainTabController";
import SavedAccountRegistry from "../../service/account/savedAccountRegistry";
import SavedAccountsService from "../../service/account/savedAccountsService";
import AccountContext from "../../service/account/accountContext";
import AccountEntity from "../../model/entity/account/accountEntity";
import AccountModel from "../../model/account/accountModel";
import { defaultAccountDto } from "../../model/entity/account/accountEntity.test.data";
import BuildApiClientOptionsService from "../../service/account/buildApiClientOptionsService";
import AuthVerifyServerChallengeService from "../../service/auth/authVerifyServerChallengeService";
import PostLoginService from "../../service/auth/postLoginService";
import AuthLogoutService from "passbolt-styleguide/src/shared/services/api/auth/AuthLogoutService";
import ActiveSessionLocalStorage from "../../service/local_storage/activeSessionLocalStorage";
import FindSiteSettingsService from "../../service/siteSettings/findSiteSettingsService";
import PassphraseStorageService from "../../service/session_storage/passphraseStorageService";
import KeepSessionAliveService from "../../service/session_storage/keepSessionAliveService";
import { anonymousSiteSettings } from "passbolt-styleguide/src/shared/models/entity/siteSettings/siteSettingsEntity.test.data";

let account, options, controller, primary, factorRequired, paths, worker, user;
beforeEach(async () => {
  enableFetchMocks();
  fetch.resetMocks();
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  AccountContext.interactiveRequests.clear();
  ActiveSessionLocalStorage._runtimeCachedData = {};
  account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  await new AccountModel().activate(account);
  options = BuildApiClientOptionsService.buildFromAccount(account);
  primary = false;
  factorRequired = true;
  paths = [];
  worker = { port: { emit: jest.fn() }, tab: undefined };
  user = {
    id: account.userId,
    username: account.username,
    gpgkey: { fingerprint: account.userKeyFingerprint },
    profile: { first_name: account.firstName, last_name: account.lastName },
  };
  controller = new AuthLoginController(worker, "login", options, account);
  // GPGAuth wire/crypto has its own neighboring tests; preserve the real controller, guard and bootstrap services.
  jest.spyOn(controller.updateSsoCredentialsService, "updateSsoKitIfNeeded").mockResolvedValue();
  jest
    .spyOn(controller.authVerifyLoginChallengeService, "verifyAndValidateLoginChallenge")
    .mockImplementation(async () => {
      primary = true;
      return user;
    });
  jest.spyOn(AuthLogoutService.prototype, "logout").mockResolvedValue();
  jest.spyOn(AuthVerifyServerChallengeService.prototype, "verifyAndValidateServerChallenge").mockResolvedValue();
  jest
    .spyOn(browser.tabs, "query")
    .mockResolvedValue([{ url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html") }]);
  jest.spyOn(browser.tabs, "create").mockClear().mockResolvedValue({ id: 42 });
  jest.spyOn(browser.tabs, "update").mockClear().mockResolvedValue({ id: 42 });
  fetch.mockImplementation(async (url, init) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname.endsWith("/mfa/verify/totp.json")) {
      const status = primary && factorRequired ? 200 : 400;
      return new Response(
        JSON.stringify({
          header: { status: status === 200 ? "success" : "error", code: status, url: parsed.pathname + parsed.search },
          body: null,
        }),
        { status },
      );
    }
    if (parsed.pathname.endsWith("/users/me.json")) {
      if (!primary) {
        return new Response(JSON.stringify({ body: null }), { status: 403 });
      }
      if (!factorRequired) {
        return new Response(JSON.stringify({ body: user }), { status: 200 });
      }
    }
    if (parsed.pathname.endsWith("/healthcheck/status.json") || parsed.pathname.endsWith("/settings.json")) {
      if (!(primary && factorRequired)) {
        return new Response(
          JSON.stringify({ body: parsed.pathname.endsWith("/settings.json") ? anonymousSiteSettings() : {} }),
          { status: 200 },
        );
      }
    }
    // The recorded stock response is a 302 to /mfa/verify/error.json. Fetch rejects before exposing Location.
    expect(init.redirect).toBe("error");
    throw new TypeError("Failed to fetch");
  });
});
afterEach(async () => {
  for (const alarm of await browser.alarms.getAll()) {
    await browser.alarms.clear(alarm.name);
  }
});
it.each([false, true])(
  "saved primary-only login defers real bootstrap/settings and hands off through unchanged RPCs, remember %s",
  async (remember) => {
    const bootstrap = jest.spyOn(PostLoginService, "exec");
    const settings = jest.spyOn(FindSiteSettingsService.prototype, "findSiteSettings");
    await controller.exec("ada@passbolt.com", remember, false);
    const initialSlot = await browser.storage.session.get(`passphrase:${account.id}`);
    const mfa = await new IsMfaRequiredController(worker, "status", options, account).exec();
    expect(mfa).toBe(true);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(await KeepSessionAliveService.isStarted()).toBe(false);
    expect((await SavedAccountsService.pending()).saved).toBe(true);
    await new OpenTrustedDomainTabController(worker, "native-mfa").exec();
    expect(browser.tabs.update).toHaveBeenCalledWith(42, { url: `${account.domain}/mfa/verify/totp` });
    expect((await SavedAccountsService.pending()).tab_id).toBe(42);
    factorRequired = false;
    await SavedAccountsService.onPendingNavigation({ tabId: 42, frameId: 0, url: `${account.domain}/app/passwords` });
    expect(await SavedAccountsService.pending()).toBeUndefined();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(await browser.storage.session.get(`passphrase:${account.id}`)).toEqual(initialSlot);
    expect(await KeepSessionAliveService.isStarted()).toBe(remember);
    expect((await new ActiveSessionLocalStorage(account).get()).is_authenticated).toBe(true);
    expect((await SavedAccountRegistry.active()).id).toBe(account.id);
    await SavedAccountsService.reconcilePending();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(paths).not.toContain("/mfa/verify/error.json");
  },
);
it("normal non-MFA login still bootstraps after exact final identity", async () => {
  factorRequired = false;
  const bootstrap = jest.spyOn(PostLoginService, "exec");
  await controller.exec("ada@passbolt.com", false, false);
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect(await PassphraseStorageService.get(account.id)).toBe("ada@passbolt.com");
  expect(paths).toContain("/users/me.json");
});

it("does not renew an expired finite unlock while polling or completing MFA", async () => {
  await controller.exec("ada@passbolt.com", false, false);
  const slot = `passphrase:${account.id}`;
  const original = (await browser.storage.session.get(slot))[slot];
  jest.spyOn(Date, "now").mockReturnValue(original.expires + 1);
  expect(await new IsMfaRequiredController(worker, "status", options, account).exec()).toBe(true);
  await new OpenTrustedDomainTabController(worker, "native-mfa").exec();
  factorRequired = false;
  await SavedAccountsService.reconcilePending();
  expect((await browser.storage.session.get(slot))[slot]).toEqual(original);
  expect(await PassphraseStorageService.get(account.id)).toBeNull();
  expect(await KeepSessionAliveService.isStarted()).toBe(false);
});
it("preserves a valid existing MFA cookie without logout or another primary challenge", async () => {
  primary = true;
  factorRequired = false;
  const bootstrap = jest.spyOn(PostLoginService, "exec");
  await controller.exec("ada@passbolt.com", true, false);
  expect(controller.authVerifyLoginChallengeService.verifyAndValidateLoginChallenge).not.toHaveBeenCalled();
  expect(AuthLogoutService.prototype.logout).not.toHaveBeenCalled();
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(await KeepSessionAliveService.isStarted()).toBe(true);
});
it.each(["id", "username", "fingerprint"])(
  "requires exact final %s after factor before saved-account bootstrap",
  async (field) => {
    const bootstrap = jest.spyOn(PostLoginService, "exec");
    await controller.exec("ada@passbolt.com", true, false);
    await new OpenTrustedDomainTabController(worker, "native-mfa").exec();
    factorRequired = false;
    if (field === "fingerprint") {
      user.gpgkey.fingerprint = "A".repeat(40);
    } else {
      user[field] = field === "id" ? "other-user" : "other@example.test";
    }
    await expect(SavedAccountsService.reconcilePending()).rejects.toThrow("another account");
    expect(bootstrap).not.toHaveBeenCalled();
    expect(await KeepSessionAliveService.isStarted()).toBe(false);
    expect((await SavedAccountRegistry.active()).id).toBe(account.id);
  },
);

it("the real Port dispatch preserves all three saved-login RPC reply shapes and keeps protected handlers gated", async () => {
  const { default: Port } = await import("../../sdk/port");
  const replies = [];
  const port = new Port({
    onMessage: { addListener: jest.fn() },
    onDisconnect: { addListener: jest.fn() },
    postMessage: (message) => replies.push(JSON.parse(message)),
    disconnect: jest.fn(),
  });
  worker.port = port;
  // Keep the same primary wire adapters while exercising actual dispatch and the real subsequent controllers.
  const login = new AuthLoginController(worker, "login", options, account);
  jest.spyOn(login.updateSsoCredentialsService, "updateSsoKitIfNeeded").mockResolvedValue();
  jest.spyOn(login.authVerifyLoginChallengeService, "verifyAndValidateLoginChallenge").mockImplementation(async () => {
    primary = true;
    return user;
  });
  port.on("passbolt.auth.login", (requestId, passphrase, remember) => login._exec(passphrase, remember));
  port.on("passbolt.auth.is-mfa-required", (requestId) =>
    new IsMfaRequiredController(worker, requestId, options, account)._exec(),
  );
  port.on("passbolt.tabs.open-trusted-domain", (requestId) =>
    new OpenTrustedDomainTabController(worker, requestId)._exec(),
  );
  const protectedHandler = jest.fn();
  port.on("passbolt.secret.find", protectedHandler);
  const send = async (message) => {
    port._onMessage(JSON.stringify(message));
    await Promise.allSettled([...AccountContext.running]);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };
  await send(["passbolt.auth.login", "login", "ada@passbolt.com", true]);
  await send(["passbolt.auth.is-mfa-required", "mfa"]);
  await send(["passbolt.tabs.open-trusted-domain", "tab", "https://evil.test/mfa/verify/totp"]);
  await send(["passbolt.secret.find", "protected"]);
  expect(replies).toContainEqual(["login", "SUCCESS"]);
  expect(replies).toContainEqual(["mfa", "SUCCESS", true]);
  expect(replies).toContainEqual(["tab", "SUCCESS"]);
  expect(protectedHandler).not.toHaveBeenCalled();
  expect(browser.tabs.update).toHaveBeenCalledTimes(1);
  expect(browser.tabs.update).toHaveBeenCalledWith(42, { url: `${account.domain}/mfa/verify/totp` });
});

it("the in-page Auth port hands saved primary login to native MFA on its original tab and completes once", async () => {
  const { default: Port } = await import("../../sdk/port");
  const { default: RedirectPostLoginController } = await import("./redirectPostLoginController");
  const { default: WorkersSessionStorage } = await import("../../service/sessionStorage/workersSessionStorage");
  const { default: WorkerEntity } = await import("../../model/entity/worker/workerEntity");
  const { readWorker } = await import("../../model/entity/worker/workerEntity.test.data");
  const tab = { id: 42, url: `${account.domain}/auth/login?redirect=https://evil.test/app` };
  const dto = readWorker({ name: "Auth", tabId: 42, frameId: 3, account_id: account.id });
  await WorkersSessionStorage.addWorker(new WorkerEntity(dto));
  const replies = [];
  worker.name = "Auth";
  worker.tab = tab;
  worker.port = new Port({
    name: dto.id,
    sender: { url: browser.runtime.getURL("/webAccessibleResources/passbolt-iframe-login.html"), tab, frameId: 3 },
    onMessage: { addListener: jest.fn() },
    onDisconnect: { addListener: jest.fn() },
    postMessage: (message) => replies.push(JSON.parse(message)),
    disconnect: jest.fn(),
  });
  worker.port.on("passbolt.auth.login", (requestId, passphrase, remember) => controller._exec(passphrase, remember));
  worker.port.on("passbolt.auth.post-login-redirect", (requestId) =>
    new RedirectPostLoginController(worker, requestId, account)._exec(),
  );
  const bootstrap = jest.spyOn(PostLoginService, "exec");
  worker.port._onMessage(JSON.stringify(["passbolt.auth.login", "login", "ada@passbolt.com", true]));
  await Promise.allSettled([...AccountContext.running]);
  worker.port._onMessage(JSON.stringify(["passbolt.auth.post-login-redirect", "redirect"]));
  await Promise.allSettled([...AccountContext.running]);
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  expect(replies).toContainEqual(["login", "SUCCESS"]);
  expect(replies).toContainEqual(["redirect", "SUCCESS"]);
  expect(browser.tabs.create).not.toHaveBeenCalled();
  expect(browser.tabs.update).toHaveBeenCalledWith(42, { url: `${account.domain}/mfa/verify/totp` });
  expect((await SavedAccountsService.pending()).tab_id).toBe(42);
  expect(bootstrap).not.toHaveBeenCalled();
  factorRequired = false;
  await SavedAccountsService.onPendingNavigation({ tabId: 42, frameId: 0, url: `${account.domain}/app/passwords` });
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect((await SavedAccountRegistry.active()).userId).toBe(account.userId);
  await SavedAccountsService.reconcilePending();
  expect(bootstrap).toHaveBeenCalledTimes(1);
});
