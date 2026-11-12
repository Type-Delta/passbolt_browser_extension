jest.mock("../../src/all/webAccessibleResources/js/lib/port", () => jest.fn());
import Port from "../../src/all/webAccessibleResources/js/lib/port";
import { main, renderAccountOnboarding } from "../../src/all/contentScripts/js/app/AccountOnboarding";

const skeleton = () => {
  document.body.innerHTML =
    '<div id="temporary-skeleton" class="temporary skeleton"><div class="page password"><div id="app" class="app ready"></div></div></div>';
};
afterEach(() => {
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});
test("shows a credential-free prompt only on the vault skeleton and launches", async () => {
  skeleton();
  const launch = jest.fn().mockResolvedValue();
  const add = HTMLButtonElement.prototype.addEventListener;
  let userClick;
  const listener = jest.spyOn(HTMLButtonElement.prototype, "addEventListener").mockImplementation(function (
    name,
    callback,
    ...options
  ) {
    if (name === "click") {
      userClick = callback;
    }
    return add.call(this, name, callback, ...options);
  });
  const cleanup = renderAccountOnboarding(document, "https://vault.example.test/team", launch);
  expect(document.querySelector("#temporary-skeleton").classList.contains("passbolt-onboarding-hidden")).toBe(true);
  expect(document.body.textContent).toContain("https://vault.example.test/team");
  expect(document.querySelectorAll("input, textarea, form")).toHaveLength(0);
  document.querySelector("[data-passbolt-onboarding] button").click();
  expect(launch).not.toHaveBeenCalled();
  await userClick({ isTrusted: true });
  expect(launch).toHaveBeenCalledTimes(1);
  cleanup();
  expect(document.querySelector("[data-passbolt-onboarding]")).toBeNull();
  expect(document.querySelector("#temporary-skeleton").classList.contains("passbolt-onboarding-hidden")).toBe(false);
  listener.mockRestore();
});
test("does not affect a login, other skeleton, or existing vault iframe", () => {
  document.body.innerHTML = '<form><input type="email"></form>';
  expect(renderAccountOnboarding(document, "https://vault.example.test", jest.fn())).toBeNull();
  document.body.innerHTML =
    '<div id="temporary-skeleton" class="skeleton temporary"><div class="page login"></div></div>';
  expect(renderAccountOnboarding(document, "https://vault.example.test", jest.fn())).toBeNull();
  skeleton();
  const frame = document.createElement("iframe");
  frame.src = "chrome-extension://abc/webAccessibleResources/passbolt-iframe-app.html";
  document.body.append(frame);
  expect(renderAccountOnboarding(document, "https://vault.example.test", jest.fn())).toBeNull();
});

test("disconnect removes the prompt, hidden class, and unload listener", async () => {
  skeleton();
  const handlers = {};
  let disconnect;
  const port = {
    on: (name, callback) => {
      handlers[name] = callback;
    },
    onConnectError: jest.fn(),
    connect: jest.fn().mockResolvedValue(),
    request: jest.fn().mockResolvedValue(),
    emit: jest.fn().mockResolvedValue(),
    _port: {
      onDisconnect: {
        addListener: (cb) => {
          disconnect = cb;
        },
        removeListener: jest.fn(),
      },
    },
  };
  Port.mockImplementationOnce(() => port);
  await main(document, window);
  handlers["passbolt.port.check"]("probe");
  expect(port.emit).toHaveBeenCalledWith("probe", "SUCCESS");
  handlers["passbolt.accounts.onboarding-ready"]("https://vault.example.test");
  expect(document.querySelector("[data-passbolt-onboarding]")).not.toBeNull();
  disconnect();
  expect(document.querySelector("[data-passbolt-onboarding]")).toBeNull();
  expect(document.querySelector("#temporary-skeleton").classList.contains("passbolt-onboarding-hidden")).toBe(false);
  expect(port._port.onDisconnect.removeListener).toHaveBeenCalledWith(disconnect);
});
