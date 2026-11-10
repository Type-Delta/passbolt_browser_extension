import Port from "./port";
import AccountContext from "../service/account/accountContext";
import SavedAccountRegistry from "../service/account/savedAccountRegistry";
import AccountEntity from "../model/entity/account/accountEntity";
import { defaultAccountDto } from "../model/entity/account/accountEntity.test.data";

beforeEach(() => {
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
});
function makePort() {
  return new Port({
    onMessage: { addListener: jest.fn() },
    onDisconnect: { addListener: jest.fn() },
    postMessage: jest.fn(),
    disconnect: jest.fn(),
  });
}
it("rejects a real passphrase request, drains its handler, and never resumes it on a late answer", async () => {
  const port = makePort();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const mutation = jest.fn();
  port.on("passbolt.secret.find", async () => {
    const request = port.request("passbolt.passphrase.request");
    started();
    await request;
    mutation();
  });
  port._onMessage(JSON.stringify(["passbolt.secret.find", "secret-request"]));
  const [handler] = AccountContext.running;
  const outcome = handler.catch((error) => error);
  await ready;
  const requestId = Object.keys(port._disconnectListeners)[0];
  const callback = jest.fn();
  const transition = AccountContext.transition(callback);
  await Promise.resolve();
  await Promise.resolve();
  expect(Object.keys(port._disconnectListeners)).toEqual([]);
  await transition;
  expect(await outcome).toBeInstanceOf(Error);
  port._onMessage(JSON.stringify([requestId, "SUCCESS", "late answer"]));
  expect(mutation).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledTimes(1);
});
it("continues draining noninteractive mutations and rejects new prompts until they finish", async () => {
  const port = makePort();
  let finish;
  const response = new Promise((resolve) => {
    finish = resolve;
  });
  const handler = AccountContext.run(0, () => response);
  const callback = jest.fn();
  const transition = AccountContext.transition(callback);
  await expect(port.request("passbolt.passphrase.request")).rejects.toThrow();
  expect(callback).not.toHaveBeenCalled();
  finish();
  await handler;
  await transition;
  expect(callback).toHaveBeenCalledTimes(1);
});
it.each([true, false])(
  "pending MFA allows account bootstrap and blocks protected handlers only on its backend: same=%s",
  async (same) => {
    const account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
    await browser.storage.session.set({
      pending_account: {
        account: { domain: same ? account.domain : "https://other.test" },
        expires: Date.now() + 60000,
      },
    });
    const port = makePort();
    const bootstrap = jest.fn();
    const protectedHandler = jest.fn();
    port.on("passbolt.account.get", bootstrap);
    port.on("passbolt.secret.find", protectedHandler);
    port._onMessage(JSON.stringify(["passbolt.account.get", "bootstrap"]));
    port._onMessage(JSON.stringify(["passbolt.secret.find", "protected"]));
    await Promise.allSettled([...AccountContext.running]);
    expect(bootstrap).toHaveBeenCalled();
    expect(protectedHandler).toHaveBeenCalledTimes(same ? 0 : 1);
  },
);

it("settles an ordinary request on a retained stale initiating port and disconnects it for recovery", async () => {
  const port = makePort();
  port._port.disconnect = jest.fn();
  const handler = jest.fn();
  port.on("passbolt.account.get", handler);
  await AccountContext.transition(async () => {});
  port._onMessage(JSON.stringify(["passbolt.account.get", "stale-request"]));
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  expect(handler).not.toHaveBeenCalled();
  expect(port._port.postMessage).toHaveBeenCalledWith(
    JSON.stringify([
      "stale-request",
      "ERROR",
      { name: "Error", message: "The selected account changed. Reopen the vault." },
    ]),
  );
  expect(port._port.disconnect).toHaveBeenCalled();
  const fresh = makePort();
  fresh.on("passbolt.account.get", () => fresh.emit("fresh-request", "SUCCESS", "fresh account"));
  fresh._onMessage(JSON.stringify(["passbolt.account.get", "fresh-request"]));
  await Promise.allSettled([...AccountContext.running]);
  expect(fresh._port.postMessage).toHaveBeenCalledWith(JSON.stringify(["fresh-request", "SUCCESS", "fresh account"]));
});

it("a real UI port gets a useful stale error after failed switch and reconnects for its next request", async () => {
  const { default: UiPort } = await import("../../webAccessibleResources/js/lib/port");
  const { default: SavedAccountsService } = await import("../service/account/savedAccountsService");
  const account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  let server;
  const connections = jest.spyOn(browser.runtime, "connect").mockImplementation(() => {
    const serverMessages = new Set(),
      clientMessages = new Set(),
      serverDisconnects = new Set(),
      clientDisconnects = new Set();
    let disconnected = false;
    const event = (callbacks) => ({
      addListener: (fn) => callbacks.add(fn),
      removeListener: (fn) => callbacks.delete(fn),
    });
    const disconnect = () => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      for (const fn of [...serverDisconnects, ...clientDisconnects]) {
        fn();
      }
    };
    const client = {
      onMessage: event(clientMessages),
      onDisconnect: event(clientDisconnects),
      disconnect,
      postMessage: (msg) => {
        for (const fn of [...serverMessages]) {
          fn(msg);
        }
      },
    };
    server = new Port({
      onMessage: event(serverMessages),
      onDisconnect: event(serverDisconnects),
      disconnect,
      postMessage: (msg) => {
        for (const fn of [...clientMessages]) {
          fn(msg);
        }
      },
    });
    const bound = server;
    bound.on("passbolt.account.get", async (request) => {
      bound.emit(request, "SUCCESS", { id: (await SavedAccountRegistry.active()).id });
    });
    queueMicrotask(() => bound.emit("passbolt.port.ready"));
    return client;
  });
  const ui = new UiPort("quickaccess");
  await ui.connect();
  await expect(SavedAccountsService.switch("missing", server)).rejects.toThrow("does not exist");
  await expect(ui.request("passbolt.account.get")).rejects.toEqual({
    name: "Error",
    message: "The selected account changed. Reopen the vault.",
  });
  expect(ui._connected).toBe(false);
  await expect(ui.request("passbolt.account.get")).resolves.toEqual({ id: account.id });
  expect(connections).toHaveBeenCalledTimes(2);
  ui._port.disconnect();
});

it.each([false, true])(
  "permits native saved-MFA status/navigation only for the same selected account: same=%s",
  async (same) => {
    const { default: SavedAccountsService } = await import("../service/account/savedAccountsService");
    const { adminAccountDto } = await import("../model/entity/account/accountEntity.test.data");
    const account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
    const pendingAccount = same ? account : new AccountEntity(adminAccountDto({ domain: account.domain }));
    await SavedAccountsService.savePending(pendingAccount, "pending", true);
    const port = makePort();
    const status = jest.fn(),
      navigation = jest.fn();
    port.on("passbolt.auth.is-mfa-required", status);
    port.on("passbolt.tabs.open-trusted-domain", navigation);
    port._onMessage(JSON.stringify(["passbolt.auth.is-mfa-required", "mfa"]));
    port._onMessage(JSON.stringify(["passbolt.tabs.open-trusted-domain", "native"]));
    await Promise.allSettled([...AccountContext.running]);
    expect(status).toHaveBeenCalledTimes(same ? 1 : 0);
    expect(navigation).toHaveBeenCalledTimes(same ? 1 : 0);
    await SavedAccountsService.cancelPending();
  },
);
