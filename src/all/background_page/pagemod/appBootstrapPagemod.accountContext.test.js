import AppBootstrap from "./appBootstrapPagemod";
import PagemodManager from "./pagemodManager";
import AccountContext from "../service/account/accountContext";
import GetActiveAccountService from "../service/account/getActiveAccountService";
import ParseAppUrlService from "../service/app/parseAppUrlService";
import AccountEntity from "../model/entity/account/accountEntity";
import { defaultAccountDto } from "../model/entity/account/accountEntity.test.data";

beforeEach(() => {
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  jest
    .spyOn(GetActiveAccountService, "get")
    .mockResolvedValue(new AccountEntity(defaultAccountDto({ domain: "https://selected.test/team" })));
  // Even legacy projected settings claiming a match cannot authorize another backend.
  jest.spyOn(ParseAppUrlService, "test").mockReturnValue(true);
  jest.spyOn(AppBootstrap, "assertUserAuthenticated").mockResolvedValue(true);
});
it.each(["https://other.test/team/app/passwords", "https://selected.test/team-evil/app/passwords"])(
  "rejects foreign bootstrap before any active account UI or auth lookup: %s",
  async (url) => {
    expect(await AppBootstrap.canBeAttachedTo({ frameId: 0, url })).toBe(false);
    expect(AppBootstrap.assertUserAuthenticated).not.toHaveBeenCalled();
  },
);
it("permits selected backend bootstrap", async () => {
  expect(await AppBootstrap.canBeAttachedTo({ frameId: 0, url: "https://selected.test/team/app/passwords" })).toBe(
    true,
  );
});
it("drains the complete injection decision before a concurrent switch can replace active config", async () => {
  const previous = PagemodManager.pagemods;
  PagemodManager.pagemods = [AppBootstrap];
  let finish;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  AppBootstrap.assertUserAuthenticated.mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const inject = jest.spyOn(AppBootstrap, "injectFiles").mockResolvedValue();
  try {
    const injection = PagemodManager.exec({ frameId: 0, tabId: 42, url: "https://selected.test/team/app/passwords" });
    await ready;
    const swap = jest.fn();
    const transition = AccountContext.transition(swap);
    expect(swap).not.toHaveBeenCalled();
    finish(true);
    await injection;
    await transition;
    expect(inject).toHaveBeenCalledWith(42, 0);
    expect(swap).toHaveBeenCalledTimes(1);
    expect(inject.mock.invocationCallOrder[0]).toBeLessThan(swap.mock.invocationCallOrder[0]);
  } finally {
    PagemodManager.pagemods = previous;
  }
});
