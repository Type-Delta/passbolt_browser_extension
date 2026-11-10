import SavedAccountsService from "../service/account/savedAccountsService";
import PortManager from "../sdk/port/portManager";

/** Account management is attached only to existing authenticated UI port types. */
export const SavedAccountsEvents = {
  listen(worker) {
    const sender = worker.port._port.sender;
    for (const action of ["list", "add", "switch", "remove", "lock", "cancel-pending"]) {
      worker.port.on(`passbolt.accounts.${action}`, async (requestId, input) => {
        try {
          if (!(await PortManager.isAccountManagementSender(worker.name, sender, worker.port._port.name))) {
            // Account import and management stay inside extension-owned UI.
            throw new Error("Open the extension to manage saved accounts.");
          }
          const result =
            action === "list"
              ? await SavedAccountsService.list(worker.port)
              : action === "add"
                ? await SavedAccountsService.add(input, worker.port)
                : action === "cancel-pending"
                  ? await SavedAccountsService.cancelPendingSignIn(worker.port)
                  : await SavedAccountsService[action](input?.account_id, worker.port);
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
