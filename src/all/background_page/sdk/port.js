/**
 * Port Chrome Wrapper
 *
 * @copyright (c) 2017 Passbolt SARL
 * @licence GNU Affero General Public License http://www.gnu.org/licenses/agpl-3.0.en.html
 */
import { v4 as uuidv4 } from "uuid";

import PortManager from "./port/portManager";
import AccountContext from "../service/account/accountContext";
import SavedAccountRegistry from "../service/account/savedAccountRegistry";

class Port {
  /**
   * Constructor
   * @param {port} port
   */
  constructor(port) {
    if (!port) {
      throw Error("A port is required.");
    }
    this.accountGeneration = AccountContext.generation;
    this._listeners = {};
    this._disconnectListeners = {};
    this._port = port;
    this._port.onMessage.addListener((msg) => {
      this._onMessage(msg);
    });
    this._port.onDisconnect.addListener(() => this._onDisconnect());
  }

  /**
   * When the port is disconnected, reject all waiting promises and delete listener
   * @private
   */
  _onDisconnect() {
    const applyAndDeleteDisconnectListener = (requestId) => {
      this._disconnectListeners[requestId]?.apply();
      delete this._disconnectListeners[requestId];
    };
    Object.keys(this._disconnectListeners).forEach(applyAndDeleteDisconnectListener);
  }

  /**
   * When a message is received on the port
   * Triggers all the callback associated with that message name
   *
   * @param json
   * @private
   */
  _onMessage(json) {
    const msg = JSON.parse(json);
    const eventName = msg[0];
    if (Array.isArray(this._listeners[eventName])) {
      const listeners = this._listeners[eventName];
      for (let i = 0; i < listeners.length; i++) {
        const listener = listeners[i];
        const args = Array.prototype.slice.call(msg, 1);
        if (eventName.startsWith("passbolt.") && !eventName.startsWith("passbolt.accounts.")) {
          AccountContext.run(this.accountGeneration, async () => {
            const { pending_account: pending } = await browser.storage.session.get("pending_account");
            const bootstrap = [
              "passbolt.account.get",
              "passbolt.config.read",
              "passbolt.config.readAll",
              "passbolt.addon.is-configured",
              "passbolt.addon.get-domain",
              "passbolt.addon.get-version",
              "passbolt.addon.get-url",
            ];
            if (pending && pending.expires > Date.now() && !bootstrap.includes(eventName)) {
              const state = await SavedAccountRegistry.read();
              const active = state.accounts.find(
                (dto) => SavedAccountRegistry.account(dto).id === state.active_account_id,
              );
              if (
                active &&
                SavedAccountRegistry.canonicalDomain(active.domain) ===
                  SavedAccountRegistry.canonicalDomain(pending.account.domain)
              ) {
                const savedMfaHandoff =
                  pending.saved &&
                  [
                    "passbolt.auth.is-mfa-required",
                    "passbolt.tabs.open-trusted-domain",
                    "passbolt.auth.post-login-redirect",
                  ].includes(eventName) &&
                  SavedAccountRegistry.account(pending.account).id === state.active_account_id &&
                  (eventName !== "passbolt.auth.post-login-redirect" ||
                    (await PortManager.isAccountManagementSender("Auth", this._port.sender, this._port.name)));
                if (!savedMfaHandoff) {
                  throw new Error("Complete or cancel the pending account sign-in first.");
                }
              }
            }
            return listener.callback.apply(this, args);
          }).catch(async (error) => {
            // An explicit rejection must reach the old requester even after generation invalidation.
            try {
              await this.emitQuiet(args[0], "ERROR", { name: error.name, message: error.message });
            } catch {
              this.disconnect();
              return;
            }
            if (this.accountGeneration !== AccountContext.generation) {
              this.disconnect();
            }
          });
        } else {
          listener.callback.apply(this, args);
        }
        if (listener.once) {
          this._listeners[eventName].splice(i, 1);
          // delete the listener if empty array
          if (this._listeners[eventName].length === 0) {
            delete this._listeners[eventName];
          }
          i--; // jump back since i++ is the new i
        }
      }
    }
  }

  /**
   * Add listener for a message name on the current port
   *
   * @param name string
   * @param callback function
   * @param once bool
   * @private
   */
  _addListener(name, callback, once) {
    if (!Array.isArray(this._listeners[name])) {
      this._listeners[name] = [];
    }
    this._listeners[name].push({
      name: name,
      callback: callback,
      once: once,
    });
  }

  /**
   * On message name triggers a callback
   *
   * @param name
   * @param callback
   */
  on(name, callback) {
    this._addListener(name, callback, false);
  }

  /**
   * On message name triggers a callback only once,
   * e.g. remove the listener once the message has been received
   *
   * @param name
   * @param callback
   */
  once(name, callback) {
    this._addListener(name, callback, true);
  }

  /** Remove only this callback, including when its request settles during dispatch. */
  removeListener(name, callback) {
    const listeners = this._listeners[name]?.filter((listener) => listener.callback !== callback);
    if (listeners?.length) {
      this._listeners[name] = listeners;
    } else {
      delete this._listeners[name];
    }
  }

  /**
   * Emit a message to the content code
   * @param requestArgs the arguments
   */
  emit(...requestArgs) {
    if (this.accountGeneration !== AccountContext.generation) {
      return;
    }
    const message = JSON.stringify(requestArgs);
    // Port payloads can contain passphrases and imported private keys. Never log them.
    this._port.postMessage(message);
  }

  /**
   * Emit a message quiet to the content code
   * @param requestArgs the arguments
   */
  async emitQuiet(...requestArgs) {
    const message = JSON.stringify(requestArgs);
    this._port.postMessage(message);
  }

  /**
   * Emit a request to the content code and expect a response.
   * @param message the message
   * @param args the arguments
   * @return Promise
   */
  request(message, ...args) {
    try {
      AccountContext.assert(this.accountGeneration);
    } catch (error) {
      return Promise.reject(error);
    }
    // Generate a request id that will be used by the addon to answer this request.
    const requestId = uuidv4();
    // Add the requestId to the request parameters.
    const requestArgs = [message, requestId].concat(args);

    // The promise that is return when you call passbolt.request.
    return new Promise((resolve, reject) => {
      const cancel = () => {
        delete this._listeners[requestId];
        delete this._disconnectListeners[requestId];
        AccountContext.interactiveRequests.delete(cancel);
        reject(new Error("The account request was canceled. Reopen the vault."));
      };
      /*
       * Observe when the request has been completed.
       * Or if a progress notification is sent.
       */
      this.once(requestId, (status, ...callbackArgs) => {
        if (status === "SUCCESS") {
          resolve.apply(null, callbackArgs);
        } else if (status === "ERROR") {
          reject.apply(null, callbackArgs);
        }
        delete this._disconnectListeners[requestId];
        AccountContext.interactiveRequests.delete(cancel);
      });
      // Add reject to the disconnect listener
      this._disconnectListeners[requestId] = cancel;
      AccountContext.interactiveRequests.add(cancel);
      // Emit the message to the addon-code.
      try {
        this.emit.apply(this, requestArgs);
      } catch {
        cancel();
      }
    });
  }

  /**
   * Disconnect the port
   *
   * @return {void}
   */
  disconnect() {
    this._port.disconnect();
  }
}

export default Port;
