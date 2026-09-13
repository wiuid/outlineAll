import environment from "./environment";
import { getTableScriptExecutionConfig } from "./tableScriptConfig";

afterEach(() => {
  delete environment.TABLE_SCRIPT_RUNNER_URL;
  delete environment.TABLE_SCRIPT_RUNNER_TOKEN;
});

it.each([
  "https://runner.example.com",
  "http://127.0.0.1:8090",
  "http://[::1]:8090",
])("allows an authenticated executor at %s", (url) => {
  environment.TABLE_SCRIPT_RUNNER_URL = url;
  environment.TABLE_SCRIPT_RUNNER_TOKEN =
    "test-credential-with-at-least-32-characters";
  expect(getTableScriptExecutionConfig().executionEnabled).toBe(true);
});

it.each([
  "http://runner.example.com",
  "file:///etc/passwd",
  "https://name:password@runner.example.com",
  "https://runner.example.com?token=secret",
  "not-a-url",
])("rejects an unsafe or malformed executor URL %s", (url) => {
  environment.TABLE_SCRIPT_RUNNER_URL = url;
  environment.TABLE_SCRIPT_RUNNER_TOKEN =
    "test-credential-with-at-least-32-characters";
  expect(getTableScriptExecutionConfig().executionEnabled).toBe(false);
});

it("requires a strong service credential", () => {
  environment.TABLE_SCRIPT_RUNNER_URL = "https://runner.example.com";
  environment.TABLE_SCRIPT_RUNNER_TOKEN = "short";
  expect(getTableScriptExecutionConfig().executionEnabled).toBe(false);
});
