import Port from "../../../webAccessibleResources/js/lib/port";

/** Render only over the server's vault skeleton; return a cleanup function. */
export function renderAccountOnboarding(doc, domain, launch) {
  const skeleton = doc.querySelector("#temporary-skeleton.temporary.skeleton");
  if (
    !skeleton?.querySelector(".page.password > #app.app") ||
    doc.querySelector('iframe[src*="/webAccessibleResources/passbolt-iframe-app.html"]') ||
    doc.querySelector("[data-passbolt-onboarding]")
  ) {
    return null;
  }
  const host = doc.createElement("section");
  host.setAttribute("data-passbolt-onboarding", "");
  host.setAttribute("aria-labelledby", "passbolt-onboarding-title");
  const title = doc.createElement("h1");
  title.id = "passbolt-onboarding-title";
  title.textContent = "Add your Passbolt account";
  const explanation = doc.createElement("p");
  explanation.textContent =
    "There is no Passbolt account in this browser. Add an account in a new tab to open your vault.";
  const server = doc.createElement("p");
  server.textContent = `Server: ${domain}`;
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "Add account";
  const status = doc.createElement("p");
  status.setAttribute("role", "status");
  const click = async (event) => {
    if (!event.isTrusted || button.disabled) {
      return;
    }
    button.disabled = true;
    try {
      await launch();
    } catch {
      status.textContent = "Could not open account setup. Please try again.";
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener("click", click);
  host.append(title, explanation, server, button, status);
  skeleton.classList.add("passbolt-onboarding-hidden");
  skeleton.after(host);
  return () => {
    button.removeEventListener("click", click);
    host.remove();
    skeleton.classList.remove("passbolt-onboarding-hidden");
  };
}

export async function main(doc = document, win = window) {
  const port = new Port(self.portname);
  let cleanup;
  const dispose = () => {
    cleanup?.();
    cleanup = null;
    win.removeEventListener("unload", dispose);
    port._port?.onDisconnect.removeListener(dispose);
  };
  port.onConnectError(dispose);
  port.on("passbolt.port.check", (requestId) => port.emit(requestId, "SUCCESS"));
  port.on("passbolt.accounts.onboarding-ready", (domain) => {
    cleanup?.();
    cleanup = renderAccountOnboarding(doc, domain, () => port.request("passbolt.accounts.open-add-tab"));
  });
  win.addEventListener("unload", dispose);
  try {
    const connected = port.connect();
    port._port.onDisconnect.addListener(dispose);
    await connected;
  } catch {
    dispose();
  }
}

if (typeof self.portname === "string") {
  main();
}
