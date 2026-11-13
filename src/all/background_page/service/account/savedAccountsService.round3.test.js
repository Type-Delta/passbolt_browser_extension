import ActiveSessionLocalStorage from "../local_storage/activeSessionLocalStorage";
import UserActiveSessionEntity from "passbolt-styleguide/src/shared/models/entity/session/userActiveSessionEntity";
import PostLogoutService from "../auth/postLogoutService";
import "../../../../../test/mocks/mockSsoDataStorage";
import { enableFetchMocks } from "jest-fetch-mock";
import SavedAccountsService from "./savedAccountsService";
import SavedAccountRegistry from "./savedAccountRegistry";
import AccountContext from "./accountContext";
import AccountEntity from "../../model/entity/account/accountEntity";
import AccountModel from "../../model/account/accountModel";
import { defaultAccountDto, adminAccountDto } from "../../model/entity/account/accountEntity.test.data";
import KeepSessionAliveService from "../session_storage/keepSessionAliveService";
import PassphraseStorageService from "../session_storage/passphraseStorageService";
import StartLoopAuthSessionCheckService from "../auth/startLoopAuthSessionCheckService";
import PostLoginService from "../auth/postLoginService";
import toolbarService from "../toolbar/toolbarService";
import AuthLogoutService from "passbolt-styleguide/src/shared/services/api/auth/AuthLogoutService";
import AuthVerifyLoginChallengeService from "../auth/authVerifyLoginChallengeService";
import AuthVerifyServerKeyService from "../api/auth/authVerifyServerKeyService";
import AuthVerifyServerChallengeService from "../auth/authVerifyServerChallengeService";

function deferred() {
  let finish, fail;
  const promise = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, resolve: finish, reject: fail };
}
const identity = (account) => ({
  id: account.userId,
  username: account.username,
  gpgkey: { fingerprint: account.userKeyFingerprint },
  profile: { first_name: account.firstName, last_name: account.lastName },
});
let a, b, sessions;
beforeEach(async () => {
  enableFetchMocks();
  fetch.resetMocks();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  ActiveSessionLocalStorage._runtimeCachedData = {};
  a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto({ domain: "https://a.test" })), true);
  b = new AccountEntity(adminAccountDto({ domain: "https://b.test" }));
  await new AccountModel().activate(a);
  sessions = new Map([[a.domain, identity(a)]]);
  fetch.mockImplementation(async (url) => {
    const parsed = new URL(url);
    const domain = parsed.origin;
    if (parsed.pathname === "/mfa/verify/totp.json") {
      return new Response(
        JSON.stringify({ header: { status: "error", code: 400, url: parsed.pathname + parsed.search }, body: null }),
        { status: 400 },
      );
    }
    if (["/healthcheck/status.json", "/auth/is-authenticated.json"].includes(parsed.pathname)) {
      return new Response(JSON.stringify({ body: {} }), { status: 200 });
    }
    if (parsed.pathname === "/users/me.json") {
      return new Response(JSON.stringify({ body: sessions.get(domain) || null }), {
        status: sessions.has(domain) ? 200 : 403,
      });
    }
    throw new Error(`Unexpected test endpoint ${parsed.pathname}`);
  });
  jest.spyOn(PostLoginService, "exec").mockResolvedValue();
  jest.spyOn(toolbarService, "handleUserLoggedIn").mockResolvedValue();
  jest.spyOn(AuthLogoutService.prototype, "logout").mockImplementation(async function () {
    sessions.delete(this.apiClient.options.getBaseUrl().toString().replace(/\/$/, ""));
  });
  jest.spyOn(browser.tabs, "create").mockResolvedValue({ id: 42 });
  jest.spyOn(browser.tabs, "update").mockResolvedValue({ id: 42 });
  jest.spyOn(browser.tabs, "remove").mockResolvedValue();
  jest.spyOn(browser.tabs, "get").mockImplementation(async (id) => ({ id, url: "about:blank" }));
});
afterEach(async () => {
  for (const alarm of await browser.alarms.getAll()) {
    await browser.alarms.clear(alarm.name);
  }
});
async function arm(duration = -1) {
  await new ActiveSessionLocalStorage(a).set(
    new UserActiveSessionEntity({
      is_authenticated: true,
      is_mfa_required: false,
      type: "online",
      is_server_reachable: true,
    }),
  );
  await PassphraseStorageService.set("original", duration, a.id);
  await KeepSessionAliveService.start();
  await StartLoopAuthSessionCheckService.exec();
  return browser.storage.session.get(`passphrase:${a.id}`);
}
async function alarms() {
  return {
    keep: await KeepSessionAliveService.isStarted(),
    check: Boolean(await browser.alarms.get(StartLoopAuthSessionCheckService.ALARM_NAME)),
  };
}
it("does not start native IPC when cancellation begins during the binding write", async () => {
  const pending = await SavedAccountsService.savePending(b, "pending", false);
  const entered = deferred(),
    release = deferred();
  const set = browser.storage.session.set.bind(browser.storage.session);
  jest.spyOn(browser.storage.session, "set").mockImplementation(async (value) => {
    if (value.pending_account?.tab_id === 42) {
      entered.resolve();
      await release.promise;
    }
    return set(value);
  });
  const navigation = SavedAccountsService.navigate(SavedAccountsService.pendingResult(b, pending), {}).catch(
    (error) => error,
  );
  await entered.promise;
  const cancel = SavedAccountsService.cancelPendingSignIn();
  expect(AccountContext.transitioning).toBe(true);
  release.resolve();
  await cancel;
  expect(await navigation).toBeInstanceOf(Error);
  expect(browser.tabs.update).not.toHaveBeenCalled();
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect(browser.tabs.remove).toHaveBeenCalledWith(42);
});
it.each(["cancel", "replace-own", "replace-other"])(
  "rejects successful stale native completion without touching a replacement tab: %s",
  async (action) => {
    const pending = await SavedAccountsService.savePending(b, "old", false);
    const started = deferred(),
      completed = deferred();
    browser.tabs.update.mockImplementationOnce(() => {
      started.resolve();
      return completed.promise;
    });
    const navigation = SavedAccountsService.navigate(SavedAccountsService.pendingResult(b, pending), {}).catch(
      (error) => error,
    );
    await started.promise;
    if (action === "cancel") {
      await SavedAccountsService.cancelPendingSignIn();
    } else {
      const replacement = await SavedAccountsService.savePending(b, "new", false);
      await SavedAccountsService.navigate(SavedAccountsService.pendingResult(b, replacement), {
        tab: { id: action === "replace-own" ? 42 : 43 },
      });
    }
    const current = await SavedAccountsService.pending();
    completed.resolve({ id: 42 });
    expect(await navigation).toBeInstanceOf(Error);
    expect(await SavedAccountsService.pending()).toEqual(current);
    expect(browser.tabs.remove).toHaveBeenCalledTimes(action === "replace-own" ? 0 : 1);
    if (action !== "replace-own") {
      expect(browser.tabs.remove).toHaveBeenCalledWith(42);
    }
  },
);
it("an ordinary handoff cannot resolve successfully after its generation changes during IPC", async () => {
  const started = deferred(),
    completed = deferred();
  browser.tabs.update.mockImplementationOnce(() => {
    started.resolve();
    return completed.promise;
  });
  const navigating = SavedAccountsService.navigate(
    { account_id: a.id, url: `${a.domain}/app/passwords` },
    { tab: { id: 42 } },
  ).catch((error) => error);
  await started.promise;
  await AccountContext.transition(async () => {});
  completed.resolve({ id: 42 });
  expect(await navigating).toBeInstanceOf(Error);
  expect(browser.tabs.remove).not.toHaveBeenCalled();
});
it("a mistyped other-backend enrollment restores the original remembered foreground's alarms", async () => {
  const before = await arm();
  const dto = defaultAccountDto({ domain: b.domain });
  jest
    .spyOn(AuthVerifyServerKeyService.prototype, "getServerKey")
    .mockResolvedValue({ armored_key: dto.server_public_armored_key });
  jest.spyOn(AuthVerifyServerChallengeService.prototype, "verifyAndValidateServerChallenge").mockResolvedValue();
  const user = identity(new AccountEntity(dto));
  jest
    .spyOn(AuthVerifyLoginChallengeService.prototype, "verifyAndValidateLoginChallenge")
    .mockImplementation(async () => {
      sessions.set(b.domain, user);
      return user;
    });
  await expect(
    SavedAccountsService.add({
      domain: b.domain,
      username: "mistyped@example.test",
      user_private_armored_key: dto.user_private_armored_key,
      passphrase: "ada@passbolt.com",
    }),
  ).rejects.toThrow("does not match");
  expect(await alarms()).toEqual({ keep: true, check: true });
  expect((await SavedAccountRegistry.active()).id).toBe(a.id);
  expect(await browser.storage.session.get(`passphrase:${a.id}`)).toEqual(before);
});
it.each([-1, 60])(
  "retained foreground maintenance resumes without rewriting its slot, duration %s",
  async (duration) => {
    const before = await arm(duration);
    await SavedAccountsService.transition(undefined, async () => {
      await SavedAccountsService.savePending(b, "pending", false);
      return SavedAccountsService.pendingResult(b, await SavedAccountsService.pending());
    });
    expect(await alarms()).toEqual({ keep: duration === -1, check: true });
    await SavedAccountsService.cancelPendingSignIn();
    expect(await alarms()).toEqual({ keep: duration === -1, check: true });
    expect(await browser.storage.session.get(`passphrase:${a.id}`)).toEqual(before);
  },
);
it("same-backend pending/cancel with another cookie never starts maintenance or destroys the original slot", async () => {
  const before = await arm();
  const other = new AccountEntity(adminAccountDto({ domain: a.domain }));
  sessions.set(a.domain, identity(other));
  await SavedAccountsService.transition(undefined, async () => {
    await SavedAccountsService.savePending(other, "pending", true);
    return SavedAccountsService.pendingResult(other, await SavedAccountsService.pending());
  });
  expect(await alarms()).toEqual({ keep: false, check: false });
  await SavedAccountsService.cancelPendingSignIn();
  expect(await alarms()).toEqual({ keep: false, check: false });
  expect(await browser.storage.session.get(`passphrase:${a.id}`)).toEqual(before);
});
it("a conditional commit returning null safely resumes only the retained foreground", async () => {
  const before = await arm();
  const pending = await SavedAccountsService.savePending(b, "pending", false);
  expect(
    await SavedAccountsService.transition(
      undefined,
      async () => {
        await SavedAccountsService.cancelPending(pending);
        return null;
      },
      undefined,
      pending,
    ),
  ).toBeNull();
  expect(await alarms()).toEqual({ keep: true, check: true });
  expect(await browser.storage.session.get(`passphrase:${a.id}`)).toEqual(before);
});

it("same-backend pending cancellation with the original cookie restores maintenance without logout", async () => {
  const before = await arm();
  const other = new AccountEntity(adminAccountDto({ domain: a.domain }));
  await SavedAccountsService.transition(undefined, async () => {
    await SavedAccountsService.savePending(other, "pending", true);
    return SavedAccountsService.pendingResult(other, await SavedAccountsService.pending());
  });
  await SavedAccountsService.cancelPendingSignIn();
  const logout = jest.spyOn(PostLogoutService, "exec");
  await StartLoopAuthSessionCheckService.handleAuthStatusCheckAlarm({
    name: StartLoopAuthSessionCheckService.ALARM_NAME,
  });
  expect(logout).not.toHaveBeenCalled();
  expect(AuthLogoutService.prototype.logout).not.toHaveBeenCalled();
  expect(await alarms()).toEqual({ keep: true, check: true });
  expect(await browser.storage.session.get(`passphrase:${a.id}`)).toEqual(before);
});
it("real stale reconciliation returning null restores the other-backend foreground without extending its slot", async () => {
  const before = await arm();
  sessions.set(b.domain, identity(b));
  const pending = await SavedAccountsService.savePending(b, "pending", false);
  await SavedAccountsService.navigate(SavedAccountsService.pendingResult(b, pending), { tab: { id: 42 } });
  const proof = deferred(),
    started = deferred();
  const request = fetch.getMockImplementation();
  let me = 0;
  fetch.mockImplementation(async (...args) => {
    if (new URL(args[0]).origin === b.domain && new URL(args[0]).pathname === "/users/me.json" && ++me === 2) {
      started.resolve();
      await proof.promise;
    }
    return request(...args);
  });
  const reconciliation = SavedAccountsService.reconcilePending();
  await started.promise;
  await SavedAccountsService.cancelPending(pending);
  proof.resolve();
  expect(await reconciliation).toBeNull();
  expect(await alarms()).toEqual({ keep: true, check: true });
  expect((await SavedAccountRegistry.active()).id).toBe(a.id);
  expect(await browser.storage.session.get(`passphrase:${a.id}`)).toEqual(before);
});
it("restoration cannot re-arm or clear maintenance for a newly selected account", async () => {
  await arm();
  await SavedAccountRegistry.save(b);
  const started = deferred(),
    proof = deferred();
  const request = fetch.getMockImplementation();
  fetch.mockImplementation(async (...args) => {
    if (new URL(args[0]).pathname === "/users/me.json") {
      started.resolve();
      await proof.promise;
    }
    return request(...args);
  });
  await KeepSessionAliveService.stop();
  await StartLoopAuthSessionCheckService.clearAlarm();
  const restoration = SavedAccountsService.resumeForegroundMaintenance(a.id);
  await started.promise;
  await SavedAccountRegistry.save(b, true);
  await PassphraseStorageService.set("selected", -1, b.id);
  await KeepSessionAliveService.start();
  await StartLoopAuthSessionCheckService.exec();
  const before = await browser.alarms.getAll();
  proof.resolve();
  await restoration;
  expect(await browser.alarms.getAll()).toEqual(before);
  expect(await PassphraseStorageService.get(b.id)).toBe("selected");
});
it("stale native completion never closes an owned tab that has already become an authenticated vault", async () => {
  const pending = await SavedAccountsService.savePending(b, "pending", false);
  const started = deferred(),
    complete = deferred();
  browser.tabs.update.mockImplementationOnce(() => {
    started.resolve();
    return complete.promise;
  });
  const navigation = SavedAccountsService.navigate(SavedAccountsService.pendingResult(b, pending), {}).catch(
    (error) => error,
  );
  await started.promise;
  await SavedAccountsService.cancelPending(pending);
  browser.tabs.get.mockResolvedValue({ id: 42, url: `${b.domain}/app/passwords` });
  complete.resolve({ id: 42 });
  expect(await navigation).toBeInstanceOf(Error);
  expect(browser.tabs.remove).not.toHaveBeenCalled();
});

it.each(["cancel", "replace"])(
  "the actual account event never emits old SUCCESS after native IPC becomes stale: %s",
  async (action) => {
    const { SavedAccountsEvents } = await import("../../event/savedAccountsEvents");
    const pending = await SavedAccountsService.savePending(b, "pending", false);
    jest.spyOn(SavedAccountsService, "add").mockResolvedValue(SavedAccountsService.pendingResult(b, pending));
    jest.spyOn(SavedAccountsService, "publishChanged").mockResolvedValue();
    const listeners = {};
    const port = {
      _port: {
        sender: { url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html?passbolt=quickaccess") },
      },
      on: (name, callback) => {
        listeners[name] = callback;
      },
      emitQuiet: jest.fn().mockResolvedValue(),
    };
    SavedAccountsEvents.listen({ name: "QuickAccess", port });
    const started = deferred(),
      completed = deferred();
    browser.tabs.update.mockImplementationOnce(() => {
      started.resolve();
      return completed.promise;
    });
    const request = listeners["passbolt.accounts.add"]("add-request", {});
    await started.promise;
    if (action === "cancel") {
      await SavedAccountsService.cancelPendingSignIn();
    } else {
      await SavedAccountsService.savePending(b, "replacement", false);
    }
    completed.resolve({ id: 42 });
    await request;
    expect(port.emitQuiet).toHaveBeenCalledWith(
      "add-request",
      "ERROR",
      expect.objectContaining({ message: expect.stringContaining("canceled") }),
    );
    expect(port.emitQuiet.mock.calls.some(([, status]) => status === "SUCCESS")).toBe(false);
  },
);
it.each(["expired", "locked", "unreachable", "mfa"])(
  "does not resume unsafe foreground maintenance: %s",
  async (state) => {
    const before = await arm(60);
    const slot = `passphrase:${a.id}`;
    if (state === "expired") {
      jest.spyOn(Date, "now").mockReturnValue(before[slot].expires + 1);
    }
    if (state === "locked") {
      await PassphraseStorageService.flush(a.id);
    }
    if (state === "unreachable") {
      fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    }
    if (state === "mfa") {
      fetch.mockImplementation(async (url) => {
        const page = new URL(url);
        return new Response(
          JSON.stringify({ header: { status: "success", code: 200, url: page.pathname + page.search }, body: null }),
          { status: 200 },
        );
      });
    }
    await SavedAccountsService.transition(undefined, async () => null);
    expect(await alarms()).toEqual({ keep: false, check: false });
    if (["unreachable", "mfa"].includes(state)) {
      expect(await browser.storage.session.get(slot)).toEqual(before);
    }
  },
);
it("foreground teardown clears the toolbar's cached URL for the next account's count", async () => {
  toolbarService.tabUrl = "https://login.test";
  await SavedAccountsService.clearWorkingState();
  expect(toolbarService.tabUrl).toBeNull();
});
