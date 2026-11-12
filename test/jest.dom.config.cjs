const config = require("../jest.config.json");

module.exports = {
  ...config,
  rootDir: "..",
  testEnvironment: "jsdom",
  setupFiles: [],
  setupFilesAfterEnv: [],
  testMatch: ["<rootDir>/test/contentScripts/**/*.test.js"],
};
