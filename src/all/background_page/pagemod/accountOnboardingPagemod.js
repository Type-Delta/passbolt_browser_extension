import Pagemod from "./pagemod";
import AccountContext from "../service/account/accountContext";
import SavedAccountRegistry from "../service/account/savedAccountRegistry";
import VerifyAccountServerService from "../service/account/verifyAccountServerService";
import WorkersSessionStorage from "../service/sessionStorage/workersSessionStorage";
import WorkerEntity from "../model/entity/worker/workerEntity";
import PortManager from "../sdk/port/portManager";
import { QuickAccessService } from "../service/ui/quickAccess.service";

// CSS is injected by the extension, so a site's inline-style CSP cannot block the prompt.
const CSS = `
#temporary-skeleton.passbolt-onboarding-hidden { display: none !important; }
[data-passbolt-onboarding] { box-sizing: border-box; max-width: 32rem; margin: 12vh auto; padding: 2rem; font: inherit; color: var(--Text-and-icons-Main-text); background: var(--Workspace-Panels-background); border: 1px solid var(--Workspace-Dividers); border-radius: 8px; }
[data-passbolt-onboarding] h1 { font-size: 1.5rem; margin: 0 0 1rem; }
[data-passbolt-onboarding] p { margin: 0 0 1rem; overflow-wrap: anywhere; }
[data-passbolt-onboarding] button { padding: .65rem 1rem; border: 0; border-radius: 4px; background: #1666c1; color: white; font: inherit; cursor: pointer; }
[data-passbolt-onboarding] button:focus-visible { outline: 3px solid #164682; outline-offset: 2px; }
`;

function hasPassboltVaultSkeleton() {
  return Boolean(
    document.querySelector("#temporary-skeleton.temporary.skeleton .page.password > #app.app") &&
      !document.querySelector('iframe[src*="/webAccessibleResources/passbolt-iframe-app.html"]'),
  );
}

function candidateFor(url) {
  const page = new URL(url);
  if (page.protocol !== "https:" || page.username || page.password) {
    return null;
  }
  const segments = page.pathname.split("/");
  const app = segments.indexOf("app");
  if (segments.some((segment) => ["auth", "mfa", "setup", "recover"].includes(segment))) {
    return null;
  }
  const path = (app < 0 ? page.pathname : segments.slice(0, app).join("/")).replace(/\/+$/, "");
  return `${page.origin}${path}`;
}

class AccountOnboarding extends Pagemod {
  verifiedPages = new Map();
  get appName() {
    return "AccountOnboarding";
  }
  get contentScriptFiles() {
    return ["contentScripts/js/dist/vendors.js", "contentScripts/js/dist/account-onboarding.js"];
  }

  async eligible(url, generation, tabId) {
    AccountContext.assert(generation);
    const candidate = candidateFor(url);
    if (!candidate) {
      return null;
    }
    const state = await SavedAccountRegistry.read();
    const { pending_account: pending } = await browser.storage.session.get("pending_account");
    AccountContext.assert(generation);
    if (state.accounts.length || (pending && pending.expires > Date.now())) {
      return null;
    }
    if (tabId !== undefined) {
      const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "ISOLATED",
        func: hasPassboltVaultSkeleton,
      });
      AccountContext.assert(generation);
      if (results?.[0]?.result !== true) {
        return null;
      }
      const stateAfterProbe = await SavedAccountRegistry.read();
      const { pending_account: pendingAfterProbe } = await browser.storage.session.get("pending_account");
      AccountContext.assert(generation);
      if (stateAfterProbe.accounts.length || (pendingAfterProbe && pendingAfterProbe.expires > Date.now())) {
        return null;
      }
    }
    const verified = await VerifyAccountServerService.verify(candidate);
    AccountContext.assert(generation);
    if (verified.domain !== candidate) {
      return null;
    }
    const latest = await SavedAccountRegistry.read();
    const { pending_account: current } = await browser.storage.session.get("pending_account");
    AccountContext.assert(generation);
    return latest.accounts.length || (current && current.expires > Date.now()) ? null : candidate;
  }

  async canBeAttachedTo(details) {
    if (details.frameId !== 0 || !Number.isInteger(details.tabId)) {
      return false;
    }
    try {
      const generation = AccountContext.generation;
      const domain = await this.eligible(details.url, generation, details.tabId);
      if (!domain) {
        return false;
      }
      this.verifiedPages.set(details.tabId, { url: details.url, domain, generation });
      return true;
    } catch {
      return false;
    }
  }

  async injectFiles(tabId, frameId) {
    await super.injectFiles(tabId, frameId);
    await browser.scripting.insertCSS({ css: CSS, target: { tabId, frameIds: [frameId] } });
  }

  async attachEvents(port) {
    const sender = port._port.sender;
    const source = sender?.url;
    const generation = port.accountGeneration;
    const verifiedPage = this.verifiedPages.get(sender?.tab?.id);
    const validSource = async () => {
      AccountContext.assert(generation);
      if (
        !sender?.tab ||
        sender.frameId !== 0 ||
        sender.tab.url !== source ||
        !verifiedPage ||
        verifiedPage.url !== source ||
        verifiedPage.generation !== generation ||
        this.verifiedPages.get(sender.tab.id) !== verifiedPage
      ) {
        throw new Error("The page has changed. Reload it to add an account.");
      }
      const bound = await WorkersSessionStorage.getWorkerById(port._port.name);
      if (
        !bound ||
        bound.name !== this.appName ||
        !(await PortManager.isKnownPortSender(new WorkerEntity(bound), sender))
      ) {
        throw new Error("The page is no longer connected.");
      }
      const tab = await browser.tabs.get(sender.tab.id);
      if (tab.id !== sender.tab.id || tab.url !== source) {
        throw new Error("The page has changed. Reload it to add an account.");
      }
      const domain = await this.eligible(source, generation);
      if (!domain || domain !== verifiedPage.domain) {
        throw new Error("This page cannot start account setup.");
      }
      const currentTab = await browser.tabs.get(sender.tab.id);
      AccountContext.assert(generation);
      if (currentTab.url !== source) {
        throw new Error("The page has changed. Reload it to add an account.");
      }
      return domain;
    };
    let initial;
    try {
      initial = await validSource();
    } catch {
      port._port.disconnect();
      return;
    }
    port.on("passbolt.accounts.open-add-tab", async (requestId) => {
      try {
        const result = await AccountContext.run(generation, async () => {
          const domain = await validSource();
          if (domain !== initial) {
            throw new Error("The page has changed. Reload it to add an account.");
          }
          return QuickAccessService.openAddAccountTab({ domain }, { port, tab: sender.tab, name: this.appName });
        });
        await port.emitQuiet(requestId, "SUCCESS", result);
      } catch (error) {
        await port.emitQuiet(requestId, "ERROR", { name: error.name, message: error.message }).catch(() => {});
      }
    });
    await port.emit("passbolt.accounts.onboarding-ready", initial);
  }
}

export default new AccountOnboarding();
