import { v4 as uuidv4 } from "uuid";
import { pgpKeys } from "passbolt-styleguide/test/fixture/pgpKeys/keys";
import { SavedAccountsEvents } from "./savedAccountsEvents";
import SavedAccountsService from "../service/account/savedAccountsService";
import SavedAccountRegistry from "../service/account/savedAccountRegistry";
import WorkersSessionStorage from "../service/sessionStorage/workersSessionStorage";
import WorkerEntity from "../model/entity/worker/workerEntity";
import PortManager from "../sdk/port/portManager";
import AccountContext from "../service/account/accountContext";

beforeEach(() => {
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  PortManager._ports = {};
  browser.runtime.getURL.mockImplementation((path) => `chrome-extension://test/${path.replace(/^\/+/, "")}`);
});

it.each(["verify-server", "validate-private-key", "check-passphrase"])(
  "reports an expired setup tab before running a stale %s request",
  async (action) => {
    const { worker, listeners } = await onboardingWorker();
    AccountContext.generation++;
    const request = jest.spyOn(global, "fetch");
    await listeners[`passbolt.accounts.${action}`]("expired", {});
    expect(worker.port.emitQuiet).toHaveBeenCalledWith(
      "expired",
      "ERROR",
      expect.objectContaining({ name: "OnboardingSessionExpiredError" }),
    );
    expect(request).not.toHaveBeenCalled();
  },
);

async function onboardingWorker() {
  await SavedAccountRegistry.read();
  const id = uuidv4();
  const url = browser.runtime.getURL(
    `webAccessibleResources/quickaccess.html?passbolt=${id}&uiMode=tab&feature=add-account`,
  );
  const listeners = {};
  const worker = {
    name: "QuickAccess",
    tab: { id: 31, url },
    port: {
      accountGeneration: 0,
      _port: { name: id, sender: { url, frameId: 0, tab: { id: 31, url } } },
      on: (name, callback) => {
        listeners[name] = callback;
      },
      emitQuiet: jest.fn().mockResolvedValue(),
    },
  };
  await WorkersSessionStorage.addWorker(
    new WorkerEntity({ id, name: "QuickAccess", tabId: 31, frameId: 0, account_id: null, status: "connected" }),
  );
  PortManager._ports[id] = worker.port;
  SavedAccountsEvents.listen(worker);
  return { worker, listeners };
}

function serverResponse() {
  return {
    ok: true,
    json: async () => ({
      header: { status: "success", code: 200 },
      body: { keydata: pgpKeys.server.public, fingerprint: pgpKeys.server.fingerprint },
    }),
  };
}

it("verifies and remembers a server through the bound onboarding RPC without reconciling MFA", async () => {
  const { worker, listeners } = await onboardingWorker();
  const reconcile = jest.spyOn(SavedAccountsService, "reconcilePending");
  jest.spyOn(global, "fetch").mockResolvedValue(serverResponse());
  await listeners["passbolt.accounts.verify-server"]("verify", {
    domain: "https://vault.example/team/",
    remember: true,
  });
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("verify", "SUCCESS", {
    domain: "https://vault.example/team",
    server_key_fingerprint: pgpKeys.server.fingerprint.toUpperCase(),
    checked_at: expect.any(Number),
    is_known: false,
  });
  expect(reconcile).not.toHaveBeenCalled();
  expect((await browser.storage.local.get("saved-servers-v1"))["saved-servers-v1"].servers).toHaveLength(1);
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});

it.each(["generation", "disconnect"])("discards a server reply after %s without remembering it", async (change) => {
  const { worker, listeners } = await onboardingWorker();
  let respond;
  let started;
  const fetching = new Promise((resolve) => {
    started = resolve;
  });
  jest.spyOn(global, "fetch").mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      respond = resolve;
    });
  });
  const request = listeners["passbolt.accounts.verify-server"]("stale", {
    domain: "https://vault.example",
    remember: true,
  });
  await fetching;
  if (change === "generation") {
    AccountContext.generation++;
  } else {
    delete PortManager._ports[worker.port._port.name];
  }
  respond(serverResponse());
  await request;
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("stale", "ERROR", expect.any(Object));
  expect((await browser.storage.local.get("saved-servers-v1"))["saved-servers-v1"]).toBeUndefined();
});

it.each(["frame", "tab", "mode", "resource", "unregistered"])(
  "denies onboarding utilities with a mismatched %s",
  async (change) => {
    const { worker, listeners } = await onboardingWorker();
    const sender = worker.port._port.sender;
    if (change === "frame") {
      sender.frameId = 2;
    }
    if (change === "tab") {
      sender.tab.id = 999;
    }
    if (change === "mode") {
      sender.url = sender.url.replace("uiMode=tab", "uiMode=detached");
      sender.tab.url = sender.url;
    }
    if (change === "resource") {
      sender.url = sender.url.replace("quickaccess.html", "passbolt-iframe-login.html");
      sender.tab.url = sender.url;
    }
    if (change === "unregistered") {
      await WorkersSessionStorage.deleteById(worker.port._port.name);
    }
    const fetch = jest.spyOn(global, "fetch");
    await listeners["passbolt.accounts.verify-server"]("denied", { domain: "https://vault.example", remember: true });
    expect(worker.port.emitQuiet).toHaveBeenCalledWith("denied", "ERROR", expect.any(Object));
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("keeps a passively discovered server out of persistent server records", async () => {
  const { worker, listeners } = await onboardingWorker();
  jest.spyOn(global, "fetch").mockResolvedValue(serverResponse());
  await listeners["passbolt.accounts.verify-server"]("passive", { domain: "https://vault.example", remember: false });
  expect(worker.port.emitQuiet).toHaveBeenCalledWith(
    "passive",
    "SUCCESS",
    expect.objectContaining({ domain: "https://vault.example" }),
  );
  expect((await browser.storage.local.get("saved-servers-v1"))["saved-servers-v1"]).toBeUndefined();
});

it("completes the launch RPC even when the originating popup closes during tab creation", async () => {
  const { worker, listeners } = await onboardingWorker();
  jest.spyOn(browser.tabs, "query").mockResolvedValue([{ id: 10, url: "https://vault.example", windowId: 5 }]);
  jest.spyOn(browser.tabs, "create").mockImplementation(async () => {
    delete PortManager._ports[worker.port._port.name];
    return { id: 51 };
  });
  jest.spyOn(browser.tabs, "update").mockResolvedValue();
  jest.spyOn(browser.tabs, "get").mockResolvedValue({ id: 51, url: "about:blank" });
  jest.spyOn(browser.tabs, "remove").mockResolvedValue();
  await listeners["passbolt.accounts.open-add-tab"]("launch", { domain: "https://vault.example" });
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("launch", "SUCCESS", { tab_id: 51 });
});

it("dispatches both local key RPCs without borrowing a foreground account or retaining material", async () => {
  const { worker, listeners } = await onboardingWorker();
  const before = await browser.storage.session.get(null);
  const request = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected network request"));
  await listeners["passbolt.accounts.validate-private-key"]("key", {
    username: "ada@passbolt.com",
    user_private_armored_key: pgpKeys.ada.private,
  });
  expect(worker.port.emitQuiet).toHaveBeenCalledWith(
    "key",
    "SUCCESS",
    expect.objectContaining({ fingerprint: pgpKeys.ada.fingerprint.toUpperCase(), matches_email: true }),
  );
  await listeners["passbolt.accounts.check-passphrase"]("unlock", {
    user_private_armored_key: pgpKeys.ada.private,
    passphrase: "ada@passbolt.com",
  });
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("unlock", "SUCCESS", undefined);
  expect(await browser.storage.session.get(null)).toEqual(before);
  expect(request).not.toHaveBeenCalled();
});

it("keeps an ordinary wrong-passphrase error retryable for a live onboarding tab", async () => {
  const { worker, listeners } = await onboardingWorker();
  await listeners["passbolt.accounts.check-passphrase"]("wrong", {
    user_private_armored_key: pgpKeys.ada.private,
    passphrase: "wrong-passphrase",
  });
  expect(worker.port.emitQuiet).toHaveBeenCalledWith(
    "wrong",
    "ERROR",
    expect.objectContaining({ name: "InvalidMasterPasswordError" }),
  );
});

it("keeps a busy but unchanged onboarding binding retryable", async () => {
  const { worker, listeners } = await onboardingWorker();
  const input = { user_private_armored_key: pgpKeys.ada.private, passphrase: "ada@passbolt.com" };
  AccountContext.transitioning = true;
  await listeners["passbolt.accounts.check-passphrase"]("busy", input);
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("busy", "ERROR", expect.objectContaining({ name: "Error" }));
  AccountContext.transitioning = false;
  await listeners["passbolt.accounts.check-passphrase"]("retry", input);
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("retry", "SUCCESS", undefined);
});

it("enforces the chosen-token requirement on final add from an actual onboarding sender", async () => {
  const { worker, listeners } = await onboardingWorker();
  const request = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected network request"));
  await listeners["passbolt.accounts.add"]("add", {
    domain: "https://vault.example",
    username: "ada@passbolt.com",
    user_private_armored_key: pgpKeys.ada.private,
    passphrase: "ada@passbolt.com",
  });
  expect(worker.port.emitQuiet).toHaveBeenCalledWith("add", "ERROR", expect.any(Object));
  expect(request).not.toHaveBeenCalled();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});
