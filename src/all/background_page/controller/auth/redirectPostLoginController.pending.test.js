import RedirectPostLoginController from "./redirectPostLoginController";
import SavedAccountsService from "../../service/account/savedAccountsService";
import SavedAccountRegistry from "../../service/account/savedAccountRegistry";
import AccountContext from "../../service/account/accountContext";
import AccountEntity from "../../model/entity/account/accountEntity";
import { defaultAccountDto, adminAccountDto } from "../../model/entity/account/accountEntity.test.data";
import WorkersSessionStorage from "../../service/sessionStorage/workersSessionStorage";
import WorkerEntity from "../../model/entity/worker/workerEntity";
import { readWorker } from "../../model/entity/worker/workerEntity.test.data";
import Port from "../../sdk/port";

let account;
beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  account = await SavedAccountRegistry.save(
    new AccountEntity(defaultAccountDto({ domain: "https://vault.test/team" })),
    true,
  );
  jest.spyOn(browser.tabs, "update").mockResolvedValue({ id: 42 });
});
afterEach(async () => {
  for (const alarm of await browser.alarms.getAll()) {
    await browser.alarms.clear(alarm.name);
  }
});
async function request({
  frameId = 3,
  framePage = "/webAccessibleResources/passbolt-iframe-login.html",
  top = account.domain,
  pendingAccount = account,
  saved = true,
} = {}) {
  const tab = { id: 42, url: `${top}/auth/login?redirect=/app/administration` };
  const dto = readWorker({ name: "Auth", tabId: 42, frameId: 3, account_id: account.id });
  await WorkersSessionStorage.addWorker(new WorkerEntity(dto));
  await SavedAccountsService.savePending(pendingAccount, "pending", saved);
  const replies = [];
  const port = new Port({
    name: dto.id,
    sender: { url: browser.runtime.getURL(framePage), tab, frameId },
    onMessage: { addListener: jest.fn() },
    onDisconnect: { addListener: jest.fn() },
    postMessage: (message) => replies.push(JSON.parse(message)),
    disconnect: jest.fn(),
  });
  port.on("passbolt.auth.post-login-redirect", (id) =>
    new RedirectPostLoginController({ name: "Auth", tab, port }, id, account)._exec(),
  );
  port._onMessage(JSON.stringify(["passbolt.auth.post-login-redirect", "redirect"]));
  await Promise.allSettled([...AccountContext.running]);
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  return replies;
}
it.each(["frame", "top", "page", "identity", "enrollment"])(
  "does not grant a pending redirect exception for %s",
  async (scenario) => {
    const options =
      scenario === "frame"
        ? { frameId: 4 }
        : scenario === "top"
          ? { top: "https://evil.test" }
          : scenario === "page"
            ? { framePage: "/webAccessibleResources/quickaccess.html" }
            : scenario === "identity"
              ? { pendingAccount: new AccountEntity(adminAccountDto({ domain: account.domain })) }
              : { saved: false };
    const replies = await request(options);
    expect(replies).toContainEqual([
      "redirect",
      "ERROR",
      expect.objectContaining({ message: "Complete or cancel the pending account sign-in first." }),
    ]);
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect((await SavedAccountsService.pending()).tab_id).toBeNull();
  },
);
it("an unrelated-backend pending attempt keeps the ordinary selected-account redirect without binding MFA", async () => {
  const pendingAccount = new AccountEntity(defaultAccountDto({ domain: "https://other.test" }));
  expect(await request({ pendingAccount })).toContainEqual(["redirect", "SUCCESS"]);
  expect(browser.tabs.update).toHaveBeenCalledWith(42, { url: `${account.domain}/app/administration` });
  expect((await SavedAccountsService.pending()).tab_id).toBeNull();
});
