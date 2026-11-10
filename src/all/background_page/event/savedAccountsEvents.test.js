import { SavedAccountsEvents } from "./savedAccountsEvents";
import SavedAccountsService from "../service/account/savedAccountsService";

beforeEach(() => {
  jest.restoreAllMocks();
});
it("does not dispatch account mutations from hostile framed Quick Access", async () => {
  const listeners = {};
  const port = {
    _port: {
      sender: {
        url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html?passbolt=quickaccess"),
        tab: { id: 42, url: "https://hostile.test" },
        frameId: 4,
      },
    },
    on: (name, listener) => {
      listeners[name] = listener;
    },
    emitQuiet: jest.fn().mockResolvedValue(),
  };
  const mutation = jest.spyOn(SavedAccountsService, "switch").mockResolvedValue({});
  SavedAccountsEvents.listen({ port, name: "QuickAccess" });
  await listeners["passbolt.accounts.switch"]("request", { account_id: "chosen" });
  expect(mutation).not.toHaveBeenCalled();
  expect(port.emitQuiet).toHaveBeenCalledWith("request", "ERROR", expect.any(Object));
});
it("exposes noargs cancel-pending to a real popup and returns its list result", async () => {
  const listeners = {};
  const port = {
    _port: { sender: { url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html") } },
    on: (name, listener) => {
      listeners[name] = listener;
    },
    emitQuiet: jest.fn().mockResolvedValue(),
  };
  const summary = { active_account_id: null, accounts: [], servers: [], pending: null };
  const cancel = jest.spyOn(SavedAccountsService, "cancelPendingSignIn").mockResolvedValue(summary);
  jest.spyOn(SavedAccountsService, "publishChanged").mockResolvedValue();
  SavedAccountsEvents.listen({ port, name: "QuickAccess" });
  await listeners["passbolt.accounts.cancel-pending"]("request");
  expect(cancel).toHaveBeenCalledWith(port);
  expect(port.emitQuiet).toHaveBeenCalledWith("request", "SUCCESS", summary);
});
