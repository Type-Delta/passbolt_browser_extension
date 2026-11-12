import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.join(__dirname, "stylesheet.js"), "utf8");
// Load the declared test environment's DOM through Node: transforming its native async generators breaks JSDOM.
const { JSDOM } = process.getBuiltinModule("module").createRequire(require.resolve("jest-environment-jsdom"))("jsdom");
const documents = [];

afterEach(() => {
  for (const dom of documents.splice(0)) {
    dom.window.close();
  }
});

async function loadStyles(href, { framed = false, theme = "default" } = {}) {
  // Keep this DOM isolated from the repository's Node-only window polyfill.
  const dom = new JSDOM();
  documents.push(dom);
  const document = dom.window.document;
  document.head.innerHTML = '<script id="stylesheet-manager" data-file="ext_quickaccess.min.css"></script>';
  let change;
  const context = {
    document,
    URL,
    window: {
      location: { href },
      matchMedia: () => ({ matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() }),
    },
    chrome: {
      runtime: { getURL: (file) => `chrome-extension://test/${file.replace(/^\/+/, "")}` },
      storage: {
        local: {
          get: (keys, callback) =>
            callback(theme ? { _passbolt_data: { config: { "user.settings.theme": theme } } } : {}),
        },
        onChanged: {
          addListener: (callback) => {
            change = callback;
          },
        },
      },
    },
  };
  context.window.self = context.window;
  context.window.top = framed ? {} : context.window;
  vm.runInNewContext(source, context);
  // The real initialization awaits both theme detection and retrieval.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  return { change, href: () => document.querySelector("#stylesheet")?.getAttribute("href") };
}

it("uses full authentication styles for onboarding and keeps that file on theme changes", async () => {
  const page = await loadStyles(
    "chrome-extension://test/webAccessibleResources/quickaccess.html?uiMode=tab&feature=add-account",
  );
  expect(page.href()).toBe("/webAccessibleResources/css/themes/default/ext_authentication.min.css");
  page.change({ _passbolt_data: { newValue: { config: { "user.settings.theme": "midgar" } } } });
  expect(page.href()).toBe("/webAccessibleResources/css/themes/midgar/ext_authentication.min.css");
});

it.each([
  ["chrome-extension://test/webAccessibleResources/quickaccess.html?uiMode=detached&feature=add-account", false],
  ["chrome-extension://test/webAccessibleResources/quickaccess.html?uiMode=tab", false],
  ["chrome-extension://test/webAccessibleResources/another.html?uiMode=tab&feature=add-account", false],
  ["https://test/webAccessibleResources/quickaccess.html?uiMode=tab&feature=add-account", false],
  ["chrome-extension://test/webAccessibleResources/quickaccess.html?uiMode=tab&feature=add-account", true],
])("preserves popup styles outside the exact top-level onboarding page", async (url, framed) => {
  const page = await loadStyles(url, { framed });
  expect(page.href()).toBe("/webAccessibleResources/css/themes/default/ext_quickaccess.min.css");
});

it("defaults onboarding to light while preserving ordinary popup OS preference", async () => {
  const onboarding = await loadStyles(
    "chrome-extension://test/webAccessibleResources/quickaccess.html?uiMode=tab&feature=add-account",
    { theme: null },
  );
  expect(onboarding.href()).toBe("/webAccessibleResources/css/themes/default/ext_authentication.min.css");
  const popup = await loadStyles("chrome-extension://test/webAccessibleResources/quickaccess.html", { theme: null });
  expect(popup.href()).toBe("/webAccessibleResources/css/themes/midgar/ext_quickaccess.min.css");
});
