import { pgpKeys } from "passbolt-styleguide/test/fixture/pgpKeys/keys";
import { QuickAccessService } from "./quickAccess.service";
import AccountContext from "../account/accountContext";
import PortManager from "../../sdk/port/portManager";
import WorkersSessionStorage from "../sessionStorage/workersSessionStorage";
import SavedAccountRegistry from "../account/savedAccountRegistry";

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  browser.runtime.getURL.mockImplementation((file) => `chrome-extension://test/${file.replace(/^\/+/, "")}`);
});

it.each([
  ["App", "https://vault.example/passbolt/app/passwords/view/resource"],
  ["Auth", "https://vault.example/passbolt/auth/login?redirect=app"],
])("allows a bound %s caller after a same-backend route change", async (name, liveUrl) => {
  const worker = {
    name,
    tab: { id: 10, url: "https://vault.example/passbolt/app/passwords" },
    port: { accountGeneration: 0, _port: { name: "source" } },
  };
  PortManager._ports = { source: worker.port };
  jest.spyOn(SavedAccountRegistry, "active").mockResolvedValue({ domain: "https://vault.example/passbolt" });
  jest.spyOn(browser.tabs, "get").mockResolvedValue({ id: 10, url: liveUrl, windowId: 5 });
  jest.spyOn(browser.tabs, "create").mockResolvedValue({ id: 41 });
  const update = jest.spyOn(browser.tabs, "update").mockResolvedValue();
  await expect(
    QuickAccessService.openAddAccountTab({ domain: "https://vault.example/passbolt" }, worker),
  ).resolves.toEqual({ tab_id: 41 });
  expect(update).toHaveBeenCalledWith(41, expect.objectContaining({ active: true }));
});

it.each(["https://other.example/passbolt/app/passwords", "https://vault.example/passbolt-other/app/passwords"])(
  "denies a vault source outside its bound backend: %s",
  async (liveUrl) => {
    const worker = {
      name: "App",
      tab: { id: 10, url: "https://vault.example/passbolt/app/passwords" },
      port: { accountGeneration: 0, _port: { name: "source" } },
    };
    PortManager._ports = { source: worker.port };
    jest.spyOn(SavedAccountRegistry, "active").mockResolvedValue({ domain: "https://vault.example/passbolt" });
    jest.spyOn(browser.tabs, "get").mockResolvedValue({ id: 10, url: liveUrl, windowId: 5 });
    const create = jest.spyOn(browser.tabs, "create");
    await expect(QuickAccessService.openAddAccountTab({}, worker)).rejects.toThrow("page changed");
    expect(create).not.toHaveBeenCalled();
  },
);

it("does not launch from a prompt whose HTTPS source navigated during live tab lookup", async () => {
  const worker = {
    name: "AccountOnboarding",
    tab: { id: 10, url: "https://vault.example/app/passwords" },
    port: { accountGeneration: 0, _port: { name: "prompt" } },
  };
  PortManager._ports = { prompt: worker.port };
  jest
    .spyOn(browser.tabs, "get")
    .mockResolvedValue({ id: 10, url: "https://other.example/app/passwords", windowId: 5 });
  const create = jest.spyOn(browser.tabs, "create");
  await expect(QuickAccessService.openAddAccountTab({ domain: "https://vault.example" }, worker)).rejects.toThrow(
    "page changed",
  );
  expect(create).not.toHaveBeenCalled();
});

it("cleans only its blank reservation when the generation changes during tab creation", async () => {
  const worker = { name: "QuickAccess", port: { accountGeneration: 0, _port: { name: "quickaccess" } } };
  PortManager._ports = { quickaccess: worker.port };
  jest.spyOn(browser.tabs, "query").mockResolvedValue([{ id: 10, windowId: 5, url: "https://vault.example" }]);
  jest.spyOn(browser.tabs, "create").mockImplementation(async () => {
    AccountContext.generation++;
    return { id: 41 };
  });
  jest.spyOn(browser.tabs, "get").mockResolvedValue({ id: 41, url: "about:blank" });
  const remove = jest.spyOn(browser.tabs, "remove").mockResolvedValue();
  const update = jest.spyOn(browser.tabs, "update");
  await expect(QuickAccessService.openAddAccountTab({ domain: "https://vault.example" }, worker)).rejects.toThrow(
    "selected account changed",
  );
  expect(remove).toHaveBeenCalledWith(41);
  expect(update).not.toHaveBeenCalled();
  expect(await WorkersSessionStorage.getWorkersByTabId(41)).toEqual([]);
});

it("finishes opening the wizard when activating its reservation naturally disconnects the toolbar popup", async () => {
  const worker = { name: "QuickAccess", port: { accountGeneration: 0, _port: { name: "quickaccess" } } };
  PortManager._ports = { quickaccess: worker.port };
  jest.spyOn(browser.tabs, "query").mockResolvedValue([{ id: 10, windowId: 5, url: "https://vault.example" }]);
  jest.spyOn(browser.tabs, "create").mockImplementation(async () => {
    delete PortManager._ports.quickaccess;
    return { id: 41 };
  });
  const update = jest.spyOn(browser.tabs, "update").mockResolvedValue();
  jest.spyOn(browser.tabs, "get").mockResolvedValue({ id: 41, url: "about:blank" });
  const remove = jest.spyOn(browser.tabs, "remove").mockResolvedValue();
  await expect(QuickAccessService.openAddAccountTab({ domain: "https://vault.example" }, worker)).resolves.toEqual({
    tab_id: 41,
  });
  const url = update.mock.calls[0][1].url;
  const id = new URL(url).searchParams.get("passbolt");
  expect(await WorkersSessionStorage.getWorkerById(id)).toMatchObject({ tabId: 41, frameId: 0, account_id: null });
  expect(remove).not.toHaveBeenCalled();
});

it("rejects a popup disconnected before it authorizes any reservation", async () => {
  const worker = { name: "QuickAccess", port: { accountGeneration: 0, _port: { name: "quickaccess" } } };
  PortManager._ports = { quickaccess: worker.port };
  jest.spyOn(browser.tabs, "query").mockImplementation(async () => {
    delete PortManager._ports.quickaccess;
    return [{ id: 10, url: "https://vault.example" }];
  });
  const create = jest.spyOn(browser.tabs, "create");
  await expect(QuickAccessService.openAddAccountTab({ domain: "https://vault.example" }, worker)).rejects.toThrow(
    "window was closed",
  );
  expect(create).not.toHaveBeenCalled();
});

it.each([
  ["https://vault.example/", "https://vault.example"],
  ["https://vault.example/passbolt/", "https://vault.example/passbolt"],
  ["https://vault.example/passbolt/auth/login?next=1", "https://vault.example/passbolt"],
])("captures %s before reserving a uniquely bound full tab", async (source, domain) => {
  const worker = { name: "QuickAccess", port: { accountGeneration: 0, _port: { name: "quickaccess" } } };
  PortManager._ports = { quickaccess: worker.port };
  const query = jest.spyOn(browser.tabs, "query").mockResolvedValue([{ id: 10, windowId: 5, url: source }]);
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      header: { status: "success", code: 200 },
      body: { keydata: pgpKeys.server.public, fingerprint: pgpKeys.server.fingerprint },
    }),
  });
  const create = jest.spyOn(browser.tabs, "create").mockImplementation(async (input) => {
    expect(query).toHaveBeenCalled();
    expect(input).toEqual({ url: "about:blank", active: false, windowId: 5 });
    query.mockResolvedValue([{ id: 41, url: browser.runtime.getURL("webAccessibleResources/quickaccess.html") }]);
    return { id: 41 };
  });
  jest.spyOn(browser.tabs, "update").mockImplementation(async (tabId, { url }) => {
    const parameters = new URL(url).searchParams;
    const id = parameters.get("passbolt");
    const record = await WorkersSessionStorage.getWorkerById(id);
    expect(record).toMatchObject({ name: "QuickAccess", account_id: null, tabId: 41, frameId: 0 });
    expect(parameters.get("domain")).toBe(domain);
    expect(parameters.get("feature")).toBe("add-account");
    expect(parameters.get("uiMode")).toBe("tab");
    expect(await PortManager.isOnboardingSender("QuickAccess", { url, frameId: 0, tab: { id: tabId, url } }, id)).toBe(
      true,
    );
  });

  await expect(QuickAccessService.openAddAccountTab({}, worker)).resolves.toEqual({ tab_id: 41 });
  expect(create).toHaveBeenCalledTimes(1);
  expect((await browser.storage.local.get("saved-servers-v1"))["saved-servers-v1"]).toBeUndefined();
});
