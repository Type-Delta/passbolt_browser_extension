import PopupHandlerService from "./popupHandlerService";
import SsoLoginUrlEntity from "../../model/entity/sso/ssoLoginUrlEntity";
import AzureSsoSettingsEntity from "passbolt-styleguide/src/shared/models/entity/ssoSettings/AzureSsoSettingsEntity";
import AccountContext from "../account/accountContext";

beforeEach(() => {
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  AccountContext.interactiveRequests.clear();
});
it("cancels the manual SSO popup waiter and removes callbacks before a late token", async () => {
  const service = new PopupHandlerService("https://vault.test", 4, false);
  jest.spyOn(service, "openPopup").mockResolvedValue({ tabs: [{ id: 42 }] });
  const url = new SsoLoginUrlEntity({ url: "https://login.microsoftonline.com" }, AzureSsoSettingsEntity.PROVIDER_ID);
  const request = service.getSsoTokenFromThirdParty(url).catch((error) => error);
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  const registered = AccountContext.interactiveRequests.size;
  await AccountContext.transition(async () => {});
  // Settle the original defective waiter without leaking it.
  if (service.resolvePromise) {
    service.resolvePromise("late-token");
  }
  expect(await request).toBeInstanceOf(Error);
  expect(registered).toBe(1);
  expect(browser.tabs.onUpdated.removeListener).toHaveBeenCalledWith(service.verifyCodeInTab);
  expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalledWith(service.verifyPopupClosed);
  expect(AccountContext.interactiveRequests.size).toBe(0);
  expect(browser.tabs.remove).toHaveBeenCalledWith(42);
});
