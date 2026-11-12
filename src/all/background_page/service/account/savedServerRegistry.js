import SavedAccountRegistry from "./savedAccountRegistry";
import { OpenpgpAssertion } from "../../utils/openpgp/openpgpAssertions";

const STORAGE_KEY = "saved-servers-v1";

/** Public server metadata is independent of the encrypted account registry and its rollback snapshots. */
export default class SavedServerRegistry {
  static record(server) {
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(server.server_key_fingerprint) || !Number.isFinite(server.checked_at)) {
      throw new Error("Invalid saved-server metadata. Existing records have been preserved.");
    }
    return {
      domain: SavedAccountRegistry.canonicalDomain(server.domain),
      server_key_fingerprint: server.server_key_fingerprint.toUpperCase(),
      checked_at: server.checked_at,
    };
  }

  static async load(assertCurrent) {
    const stored = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    assertCurrent();
    if (stored && (stored.version !== 1 || !Array.isArray(stored.servers))) {
      throw new Error("Invalid saved-server registry. Existing records have been preserved.");
    }
    const servers = (stored?.servers || []).map((server) => this.record(server));
    const { accounts } = await SavedAccountRegistry.read();
    let changed = false;
    for (const account of accounts) {
      const domain = SavedAccountRegistry.canonicalDomain(account.domain);
      const key = await OpenpgpAssertion.readKeyOrFail(account.server_public_armored_key);
      const fingerprint = key.getFingerprint().toUpperCase();
      const existing = servers.find((server) => server.domain === domain);
      if (!existing) {
        servers.push({ domain, server_key_fingerprint: fingerprint, checked_at: 0 });
        changed = true;
      } else if (existing.server_key_fingerprint !== fingerprint) {
        // Account pins change only through the existing confirmed replacement workflow.
        existing.server_key_fingerprint = fingerprint;
        existing.checked_at = 0;
        changed = true;
      }
    }
    assertCurrent();
    if (changed) {
      await browser.storage.local.set({ [STORAGE_KEY]: { version: 1, servers } });
      assertCurrent();
    }
    return servers;
  }

  static read(assertCurrent = () => {}) {
    return navigator.locks.request(STORAGE_KEY, () => this.load(assertCurrent));
  }

  static remember(server, assertCurrent = () => {}) {
    const record = this.record(server);
    return navigator.locks.request(STORAGE_KEY, async () => {
      assertCurrent();
      const servers = await this.load(assertCurrent);
      const existing = servers.find((item) => item.domain === record.domain);
      if (existing && existing.server_key_fingerprint !== record.server_key_fingerprint) {
        throw new Error("The saved server key changed. Verify the server before adding another account.");
      }
      const updated = [...servers.filter((item) => item.domain !== record.domain), record];
      assertCurrent();
      await browser.storage.local.set({ [STORAGE_KEY]: { version: 1, servers: updated } });
      assertCurrent();
      return record;
    });
  }
}
