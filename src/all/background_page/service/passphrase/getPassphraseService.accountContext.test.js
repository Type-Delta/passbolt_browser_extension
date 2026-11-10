import GetPassphraseService from "./getPassphraseService";
import Port from "../../sdk/port";
import AccountContext from "../account/accountContext";
import AccountEntity from "../../model/entity/account/accountEntity";
import { defaultAccountDto } from "../../model/entity/account/accountEntity.test.data";
import { QuickAccessService } from "../ui/quickAccess.service";
import WorkerService from "../worker/workerService";
import PassphraseStorageService from "../session_storage/passphraseStorageService";

function rawPort() {
  const disconnects = new Set();
  const port = new Port({
    onMessage: { addListener: jest.fn() },
    onDisconnect: { addListener: (fn) => disconnects.add(fn), removeListener: (fn) => disconnects.delete(fn) },
    postMessage: jest.fn(),
  });
  return { port, disconnects };
}
beforeEach(() => {
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  AccountContext.interactiveRequests.clear();
});
it("cancels the real manual waiter and cleans every listener before a late reply", async () => {
  const { port, disconnects } = rawPort();
  const originalDisconnects = disconnects.size;
  const service = new GetPassphraseService(new AccountEntity(defaultAccountDto()));
  const continued = jest.fn();
  const operation = AccountContext.run(0, async () => {
    await service.listenForPassphraseInQuickaccess(port, "dialog");
    continued();
  });
  const outcome = operation.catch((error) => error);
  await Promise.resolve();
  const registered = AccountContext.interactiveRequests.size;
  const switching = AccountContext.transition(jest.fn());
  await Promise.resolve();
  await Promise.resolve();
  const listenerRemoved = !port._listeners.dialog;
  // Release the broken implementation too, so a failing regression leaves no running operation.
  port._onMessage(JSON.stringify(["dialog", "SUCCESS", { passphrase: "late", rememberMe: -1 }]));
  await switching;
  expect(await outcome).toBeInstanceOf(Error);
  expect(registered).toBe(1);
  expect(listenerRemoved).toBe(true);
  expect(continued).not.toHaveBeenCalled();
  expect(disconnects.size).toBe(originalDisconnects);
  expect(AccountContext.interactiveRequests.size).toBe(0);
});
it("captures generation before opening/discovering the popup and never validates or stores late credentials", async () => {
  const service = new GetPassphraseService(new AccountEntity(defaultAccountDto()));
  const { port } = rawPort();
  jest.spyOn(PassphraseStorageService, "get").mockResolvedValue(null);
  jest.spyOn(QuickAccessService, "isAttachedModeAvailable").mockReturnValue(false);
  let opened;
  jest.spyOn(QuickAccessService, "openInDetachedMode").mockImplementation(
    () =>
      new Promise((resolve) => {
        opened = resolve;
      }),
  );
  jest.spyOn(WorkerService, "waitExists").mockResolvedValue();
  const get = jest.spyOn(WorkerService, "get").mockResolvedValue({ port });
  const validate = jest.spyOn(service, "validatePassphrase").mockResolvedValue();
  const remember = jest.spyOn(service, "rememberPassphrase").mockResolvedValue();
  const request = service.requestPassphraseFromQuickAccess().catch((error) => error);
  while (!opened) {
    await Promise.resolve();
  }
  await AccountContext.transition(async () => {});
  opened({ tabs: [{ id: 42 }] });
  // If unfixed, settle the waiter so this test fails without hanging.
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
  }
  const id = Object.keys(port._listeners)[0];
  if (id) {
    port._onMessage(JSON.stringify([id, "SUCCESS", { passphrase: "late", rememberMe: -1 }]));
  }
  expect(await request).toBeInstanceOf(Error);
  expect(get).not.toHaveBeenCalled();
  expect(validate).not.toHaveBeenCalled();
  expect(remember).not.toHaveBeenCalled();
});
it.each(["SUCCESS", "ERROR", "disconnect"])("single settlement cleans a manual waiter on %s", async (status) => {
  const { port, disconnects } = rawPort();
  const originalDisconnects = disconnects.size;
  const service = new GetPassphraseService(new AccountEntity(defaultAccountDto()));
  const outcome = service.listenForPassphraseInQuickaccess(port, "dialog").catch((error) => error);
  if (status === "disconnect") {
    for (const fn of [...disconnects]) {
      fn();
    }
  } else {
    port._onMessage(JSON.stringify(["dialog", status, { passphrase: "fixture" }]));
  }
  await outcome;
  expect(port._listeners.dialog).toBeUndefined();
  expect(disconnects.size).toBe(originalDisconnects);
  expect(AccountContext.interactiveRequests.size).toBe(0);
});
