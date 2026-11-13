import SavedAccountsService from "../service/account/savedAccountsService";
import PortManager from "../sdk/port/portManager";
import AccountContext from "../service/account/accountContext";
import AccountOnboardingService from "../service/account/accountOnboardingService";
import { QuickAccessService } from "../service/ui/quickAccess.service";

/** Account management is attached only to existing authenticated UI port types. */
export const SavedAccountsEvents = {
  listen(worker) {
    const sender = worker.port._port.sender;
    const assertCurrent = () => {
      AccountContext.assert(worker.port.accountGeneration);
      if (PortManager.getPortById(worker.port._port.name) !== worker.port) {
        throw new Error("The onboarding window was closed. Open the extension to try again.");
      }
    };
    for (const action of ["open-add-tab", "verify-server", "validate-private-key", "check-passphrase"]) {
      worker.port.on(`passbolt.accounts.${action}`, async (requestId, input) => {
        let invalidSession = false;
        try {
          const result = await AccountContext.run(worker.port.accountGeneration, async () => {
            assertCurrent();
            const allowed =
              action === "open-add-tab"
                ? await PortManager.isAccountManagementSender(worker.name, sender, worker.port._port.name)
                : await PortManager.isOnboardingSender(worker.name, sender, worker.port._port.name);
            assertCurrent();
            if (!allowed) {
              invalidSession = true;
              throw new Error("Open the extension add-account tab to continue.");
            }
            let result;
            if (action === "open-add-tab") {
              result = await QuickAccessService.openAddAccountTab(input, worker);
            } else if (action === "verify-server") {
              result = await AccountOnboardingService.verifyServer(input, assertCurrent);
              if (input.remember === true) {
                await SavedAccountsService.publishChanged({ reconcilePending: false });
              }
            } else if (action === "validate-private-key") {
              result = await AccountOnboardingService.validatePrivateKey(input);
            } else {
              result = await AccountOnboardingService.checkPassphrase(input);
            }
            if (action === "open-add-tab") {
              AccountContext.assert(worker.port.accountGeneration);
            } else {
              assertCurrent();
            }
            return result;
          });
          await worker.port.emitQuiet(requestId, "SUCCESS", result).catch(() => {});
        } catch (error) {
          const expired =
            action !== "open-add-tab" &&
            (invalidSession ||
              worker.port.accountGeneration !== AccountContext.generation ||
              PortManager.getPortById(worker.port._port.name) !== worker.port);
          const response = expired
            ? {
                name: "OnboardingSessionExpiredError",
                message: "This add-account session expired. Close this tab and reopen Add account from the extension.",
              }
            : { name: error.name, message: error.message };
          await worker.port.emitQuiet(requestId, "ERROR", response).catch(() => {});
        }
      });
    }
    for (const action of ["list", "add", "switch", "remove", "lock", "cancel-pending"]) {
      worker.port.on(`passbolt.accounts.${action}`, async (requestId, input) => {
        try {
          if (!(await PortManager.isAccountManagementSender(worker.name, sender, worker.port._port.name))) {
            // Account import and management stay inside extension-owned UI.
            throw new Error("Open the extension to manage saved accounts.");
          }
          let onboarding = false;
          if (action === "add") {
            const url = new URL(sender.url);
            if (url.searchParams.get("uiMode") === "tab" && url.searchParams.get("feature") === "add-account") {
              onboarding = await PortManager.isOnboardingSender(worker.name, sender, worker.port._port.name);
              if (!onboarding) {
                throw new Error("Open the extension add-account tab to continue.");
              }
            }
          }
          let result;
          if (action === "list") {
            result = await SavedAccountsService.list(worker.port);
          } else if (action === "add") {
            result = onboarding
              ? await SavedAccountsService.add(input, worker.port, { onboarding: true, assertCurrent })
              : await SavedAccountsService.add(input, worker.port);
          } else if (action === "cancel-pending") {
            result = await SavedAccountsService.cancelPendingSignIn(worker.port);
          } else {
            result = await SavedAccountsService[action](input?.account_id, worker.port);
          }
          if (action === "switch" || action === "add") {
            await SavedAccountsService.navigate(result, worker);
          }
          await worker.port.emitQuiet(requestId, "SUCCESS", result).catch(() => {});
          if (action !== "list") {
            await SavedAccountsService.publishChanged().catch(() => {});
          }
        } catch (error) {
          await worker.port.emitQuiet(requestId, "ERROR", { name: error.name, message: error.message }).catch(() => {});
        }
      });
    }
  },
};
