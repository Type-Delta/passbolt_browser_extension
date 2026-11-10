/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) 2023 Passbolt SA (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 *
 * @copyright     Copyright (c) 2023 Passbolt SA (https://www.passbolt.com)
 * @license       https://opensource.org/licenses/AGPL-3.0 AGPL License
 * @link          https://www.passbolt.com Passbolt(tm)
 * @since         4.0.0
 */
import Port from "../port";
import PagemodManager from "../../pagemod/pagemodManager";
import WorkersSessionStorage from "../../service/sessionStorage/workersSessionStorage";
import WorkerEntity from "../../model/entity/worker/workerEntity";

import SavedAccountRegistry from "../../service/account/savedAccountRegistry";
import AccountContext from "../../service/account/accountContext";
import PendingAccountSessionStorage from "../../service/account/pendingAccountSessionStorage";

const ACCOUNT_FRAME_PAGES = {
  App: "/webAccessibleResources/passbolt-iframe-app.html",
  Auth: "/webAccessibleResources/passbolt-iframe-login.html",
};

class PortManager {
  constructor() {
    this._ports = {}; // Object{portId: port, ...} for which the port is available
    this.onPortConnect = this.onPortConnect.bind(this);
    this.onTabRemoved = this.onTabRemoved.bind(this);
  }

  /**
   * on port connect
   * @param port the port
   * @returns {Promise<void>}
   */
  async onPortConnect(port) {
    const generation = AccountContext.generation;
    return AccountContext.run(generation, async () => {
      if (await this.isQuickAccessPort(port.sender)) {
        AccountContext.assert(generation);
        await this.registerAndAttachEvent(port, "QuickAccess");
      } else {
        await this.connectPortFromTab(port);
      }
    }).catch((error) => {
      port.disconnect();
      if (generation !== AccountContext.generation || AccountContext.transitioning) {
        return;
      }
      throw error;
    });
  }

  /**
   * Connect port from tab
   * @param port the port
   * @returns {Promise<void>}
   */
  async connectPortFromTab(port) {
    const worker = await WorkersSessionStorage.getWorkerById(port.name);
    if (worker) {
      const workerEntity = new WorkerEntity(worker);
      /*
       * If a port is already connected and is still in memory it should not be registered again
       * In the MV3 case the memory is flushed when the service worker is down so the port should be able to reconnect
       */
      if (!this.isPortExist(port.name) && (await this.isKnownPortSender(workerEntity, port.sender))) {
        await this.updateWorkerStatus(workerEntity);
        await this.registerAndAttachEvent(port, workerEntity.name);
      } else {
        console.debug(
          `A known port has been denied connection or reconnection with name=${port.name}, tabUrl=${port.sender.tab.url}, tabId=${port.sender.tab.id}, frameId=${port.sender.frameId}`,
        );
        port.disconnect();
      }
    } else {
      // If there is no worker associate to this port
      console.debug(
        `An unknown port has been denied connection with name=${port.name}, tabUrl=${port.sender.tab.url}, tabId=${port.sender.tab.id}, frameId=${port.sender.frameId}`,
      );
      port.disconnect();
    }
  }

  /**
   * Is quickAccess port sender
   * @param sender
   * @returns {Promise<boolean>}
   */
  async isQuickAccessPort(sender) {
    const quickAppUrl = browser.runtime.getURL("/webAccessibleResources/quickaccess.html");
    if (sender.tab && (sender.frameId !== 0 || sender.tab.url?.split(/[?#]/)[0] !== quickAppUrl)) {
      return false;
    }

    if (
      new URL(sender.url).searchParams.has("passbolt") &&
      new URL(sender.url).searchParams.get("passbolt") !== "quickaccess"
    ) {
      return false;
    }
    const isPortUrlAQuickAppUrl =
      new URL(sender.url).href.split(/[?#]/)[0] === new URL(quickAppUrl).href.split(/[?#]/)[0];
    return isPortUrlAQuickAppUrl;
  }

  /** Account UI roles are narrower than extension origin alone, especially for framed Quick Access. */
  async isAccountManagementSender(role, sender, portId) {
    if (role === "QuickAccess") {
      if (await this.isQuickAccessPort(sender)) {
        return true;
      }
      if (!portId) {
        return false;
      }
      const worker = await WorkersSessionStorage.getWorkerById(portId);
      return Boolean(worker) && worker.name === role && this.isKnownPortSender(new WorkerEntity(worker), sender);
    }
    if (
      !ACCOUNT_FRAME_PAGES[role] ||
      sender?.url?.split(/[?#]/)[0] !== browser.runtime.getURL(ACCOUNT_FRAME_PAGES[role]) ||
      !sender.tab
    ) {
      return false;
    }
    const worker = await WorkersSessionStorage.getWorkerById(portId);
    return Boolean(worker) && worker.name === role && this.isKnownPortSender(new WorkerEntity(worker), sender);
  }

  /**
   * Is known port sender
   * @param {WorkerEntity} worker The worker
   * @param sender The sender
   * @returns {Promise<boolean>}
   */
  async isKnownPortSender(worker, sender) {
    const state = await SavedAccountRegistry.read();
    if ((worker.toDto().account_id || null) !== state.active_account_id) {
      return false;
    }
    const account = state.accounts
      .map((dto) => SavedAccountRegistry.account(dto))
      .find((account) => account.id === state.active_account_id);
    if (account && ["App", "AppBootstrap", "Auth", "AuthBootstrap"].includes(worker.name)) {
      const page = new URL(sender.tab.url);
      const base = new URL(account.domain);
      if (
        page.origin !== base.origin ||
        !(page.pathname === base.pathname || page.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`))
      ) {
        return false;
      }
      const frame = new URL(sender.url);
      const extension = new URL(browser.runtime.getURL("/"));
      if (
        ACCOUNT_FRAME_PAGES[worker.name] &&
        (frame.protocol !== extension.protocol ||
          frame.host !== extension.host ||
          frame.pathname !== new URL(browser.runtime.getURL(ACCOUNT_FRAME_PAGES[worker.name])).pathname)
      ) {
        return false;
      }
      if (frame.protocol !== extension.protocol || frame.host !== extension.host) {
        if (
          frame.origin !== base.origin ||
          !(frame.pathname === base.pathname || frame.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`))
        ) {
          return false;
        }
      }
    }
    if (worker.name === "QuickAccess") {
      const page = browser.runtime.getURL("/webAccessibleResources/quickaccess.html");
      if (
        sender.url?.split(/[?#]/)[0] !== page ||
        sender.tab?.url?.split(/[?#]/)[0] !== page ||
        sender.frameId !== 0 ||
        new URL(sender.url).searchParams.get("passbolt") !== worker.id
      ) {
        return false;
      }
    }
    // Iframe application connecting for the first time are not know therefor their frame id is not yet associated
    if (worker.frameId === null) {
      worker.frameId = sender.frameId;
    }
    return worker.tabId === sender.tab.id && worker.frameId === sender.frameId;
  }

  /**
   * Register and attach event to the port
   * @param port The port
   * @param {string} name The pagemod name
   * @returns {Promise<void>}
   */
  async registerAndAttachEvent(port, name) {
    const portWrapper = new Port(port);
    this.registerPort(portWrapper);
    await PagemodManager.attachEventToPort(portWrapper, name);
    if (this._ports[port.name] !== portWrapper) {
      console.debug(`The port ${port.name} has been disconnected before being ready.`);
      return;
    }
    portWrapper.emit("passbolt.port.ready");
  }

  /**
   * Update the worker status
   * @param {WorkerEntity} worker The worker
   * @return {Promise<void>}
   */
  async updateWorkerStatus(worker) {
    worker.status = WorkerEntity.STATUS_CONNECTED;
    await WorkersSessionStorage.updateWorker(worker);
  }

  /**
   * Register the port
   * @param port
   */
  registerPort(port) {
    const id = port._port.name;
    this._ports[id] = port;
    port._port.onDisconnect.addListener(() => {
      if (this._ports[id] === port) {
        delete this._ports[id];
      }
    });
  }

  /**
   * Disconnect and remove the port
   * @param {string} id the id
   * @param {object} removeInfo The remove info
   * @returns <void>
   */
  removePort(id, removeInfo = null) {
    // The port will be disconnected automatically after a tab is removed
    if (!removeInfo) {
      // Disconnect the port manually when the user navigate to another page (browser will disconnect too late)
      this._ports[id]?.disconnect();
    }
    delete this._ports[id];
  }

  /**
   * Is port exist
   * @param {string} id The id
   * @returns {boolean}
   */
  isPortExist(id) {
    return Boolean(this._ports[id]);
  }

  /**
   * Get the port by id
   * @param {string} id The id
   * @returns {Port}
   */
  getPortById(id) {
    return this._ports[id];
  }

  /**
   * Flush.
   * @returns {Promise<void>}
   */
  async flush() {
    this._ports = {};
    await WorkersSessionStorage.flush();
  }

  /**
   * On tab removed, remove associated worker from the session storage and delete runtime ports references.
   * @param {number} tabId The tab id
   * @param {object} removeInfo The remove info (only present on tab on removed event)
   * @returns {Promise<void>}
   */
  async onTabRemoved(tabId, removeInfo = null) {
    if (typeof tabId === "undefined") {
      throw new Error("A tab identifier is required.");
    }
    if (!Number.isInteger(tabId)) {
      throw new Error("The tab identifier should be a valid integer.");
    }
    if (removeInfo) {
      const pending = await PendingAccountSessionStorage.read();
      if (pending?.tab_id === tabId) {
        await PendingAccountSessionStorage.remove(pending);
      }
    }
    const workers = await WorkersSessionStorage.getWorkersByTabId(tabId);
    workers.forEach((worker) => this.removePort(worker.id, removeInfo));
    await WorkersSessionStorage.deleteByTabId(tabId);
  }
}

export default new PortManager();
