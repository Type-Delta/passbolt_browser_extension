import { v4 as uuidv4 } from "uuid";
import { pgpKeys } from "passbolt-styleguide/test/fixture/pgpKeys/keys";
import { SavedAccountsEvents } from "./savedAccountsEvents";
import SavedAccountRegistry from "../service/account/savedAccountRegistry";
import SavedServerRegistry from "../service/account/savedServerRegistry";
import WorkersSessionStorage from "../service/sessionStorage/workersSessionStorage";
import WorkerEntity from "../model/entity/worker/workerEntity";
import PortManager from "../sdk/port/portManager";
import AccountContext from "../service/account/accountContext";
import AuthVerifyServerKeyService from "../service/api/auth/authVerifyServerKeyService";
import AuthVerifyServerChallengeService from "../service/auth/authVerifyServerChallengeService";
import AuthVerifyLoginChallengeService from "../service/auth/authVerifyLoginChallengeService";
import AuthLogoutService from "passbolt-styleguide/src/shared/services/api/auth/AuthLogoutService";
import { adminAccountDto, defaultAccountDto } from "../model/entity/account/accountEntity.test.data";
import AccountEntity from "../model/entity/account/accountEntity";

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  AccountContext.interactiveRequests.clear();
  PortManager._ports = {};
  browser.runtime.getURL.mockImplementation((file) => `chrome-extension://test/${file.replace(/^\/+/, "")}`);
});

afterEach(async () => {
  for (const alarm of await browser.alarms.getAll()) {
    await browser.alarms.clear(alarm.name);
  }
});

async function onboardingWorker(tabId = 31) {
  const state = await SavedAccountRegistry.read();
  const id = uuidv4();
  const url = browser.runtime.getURL(
    `webAccessibleResources/quickaccess.html?passbolt=${id}&uiMode=tab&feature=add-account`,
  );
  const listeners = {};
  const worker = {
    name: "QuickAccess",
    tab: { id: tabId, url },
    port: {
      accountGeneration: 0,
      _port: { name: id, sender: { url, frameId: 0, tab: { id: tabId, url } } },
      on: (name, callback) => {
        listeners[name] = callback;
      },
      emitQuiet: jest.fn().mockResolvedValue(),
      disconnect: jest.fn(() => {
        delete PortManager._ports[id];
      }),
    },
  };
  await WorkersSessionStorage.addWorker(
    new WorkerEntity({
      id,
      name: "QuickAccess",
      tabId,
      frameId: 0,
      account_id: state.active_account_id,
      status: "connected",
    }),
  );
  PortManager._ports[id] = worker.port;
  SavedAccountsEvents.listen(worker);
  return { worker, listeners };
}

async function enrollment() {
  const dto = defaultAccountDto();
  await SavedServerRegistry.remember({
    domain: dto.domain,
    server_key_fingerprint: pgpKeys.server.fingerprint,
    checked_at: Date.now(),
  });
  return {
    domain: dto.domain,
    username: dto.username,
    user_private_armored_key: dto.user_private_armored_key,
    passphrase: "ada@passbolt.com",
    security_token: { code: "CUS", color: "#123456", textcolor: "#ffffff" },
    expected_server_key_fingerprint: pgpKeys.server.fingerprint,
  };
}

it.each([
  ["server", false],
  ["identity", false],
  ["server", true],
  ["identity", true],
])(
  "allows the same onboarding tab to check its supplied key again after a rolled-back %s failure, foreground=%s",
  async (failure, foreground) => {
    if (foreground) {
      await SavedAccountRegistry.save(
        new AccountEntity(adminAccountDto({ domain: "https://foreground.example" })),
        true,
      );
    }
    const { worker, listeners } = await onboardingWorker();
    const other = await onboardingWorker(32);
    const input = await enrollment();
    const before = await SavedAccountRegistry.read();
    const server = jest.spyOn(AuthVerifyServerKeyService.prototype, "getServerKey");
    if (failure === "server") {
      server.mockRejectedValue(new Error("Controlled discovery failure"));
    } else {
      server.mockResolvedValue({ armored_key: pgpKeys.server.public });
      jest.spyOn(AuthLogoutService.prototype, "logout").mockResolvedValue();
      jest.spyOn(AuthVerifyServerChallengeService.prototype, "verifyAndValidateServerChallenge").mockResolvedValue();
      jest.spyOn(AuthVerifyLoginChallengeService.prototype, "verifyAndValidateLoginChallenge").mockResolvedValue({
        id: pgpKeys.ada.userId,
        username: "another@example.test",
        gpgkey: { fingerprint: pgpKeys.ada.fingerprint },
      });
    }
    jest.spyOn(browser.tabs, "get").mockResolvedValue({ ...worker.tab });

    await listeners["passbolt.accounts.add"]("first-add", input);
    expect(worker.port.emitQuiet).toHaveBeenCalledWith(
      "first-add",
      "ERROR",
      expect.objectContaining({
        message:
          failure === "server"
            ? "Controlled discovery failure"
            : "The authenticated account does not match the email and imported key.",
      }),
    );
    expect(AccountContext.generation).toBe(1);
    expect(await SavedAccountRegistry.read()).toEqual(before);

    await listeners["passbolt.accounts.check-passphrase"]("retry-check", {
      user_private_armored_key: input.user_private_armored_key,
      passphrase: input.passphrase,
    });
    expect(worker.port.emitQuiet).toHaveBeenCalledWith("retry-check", "SUCCESS", undefined);
    expect(worker.port.accountGeneration).toBe(1);
    expect(await PortManager.isOnboardingSender("QuickAccess", worker.port._port.sender, worker.port._port.name)).toBe(
      true,
    );
    expect(other.worker.port.accountGeneration).toBe(0);
    expect(other.worker.port.disconnect).toHaveBeenCalledTimes(1);
    await other.listeners["passbolt.accounts.check-passphrase"]("other-check", {
      user_private_armored_key: input.user_private_armored_key,
      passphrase: input.passphrase,
    });
    expect(other.worker.port.emitQuiet).toHaveBeenCalledWith("other-check", "ERROR", expect.any(Object));
    expect(await WorkersSessionStorage.getWorkerById(other.worker.port._port.name)).toBeUndefined();
    const session = await browser.storage.session.get(null);
    expect(session.pending_account).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain(input.user_private_armored_key);
    expect(JSON.stringify(session)).not.toContain(input.passphrase);
    expect(await WorkersSessionStorage.getWorkers()).toHaveLength(1);
  },
);

it.each([
  "generation",
  "dead-port",
  "replaced-port",
  "foreign-origin",
  "different-resource",
  "changed-tab",
  "sender-frame",
  "sender-url",
  "account-binding",
  "replaced-worker",
  "competing-transition",
])("expires the retained flow when %s changes before worker recovery", async (change) => {
  const { worker, listeners } = await onboardingWorker();
  const input = await enrollment();
  let competing;
  const getServer = jest.spyOn(AuthVerifyServerKeyService.prototype, "getServerKey").mockImplementation(async () => {
    if (change === "dead-port") {
      delete PortManager._ports[worker.port._port.name];
    }
    if (change === "replaced-port") {
      PortManager._ports[worker.port._port.name] = { disconnect: jest.fn() };
    }
    if (change === "sender-frame") {
      worker.port._port.sender.frameId = 2;
    }
    if (change === "sender-url") {
      worker.port._port.sender.url = worker.tab.url.replace("feature=add-account", "feature=elsewhere");
      worker.port._port.sender.tab.url = worker.port._port.sender.url;
    }
    if (change === "replaced-worker") {
      await WorkersSessionStorage.addWorker(
        new WorkerEntity({
          id: worker.port._port.name,
          name: "QuickAccess",
          tabId: 999,
          frameId: 0,
          account_id: null,
          status: "connected",
        }),
      );
    }
    throw new Error("Controlled discovery failure");
  });
  jest.spyOn(browser.tabs, "get").mockImplementation(async () => {
    if (change === "generation") {
      AccountContext.generation++;
    }
    if (change === "account-binding") {
      await SavedAccountRegistry.save(new AccountEntity(adminAccountDto()), true);
    }
    if (change === "competing-transition") {
      competing = AccountContext.transition(async () => {});
    }
    return {
      id: change === "changed-tab" ? 99 : worker.tab.id,
      url:
        change === "foreign-origin"
          ? "https://hostile.example/"
          : change === "different-resource"
            ? worker.tab.url.replace("quickaccess.html", "passbolt-iframe-login.html")
            : worker.tab.url,
    };
  });

  await listeners["passbolt.accounts.add"]("failed-add", input);
  await competing;
  expect(getServer).toHaveBeenCalledTimes(1);
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("failed-add", "ERROR", {
    name: "OnboardingSessionExpiredError",
    message: "This add-account session expired. Close this tab and reopen Add account from the extension.",
  });
  expect(worker.port.accountGeneration).toBe(0);
  if (change === "replaced-worker") {
    expect((await WorkersSessionStorage.getWorkerById(worker.port._port.name)).tabId).toBe(999);
  } else {
    expect(await WorkersSessionStorage.getWorkerById(worker.port._port.name)).toBeUndefined();
  }
  await listeners["passbolt.accounts.check-passphrase"]("rejected-check", {
    user_private_armored_key: input.user_private_armored_key,
    passphrase: input.passphrase,
  });
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("rejected-check", "ERROR", expect.any(Object));
  expect((await browser.storage.session.get("pending_account")).pending_account).toBeUndefined();
});

it("never restores the worker if the failed add could not finish writing its rollback", async () => {
  const { worker, listeners } = await onboardingWorker();
  const input = await enrollment();
  jest
    .spyOn(AuthVerifyServerKeyService.prototype, "getServerKey")
    .mockRejectedValue(new Error("Controlled discovery failure"));
  const originalSet = browser.storage.local.set.bind(browser.storage.local);
  jest.spyOn(browser.storage.local, "set").mockImplementation(async (data) => {
    if (data["saved-accounts-v1"]) {
      throw new Error("Controlled rollback storage failure");
    }
    return originalSet(data);
  });
  const tab = jest.spyOn(browser.tabs, "get").mockResolvedValue({ ...worker.tab });
  await listeners["passbolt.accounts.add"]("incomplete-rollback", input);
  expect(worker.port.emitQuiet).toHaveBeenCalledWith(
    "incomplete-rollback",
    "ERROR",
    expect.objectContaining({ name: "OnboardingSessionExpiredError" }),
  );
  expect(worker.port.accountGeneration).toBe(0);
  expect(await WorkersSessionStorage.getWorkerById(worker.port._port.name)).toBeUndefined();
  expect(tab).not.toHaveBeenCalled();
});

it.each(["disconnect", "navigate", "transition"])(
  "rejects %s during tentative worker registration before refreshing the port",
  async (change) => {
    const { worker, listeners } = await onboardingWorker();
    const input = await enrollment();
    let liveUrl = worker.tab.url;
    let competing;
    jest
      .spyOn(AuthVerifyServerKeyService.prototype, "getServerKey")
      .mockRejectedValue(new Error("Controlled discovery failure"));
    jest.spyOn(browser.tabs, "get").mockImplementation(async () => ({ id: worker.tab.id, url: liveUrl }));
    const originalSet = browser.storage.session.set.bind(browser.storage.session);
    let registrationAttempted = false;
    jest.spyOn(browser.storage.session, "set").mockImplementation(async (data) => {
      await originalSet(data);
      if (AccountContext.generation === 1 && data.workers?.some((record) => record.id === worker.port._port.name)) {
        registrationAttempted = true;
        if (change === "disconnect") {
          delete PortManager._ports[worker.port._port.name];
        } else if (change === "navigate") {
          liveUrl = "https://hostile.example/";
        } else {
          competing = AccountContext.transition(async () => {});
        }
      }
    });

    await listeners["passbolt.accounts.add"]("registration-race", input);
    await competing;
    expect(registrationAttempted).toBe(true);
    expect(worker.port.emitQuiet).toHaveBeenCalledWith(
      "registration-race",
      "ERROR",
      expect.objectContaining({ name: "OnboardingSessionExpiredError" }),
    );
    expect(worker.port.accountGeneration).toBe(0);
    expect(await WorkersSessionStorage.getWorkerById(worker.port._port.name)).toBeUndefined();
  },
);
