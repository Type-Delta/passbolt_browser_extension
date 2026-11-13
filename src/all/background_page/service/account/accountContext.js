/**
 * One foreground vault. Drain complete port handlers before replacing its legacy working state.
 * Responses to background-to-UI requests remain deliverable while a transition drains.
 */
class AccountContext {
  static generation = 0;
  static transitioning = false;
  static running = new Set();
  static interactiveRequests = new Set();

  static assert(generation) {
    if (generation !== this.generation || this.transitioning) {
      throw new Error("The selected account changed. Reopen the vault.");
    }
  }

  static async run(generation, callback) {
    this.assert(generation);
    // Schedule after recording the operation so a synchronous transition sees it.
    // eslint-disable-next-line promise/no-callback-in-promise
    const operation = Promise.resolve().then(callback);
    this.running.add(operation);
    try {
      return await operation;
    } finally {
      this.running.delete(operation);
    }
  }

  static async transition(callback, invalidate = true) {
    if (this.transitioning) {
      throw new Error("An account change is already in progress.");
    }
    this.transitioning = true;
    try {
      for (const cancel of [...this.interactiveRequests]) {
        cancel();
      }
      await Promise.allSettled([...this.running]);
      if (invalidate) {
        this.generation++;
      }
      return await callback();
    } finally {
      this.transitioning = false;
    }
  }
}

export default AccountContext;
