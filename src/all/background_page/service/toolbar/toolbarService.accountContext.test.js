import toolbarService from "./toolbarService";
import AccountContext from "../account/accountContext";
import AccountEntity from "../../model/entity/account/accountEntity";
import { defaultAccountDto } from "../../model/entity/account/accountEntity.test.data";
import GetActiveAccountService from "../account/getActiveAccountService";
import GetOrFindActiveSessionService from "../activeSession/getOrFindActiveSessionService";
import FindResourcesService from "../resource/findResourcesService";
import GetOrFindResourceTypesService from "../resourceType/getOrFindResourceTypesService";
import DecryptMetadataService from "../metadata/decryptMetadataService";
import ResourcesCollection from "../../model/entity/resource/resourcesCollection";
import ResourceTypesCollection from "passbolt-styleguide/src/shared/models/entity/resourceType/resourceTypesCollection";
import { resourceTypesCollectionDto } from "passbolt-styleguide/src/shared/models/entity/resourceType/resourceTypesCollection.test.data";
import CanUseOfflineStorageService from "../offline/canUseOfflineStorageService";
import ResourceLocalStorage from "../local_storage/resourceLocalStorage";
import { defaultResourceDtosCollection } from "passbolt-styleguide/src/shared/models/entity/resource/resourcesCollection.test.data";
import { BrowserExtensionIconService } from "../ui/browserExtensionIcon.service";
import OnStartUpService from "../extension/onStartUpService";
import LocalStorageService from "../localStorage/localStorageService";
import User from "../../model/user";

function deferred() {
  let finish;
  const promise = new Promise((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: finish };
}
beforeEach(() => {
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  toolbarService.tabUrl = null;
});
it.each(["updated", "activated", "focused", "login"])(
  "drains the complete %s toolbar metadata operation before selecting B",
  async (entry) => {
    const account = new AccountEntity(defaultAccountDto());
    const resources = new ResourcesCollection(defaultResourceDtosCollection());
    const started = deferred(),
      decrypt = deferred();
    jest.spyOn(GetActiveAccountService, "get").mockResolvedValue(account);
    jest
      .spyOn(GetOrFindActiveSessionService.prototype, "getOrFind")
      .mockResolvedValue({ isAuthenticated: true, isSessionOnline: true });
    jest.spyOn(CanUseOfflineStorageService.prototype, "canUseOfflineStorage").mockResolvedValue(false);
    jest.spyOn(FindResourcesService.prototype, "findAllForLocalStorage").mockResolvedValue(resources);
    jest
      .spyOn(GetOrFindResourceTypesService.prototype, "getOrFindAll")
      .mockImplementation(async () => new ResourceTypesCollection(resourceTypesCollectionDto()));
    jest.spyOn(DecryptMetadataService.prototype, "decryptAllFromForeignModels").mockImplementation(() => {
      started.resolve();
      return decrypt.promise;
    });
    jest.spyOn(browser.tabs, "query").mockResolvedValue([{ url: "https://external.test" }]);
    jest.spyOn(BrowserExtensionIconService, "activate").mockImplementation(() => {});
    const badge = jest.spyOn(BrowserExtensionIconService, "setSuggestedResourcesCount").mockImplementation(() => {});
    const refreshing =
      entry === "updated"
        ? toolbarService.handleSuggestedResourcesOnUpdatedTab(1, { url: "https://external.test" })
        : entry === "activated"
          ? toolbarService.handleSuggestedResourcesOnActivatedTab()
          : entry === "focused"
            ? toolbarService.handleSuggestedResourcesOnFocusedWindow(1)
            : toolbarService.handleUserLoggedIn();
    await started.promise;
    const tracked = AccountContext.running.size;
    const selected = jest.fn(async () => {
      await ResourceLocalStorage.flush();
      await browser.storage.local.set({ resources: [{ id: "B", metadata: { name: "B only" } }] });
    });
    const switching = AccountContext.transition(selected);
    await Promise.resolve();
    const prematurelySelected = selected.mock.calls.length;
    decrypt.resolve();
    await Promise.all([refreshing, switching]);
    expect(tracked).toBeGreaterThan(0);
    expect(prematurelySelected).toBe(0);
    expect(badge).toHaveBeenCalled();
    expect(await ResourceLocalStorage.get()).toEqual([{ id: "B", metadata: { name: "B only" } }]);
  },
);
it("skips toolbar starts during transition", async () => {
  const get = jest.spyOn(GetActiveAccountService, "get");
  await AccountContext.transition(async () => {
    await toolbarService.handleUserLoggedIn();
    await toolbarService.handleSuggestedResourcesOnFocusedWindow(browser.windows.WINDOW_ID_NONE);
  });
  expect(get).not.toHaveBeenCalled();
});
it("startup cannot report completion while its existing cleanup is running", async () => {
  const cleanup = deferred(),
    started = deferred();
  jest.spyOn(LocalStorageService, "flush").mockImplementation(() => {
    started.resolve();
    return cleanup.promise;
  });
  jest.spyOn(User.getInstance(), "isValid").mockReturnValue(false);
  const finished = jest.fn();
  const startup = OnStartUpService.exec().then(finished);
  await started.promise;
  await Promise.resolve();
  const early = finished.mock.calls.length;
  cleanup.resolve();
  await startup;
  expect(early).toBe(0);
});

it("keeps the final browser badge IPC inside the tracked operation", async () => {
  const account = new AccountEntity(defaultAccountDto());
  jest.spyOn(GetActiveAccountService, "get").mockResolvedValue(account);
  jest.spyOn(GetOrFindActiveSessionService.prototype, "getOrFind").mockResolvedValue({ isAuthenticated: true });
  jest
    .spyOn(browser.tabs, "query")
    .mockResolvedValue([{ url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html") }]);
  const started = deferred(),
    painted = deferred();
  jest.spyOn(browser.action, "setIcon").mockImplementation(() => {
    started.resolve();
    return painted.promise;
  });
  const updating = toolbarService.handleSuggestedResourcesOnActivatedTab();
  await started.promise;
  const selected = jest.fn();
  const switching = AccountContext.transition(selected);
  await Promise.resolve();
  expect(selected).not.toHaveBeenCalled();
  painted.resolve();
  await Promise.all([updating, switching]);
  expect(selected).toHaveBeenCalledTimes(1);
});
