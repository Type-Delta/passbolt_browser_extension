import onboarding from "./accountOnboardingPagemod";
import SavedAccountRegistry from "../service/account/savedAccountRegistry";
import VerifyAccountServerService from "../service/account/verifyAccountServerService";
import { QuickAccessService } from "../service/ui/quickAccess.service";
import AccountContext from "../service/account/accountContext";
import WorkersSessionStorage from "../service/sessionStorage/workersSessionStorage";
import PortManager from "../sdk/port/portManager";
import { OpenpgpAssertion } from "../utils/openpgp/openpgpAssertions";
import Pagemod from "./pagemod";
import Scripting from "../../common/polyfill/scriptingPolyfill";
import { runInNewContext } from "vm";
import { readFileSync } from "fs";
import { parse } from "@babel/parser";

jest.mock("../service/account/savedAccountRegistry", () => ({
  __esModule: true,
  default: { read: jest.fn(), canonicalDomain: (value) => new URL(value).href.replace(/\/+$/, "") },
}));
jest.mock("../service/sessionStorage/workersSessionStorage", () => ({
  __esModule: true,
  default: { getWorkerById: jest.fn() },
}));
jest.mock("../sdk/port/portManager", () => ({ __esModule: true, default: { isKnownPortSender: jest.fn() } }));
jest.mock("../service/ui/quickAccess.service", () => ({ QuickAccessService: { openAddAccountTab: jest.fn() } }));

const url = "https://vault.example.test/team/app/passwords";
const domain = "https://vault.example.test/team";
let sender;
const workerDto = {
  id: "32d72b91-7de9-4856-8a33-c5660ca468cd",
  name: "AccountOnboarding",
  tabId: 12,
  frameId: 0,
  status: "connected",
};
let listeners, port;
beforeEach(() => {
  jest.clearAllMocks();
  onboarding.verifiedPages.clear();
  sender = { url, frameId: 0, tab: { id: 12, url } };
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  SavedAccountRegistry.read.mockResolvedValue({ accounts: [], active_account_id: null });
  jest.spyOn(VerifyAccountServerService, "verify").mockImplementation(async (candidate) => ({ domain: candidate }));
  jest.spyOn(browser.storage.session, "get").mockResolvedValue({});
  browser.tabs.get.mockResolvedValue({ id: 12, url });
  jest.spyOn(browser.scripting, "executeScript").mockResolvedValue([{ result: true }]);
  WorkersSessionStorage.getWorkerById.mockResolvedValue(workerDto);
  PortManager.isKnownPortSender.mockResolvedValue(true);
  listeners = {};
  port = {
    accountGeneration: 0,
    _port: { name: workerDto.id, sender, disconnect: jest.fn() },
    on: jest.fn((name, cb) => {
      listeners[name] = cb;
    }),
    emitQuiet: jest.fn().mockResolvedValue(),
    emit: jest.fn().mockResolvedValue(),
  };
  QuickAccessService.openAddAccountTab.mockResolvedValue({ tab_id: 99 });
});

test.each([
  ["https://vault.example.test/", "https://vault.example.test"],
  ["https://vault.example.test/team", domain],
  [url, domain],
])("eligible %s verifies the correct base", async (page, expected) => {
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url: page })).toBe(true);
  expect(VerifyAccountServerService.verify).toHaveBeenCalledWith(expected);
});

test.each([
  [{ frameId: 1, url }, "subframe"],
  [{ frameId: 0, url: "http://vault.example.test/app" }, "http"],
  [{ frameId: 0, url: "https://vault.example.test/team/auth/login" }, "login route"],
])("rejects %s (%s)", async (details) => {
  expect(await onboarding.canBeAttachedTo(details)).toBe(false);
  expect(VerifyAccountServerService.verify).not.toHaveBeenCalled();
});

test("an ordinary page or invalid tab is rejected before anonymous verification", async () => {
  browser.scripting.executeScript.mockResolvedValueOnce([{ result: false }]);
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url: "https://vault.example.test/news/page" })).toBe(
    false,
  );
  expect(VerifyAccountServerService.verify).not.toHaveBeenCalled();
  expect(await onboarding.canBeAttachedTo({ frameId: 0, url })).toBe(false);
  expect(browser.scripting.executeScript).toHaveBeenCalledTimes(1);
});

test("rechecks account state and generation after the skeleton probe", async () => {
  SavedAccountRegistry.read.mockResolvedValueOnce({ accounts: [] }).mockResolvedValueOnce({ accounts: [{}] });
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(false);
  expect(VerifyAccountServerService.verify).not.toHaveBeenCalled();
  browser.scripting.executeScript.mockImplementationOnce(async () => {
    AccountContext.generation++;
    return [{ result: true }];
  });
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(false);
  expect(VerifyAccountServerService.verify).not.toHaveBeenCalled();
});

test("accounts, live pending, invalid server, and generation changes fail closed", async () => {
  SavedAccountRegistry.read.mockResolvedValueOnce({ accounts: [{}] });
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(false);
  browser.storage.session.get.mockResolvedValueOnce({ pending_account: { expires: Date.now() + 10000 } });
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(false);
  VerifyAccountServerService.verify.mockRejectedValueOnce(new Error("invalid"));
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(false);
  VerifyAccountServerService.verify.mockImplementationOnce(async () => {
    AccountContext.generation++;
    return { domain };
  });
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(false);
});

test("registers only the launcher and rejects navigated or stale sources", async () => {
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(true);
  await onboarding.attachEvents(port);
  expect(Object.keys(listeners)).toEqual(["passbolt.accounts.open-add-tab"]);
  await listeners["passbolt.accounts.open-add-tab"]("one");
  expect(QuickAccessService.openAddAccountTab).toHaveBeenCalledWith(
    { domain },
    expect.objectContaining({ port, name: "AccountOnboarding" }),
  );
  expect(port.emitQuiet).toHaveBeenCalledWith("one", "SUCCESS", { tab_id: 99 });
  browser.tabs.get.mockResolvedValueOnce({ id: 12, url: "https://other.example.test/" });
  await listeners["passbolt.accounts.open-add-tab"]("two");
  expect(port.emitQuiet).toHaveBeenCalledWith("two", "ERROR", expect.any(Object));
  AccountContext.generation++;
  await listeners["passbolt.accounts.open-add-tab"]("three");
  expect(QuickAccessService.openAddAccountTab).toHaveBeenCalledTimes(1);
});

test("rejects foreign or embedded sender and a changed account/pending state", async () => {
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(true);
  await onboarding.attachEvents(port);
  const launch = listeners["passbolt.accounts.open-add-tab"];
  PortManager.isKnownPortSender.mockResolvedValueOnce(false);
  await launch("foreign");
  browser.storage.session.get.mockResolvedValueOnce({ pending_account: { expires: Date.now() + 10000 } });
  await launch("pending");
  SavedAccountRegistry.read.mockResolvedValueOnce({ accounts: [{}] });
  await launch("account");
  sender.frameId = 1;
  await launch("frame");
  sender.frameId = 0;
  expect(QuickAccessService.openAddAccountTab).not.toHaveBeenCalled();
});

test("checks a candidate through the real anonymous verifier", async () => {
  VerifyAccountServerService.verify.mockRestore();
  const request = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      header: { status: "success", code: 200 },
      body: { keydata: "public key", fingerprint: "ABCD" },
    }),
  });
  jest.spyOn(OpenpgpAssertion, "readKeyOrFail").mockResolvedValue({ getFingerprint: () => "abcd" });
  jest.spyOn(OpenpgpAssertion, "assertPublicKey").mockImplementation(() => {});
  expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(true);
  expect(request).toHaveBeenCalledWith(
    `${domain}/auth/verify.json?api-version=v2`,
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }),
  );
  request.mockRestore();
});

test("the vault predicate runs through the real MV2 function transport", async () => {
  // Use the shipped source before Jest rewrites arrow functions into named functions.
  const source = readFileSync(require.resolve("./accountOnboardingPagemod"), "utf8");
  const ast = parse(source, { sourceType: "module" });
  const properties = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.type === "ObjectProperty" && node.key.name === "func") {
      properties.push(node.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  };
  visit(ast);
  const value = properties[0];
  const declaration = ast.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id.name === value.name,
  );
  const predicate = runInNewContext(
    `${declaration ? source.slice(declaration.start, declaration.end) : ""}; ({func: ${source.slice(value.start, value.end)}}).func`,
  );
  const polyfill = new Scripting(browser);
  const transport = jest.spyOn(browser.tabs, "executeScript").mockImplementation(async (tabId, details) => [
    runInNewContext(details.code, {
      window: {},
      document: {
        querySelector: (selector) => (selector.startsWith("#temporary-skeleton") ? {} : null),
      },
    }),
  ]);
  const scripting = jest
    .spyOn(browser.scripting, "executeScript")
    .mockImplementation((options) => polyfill.executeScript({ ...options, func: predicate }));
  try {
    expect(await onboarding.canBeAttachedTo({ tabId: 12, frameId: 0, url })).toBe(true);
    expect(transport).toHaveBeenCalledWith(12, expect.objectContaining({ frameId: 0 }));
  } finally {
    scripting.mockRestore();
    transport.mockRestore();
  }
});

test("the prompt stylesheet runs through the real MV2 CSS transport", async () => {
  const polyfill = new Scripting(browser);
  const parent = jest.spyOn(Pagemod.prototype, "injectFiles").mockResolvedValue();
  const transport = jest.spyOn(browser.tabs, "insertCSS").mockResolvedValue();
  const scripting = jest
    .spyOn(browser.scripting, "insertCSS")
    .mockImplementation((options) => polyfill.insertCSS(options));
  try {
    await expect(onboarding.injectFiles(12, 0)).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ code: expect.stringContaining("passbolt-onboarding-hidden"), frameId: 0 }),
    );
  } finally {
    scripting.mockRestore();
    transport.mockRestore();
    parent.mockRestore();
  }
});
