import { createRoot } from "react-dom/client";
import ExtQuickAccess from "passbolt-styleguide/src/react-quickaccess/ExtQuickAccess";
import Port from "../lib/port";

jest.mock("react-dom/client", () => ({ createRoot: jest.fn() }));
jest.mock("passbolt-styleguide/src/react-quickaccess/ExtQuickAccess", () => jest.fn());
jest.mock("../lib/port");

let render;
const ExtAddAccount = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  render = jest.fn();
  createRoot.mockReturnValue({ render });
  Port.mockImplementation(() => ({ connect: jest.fn().mockResolvedValue(), on: jest.fn(), request: jest.fn() }));
  window.self = window;
  window.top = window;
  global.document = { querySelector: jest.fn(() => ({})) };
});

afterEach(() => {
  delete global.document;
});

async function start(search) {
  window.location.search = search;
  jest.doMock("react-dom/client", () => ({ createRoot }));
  jest.doMock("passbolt-styleguide/src/react-quickaccess/ExtQuickAccess", () => ExtQuickAccess);
  jest.doMock("passbolt-styleguide/src/react-extension/ExtAddAccount", () => ExtAddAccount, { virtual: true });
  jest.doMock("../lib/port", () => Port);
  jest.isolateModules(() => {
    require("./QuickAccess");
  });
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

it("renders the account-independent onboarding application before any foreground Quick Access initialization", async () => {
  await start("?passbolt=worker&uiMode=tab&feature=add-account&domain=https%3A%2F%2Fvault.example%2Fteam");
  const element = render.mock.calls[0][0];
  expect(element.type).toBe(ExtAddAccount);
  expect(element.props).toMatchObject({
    storage: browser.storage,
    domainHint: "https://vault.example/team",
    port: expect.any(Object),
  });
  expect(ExtQuickAccess).not.toHaveBeenCalled();
});

it("preserves ordinary popup routing and refuses to initialize inside a web frame", async () => {
  await start("?passbolt=quickaccess");
  expect(render.mock.calls[0][0].type).toBe(ExtQuickAccess);
  render.mockClear();
  window.top = {};
  await start("?passbolt=worker&uiMode=tab&feature=add-account");
  expect(render).not.toHaveBeenCalled();
});
