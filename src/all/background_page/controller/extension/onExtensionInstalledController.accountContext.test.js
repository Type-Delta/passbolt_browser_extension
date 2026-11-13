const OnExtensionInstalledController = require("./onExtensionInstalledController").default;
const AccountEntity = require("../../model/entity/account/accountEntity").default;
const { defaultAccountDto, adminAccountDto } = require("../../model/entity/account/accountEntity.test.data");
const AccountModel = require("../../model/account/accountModel").default;
const AccountContext = require("../../service/account/accountContext").default;
const GetActiveAccountService = require("../../service/account/getActiveAccountService").default;
const GetOrFindActiveSessionService = require("../../service/activeSession/getOrFindActiveSessionService").default;
const PostLogoutService = require("../../service/auth/postLogoutService").default;
const User = require("../../model/user").default;
const { enableFetchMocks } = require("jest-fetch-mock");

beforeEach(() => {
  jest.restoreAllMocks();
  enableFetchMocks();
  fetch.resetMocks();
  fetch.mockResponse("");
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  jest.spyOn(PostLogoutService, "exec").mockResolvedValue();
  jest.spyOn(browser.tabs, "query").mockResolvedValue([]);
});

test("configured browser update still logs out the captured account", async () => {
  const account = new AccountEntity(defaultAccountDto({ domain: "https://a.example.test" }));
  await new AccountModel().activate(account);
  jest.spyOn(GetActiveAccountService, "get").mockResolvedValue(account);
  jest.spyOn(GetOrFindActiveSessionService.prototype, "getOrFind").mockResolvedValue({ isAuthenticated: true });
  await OnExtensionInstalledController.onBrowserUpdate();
  expect(fetch.mock.calls.map(([url, options]) => ({ origin: new URL(url).origin, method: options.method }))).toEqual([
    { origin: account.domain, method: "POST" },
  ]);
});

test("browser update must not log out newly selected B after checking A", async () => {
  const a = new AccountEntity(defaultAccountDto({ domain: "https://a.example.test" }));
  const b = new AccountEntity(adminAccountDto({ domain: "https://b.example.test" }));
  await new AccountModel().activate(a);
  jest.spyOn(GetActiveAccountService, "get").mockResolvedValue(a);
  jest.spyOn(GetOrFindActiveSessionService.prototype, "getOrFind").mockImplementation(async () => {
    await AccountContext.transition(() => new AccountModel().activate(b));
    return { isAuthenticated: true };
  });
  let failure;
  try {
    await OnExtensionInstalledController.onBrowserUpdate();
  } catch (error) {
    failure = error;
  }
  expect(User.getInstance().settings.getDomain()).toBe(b.domain);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([]);
  expect(failure?.message).toBe("The selected account changed. Reopen the vault.");
});
