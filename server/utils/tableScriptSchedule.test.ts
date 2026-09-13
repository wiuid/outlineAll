import { nextTableScriptRun } from "./tableScriptSchedule";

it("resolves a wall-clock time in the selected timezone", () => {
  expect(
    nextTableScriptRun(
      "0 9 * * *",
      "Asia/Shanghai",
      new Date("2026-09-12T00:00:00Z")
    ).toISOString()
  ).toBe("2026-09-12T01:00:00.000Z");
});

it.each([
  ["* * * * * *", "UTC"],
  ["60 * * * *", "UTC"],
  ["@daily", "UTC"],
  ["0 9 * * *", "not-a-zone"],
])("rejects invalid schedule %s in %s", (cron, timezone) => {
  expect(() => nextTableScriptRun(cron, timezone)).toThrow("five-field");
});
