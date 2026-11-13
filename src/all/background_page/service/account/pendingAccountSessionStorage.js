import { v4 as uuidv4 } from "uuid";

/** Serializes attempt comparison and local mutations. Callbacks must never wait for authentication or user input. */
export default class PendingAccountSessionStorage {
  static async change(expected, callback) {
    return navigator.locks.request("pending-account", async () => {
      let { pending_account: current } = await browser.storage.session.get("pending_account");
      if (current && current.expires <= Date.now()) {
        await browser.storage.session.remove("pending_account");
        await browser.alarms.clear("PendingAccountExpiry");
        current = null;
      }
      // Upgrade session-only attempts made by an earlier worker without exposing the identifier in RPCs.
      if (current && !current.attempt_id) {
        current.attempt_id = uuidv4();
        await browser.storage.session.set({ pending_account: current });
      }
      if (expected && (!current || current.attempt_id !== expected.attempt_id)) {
        return null;
      }
      return callback(current);
    });
  }

  static read() {
    return this.change(null, (current) => current);
  }

  static remove(expected) {
    return this.change(expected, async () => {
      await browser.storage.session.remove("pending_account");
      await browser.alarms.clear("PendingAccountExpiry");
    });
  }
}
