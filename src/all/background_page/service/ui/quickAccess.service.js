import AccountContext from "../account/accountContext";
import SavedAccountRegistry from "../account/savedAccountRegistry";
/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) Passbolt SARL (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 *
 * @copyright     Copyright (c) Passbolt SA (https://www.passbolt.com)
 * @license       https://opensource.org/licenses/AGPL-3.0 AGPL License
 * @link          https://www.passbolt.com Passbolt(tm)
 * @since         3.4
 */
import { v4 as uuidv4 } from "uuid";
import WorkersSessionStorage from "../sessionStorage/workersSessionStorage";
import WorkerEntity from "../../model/entity/worker/workerEntity";
import BrowserService from "../browser/browserService";
import { QUICKACCESS_POPUP_URL } from "../toolbar/toolbarService";
import AccountOnboardingService from "../account/accountOnboardingService";
import PortManager from "../../sdk/port/portManager";

/** The default quickaccesss window height */
const QUICKACCESS_WINDOW_HEIGHT = 400;

/** The default quickaccesss window width */
const QUICKACCESS_WINDOW_WIDTH = 380;

/** Call only after authorizing the originating UI. The new tab inherits no foreground account UI state. */
async function openAddAccountTab(input = {}, worker) {
  const generation = worker.port.accountGeneration;
  const assertCurrent = () => {
    AccountContext.assert(generation);
    if (PortManager.getPortById(worker.port._port.name) !== worker.port) {
      throw new Error("The originating window was closed. Open the extension to try again.");
    }
  };
  return AccountContext.run(generation, async () => {
    assertCurrent();
    const sourceUrl = worker.tab?.url;
    const fromPage = sourceUrl?.startsWith("https:");
    const source = fromPage
      ? await browser.tabs.get(worker.tab.id)
      : ((await browser.tabs.query({ active: true, currentWindow: true })) || [])[0];
    assertCurrent();
    if (fromPage) {
      let sameSource = source?.id === worker.tab.id && source.url === sourceUrl;
      if (["App", "Auth"].includes(worker.name) && source?.id === worker.tab.id) {
        const account = await SavedAccountRegistry.active();
        const current = new URL(source.url);
        const base = new URL(account.domain);
        sameSource =
          current.origin === base.origin &&
          (current.pathname === base.pathname || current.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`));
      }
      assertCurrent();
      if (!sameSource) {
        throw new Error("The source page changed. Open onboarding from its current page.");
      }
    }
    const domain =
      input.domain === undefined
        ? await AccountOnboardingService.suggestedServer(source?.url, assertCurrent)
        : SavedAccountRegistry.canonicalDomain(input.domain);
    const state = await SavedAccountRegistry.read();
    assertCurrent();
    const workerId = uuidv4();
    const parameters = [
      { name: "uiMode", value: "tab" },
      { name: "feature", value: "add-account" },
    ];
    if (domain) {
      parameters.push({ name: "domain", value: domain });
    }
    const url = await buildDetachedQuickaccessUrl(parameters, workerId);
    assertCurrent();
    let tab;
    try {
      tab = await browser.tabs.create({
        url: "about:blank",
        active: false,
        ...(Number.isInteger(source?.windowId) ? { windowId: source.windowId } : {}),
      });
      // Authorized creation transfers completion to this reservation: focusing it can close the toolbar popup.
      AccountContext.assert(generation);
      await addWorkerQuickAccess(workerId, tab.id, state.active_account_id);
      AccountContext.assert(generation);
      await browser.tabs.update(tab.id, { url, active: true });
      AccountContext.assert(generation);
      return { tab_id: tab.id };
    } catch (error) {
      await WorkersSessionStorage.deleteById(workerId);
      if (tab?.id !== undefined) {
        const current = await browser.tabs.get(tab.id).catch(() => null);
        if (current?.url === "about:blank" || current?.url === url) {
          await browser.tabs.remove(tab.id).catch(() => {});
        }
      }
      throw error;
    }
  });
}

/**
 * Open the quick access in a detached mode
 * @param {array<{name: string, value: string}>} queryParameters The query parameters to attach to the quick access detached popup url
 * @return {Promise<windows.Window>}
 */
async function openInDetachedMode(queryParameters = []) {
  const generation = AccountContext.generation;
  return AccountContext.run(generation, async () => {
    const state = await SavedAccountRegistry.read();
    AccountContext.assert(generation);
    // Generate the worker id
    const workerId = uuidv4();

    const detachedQuickAccessqueryParameters = [...queryParameters, { name: "uiMode", value: "detached" }];
    const url = await buildDetachedQuickaccessUrl(detachedQuickAccessqueryParameters, workerId);
    const { top, left } = await buildDetachedQuickaccessPosition();

    const type = "popup";
    const width = QUICKACCESS_WINDOW_WIDTH;
    const height = QUICKACCESS_WINDOW_HEIGHT;
    const windowCreateData = { url: url, type: type, left: left, top: top, width: width, height: height };
    const quickAccessWindow = await browser.windows.create(windowCreateData);

    // Register the worker in the session storage
    try {
      AccountContext.assert(generation);
      await addWorkerQuickAccess(workerId, quickAccessWindow.tabs[0].id, state.active_account_id);
    } catch (error) {
      await browser.tabs.remove(quickAccessWindow.tabs[0].id);
      throw error;
    }

    // On firefox 90, with dual screen, the window is not positioned properly and it requires to be moved manually.
    browser.windows.update(quickAccessWindow.id, { left: left, top: top });
    return quickAccessWindow;
  });
}

/**
 * Add worker quickaccess in session storage
 * @param {string} workerId The worker id
 * @param {number} tabId The tab id
 * @return {Promise<void>}
 */
async function addWorkerQuickAccess(workerId, tabId, accountId) {
  const worker = {
    id: workerId,
    name: "QuickAccess",
    account_id: accountId,
    tabId: tabId,
    frameId: 0,
    status: WorkerEntity.STATUS_WAITING_CONNECTION,
  };
  await WorkersSessionStorage.addWorker(new WorkerEntity(worker));
}

/**
 * Build the detached quickaccess url.
 * @param {array<{name: string, value: string}>} queryParameters The query parameters to attach to the quick access detached popup url
 * @param {string} workerId The worker id
 * @returns {Promise<string>}
 */
async function buildDetachedQuickaccessUrl(queryParameters, workerId) {
  const browserExtensionUrl = await browser.runtime.getURL(QUICKACCESS_POPUP_URL);
  const quickaccessUrl = new URL(browserExtensionUrl);
  quickaccessUrl.searchParams.set("passbolt", workerId);
  queryParameters.forEach((queryParameter) =>
    quickaccessUrl.searchParams.append(queryParameter.name, queryParameter.value),
  );
  return quickaccessUrl.href;
}

/**
 * Build the detached quickaccess position.
 * @returns {Promise<{top: number, left: number}>}
 */
async function buildDetachedQuickaccessPosition() {
  const currentWindow = await browser.windows.getCurrent();
  const left = currentWindow.left + currentWindow.width - QUICKACCESS_WINDOW_WIDTH;
  const top = currentWindow.top;
  return { top: top, left: left };
}

/**
 * Check if attached mode is available for the current browser.
 * Attached mode opens the quickaccess as the browser action popup (attached to the toolbar icon).
 * Currently only supported on Safari.
 * @returns {boolean}
 */
function isAttachedModeAvailable() {
  return BrowserService.isSafari();
}

/**
 * Open the quick access in attached mode (as the browser action popup).
 * Builds the URL with query parameters, opens it as the browser action popup,
 * then resets the popup URL back to the default.
 * @param {array<{name: string, value: string}>} queryParameters The query parameters to attach to the popup url
 * @returns {Promise<string>} The worker id used as port identifier
 */
async function openInAttachedMode(queryParameters = []) {
  const workerId = uuidv4();
  const url = await buildDetachedQuickaccessUrl(queryParameters, workerId);

  browser.browserAction.setPopup({ popup: url });
  await browser.browserAction.openPopup();
  browser.browserAction.setPopup({ popup: QUICKACCESS_POPUP_URL });

  return workerId;
}

/**
 * Open the quick access.
 * Determines the best mode (attached or detached) based on browser capabilities.
 * In attached mode, opens as the browser action popup.
 * In detached mode, opens as a detached popup window with uiMode=detached query parameter.
 * @param {array<{name: string, value: string}>} queryParameters The query parameters to attach to the quick access popup url
 * @returns {Promise<windows.Window|string>} The quickaccess window in detached mode, the worker id in attached mode.
 */
async function open(queryParameters = []) {
  if (isAttachedModeAvailable()) {
    return openInAttachedMode(queryParameters);
  }
  return openInDetachedMode(queryParameters);
}

export const QuickAccessService = {
  openAddAccountTab,
  openInDetachedMode,
  openInAttachedMode,
  isAttachedModeAvailable,
  open,
};
