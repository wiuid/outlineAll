import {
  formatTableScriptCronValues,
  getTableScriptCronFieldRule,
  getTableScriptCronFields,
  getTableScriptCronPeriod,
  previewTableScriptCron,
  setTableScriptCronPeriod,
  updateTableScriptCron,
} from "./tableScriptCron";

it.each([
  ["* * * * *", "minutes"],
  ["*/15 * * * *", "minutes"],
  ["30 */2 * * *", "hours"],
  ["0 9 * * *", "daily"],
  ["45 17 * * 1-5", "weekly"],
  ["0 9 1,15,L * *", "monthly"],
  ["0/15 9-17 * JAN-MAR MON-FRI", "custom"],
  ["0 9 * * 4#2", "custom"],
  ["0 9 * * 5L", "custom"],
  ["0 9 * * 7", "custom"],
])("recognizes %s without replacing its saved syntax", (cron, period) => {
  expect(getTableScriptCronPeriod(cron)).toBe(period);
  expect(setTableScriptCronPeriod(cron, "custom")).toBe(cron);
});

it("keeps untouched complex fields when one field is changed", () => {
  const cron = "0/15 9-17 * JAN-MAR MON-FRI";
  const updated = updateTableScriptCron(cron, { hour: "10-12" });
  expect(updated).toBe("0/15 10-12 * JAN-MAR MON-FRI");
  expect(getTableScriptCronFields(cron)?.hour).toBe("9-17");
  expect(getTableScriptCronFieldRule("dayOfWeek", "MON-FRI").mode).toBe(
    "preserved"
  );
  expect(getTableScriptCronFieldRule("dayOfWeek", "4#2").mode).toBe(
    "preserved"
  );
  expect(getTableScriptCronFieldRule("dayOfWeek", "5L").mode).toBe("preserved");
});

it("retains the chosen time when switching to selected weekdays", () => {
  const cron = updateTableScriptCron(
    setTableScriptCronPeriod("30 9 * * *", "weekly"),
    { dayOfWeek: formatTableScriptCronValues(["1", "3", "5"]) }
  );
  expect(
    previewTableScriptCron(
      cron,
      "Asia/Shanghai",
      new Date("2026-09-13T00:00:00Z")
    ).map((date) => date.toISOString())
  ).toEqual([
    "2026-09-14T01:30:00.000Z",
    "2026-09-16T01:30:00.000Z",
    "2026-09-18T01:30:00.000Z",
  ]);
});

it("previews minute intervals across hour boundaries with cron semantics", () => {
  expect(
    previewTableScriptCron(
      "*/7 * * * *",
      "UTC",
      new Date("2026-09-13T12:50:00Z")
    ).map((date) => date.toISOString())
  ).toEqual([
    "2026-09-13T12:56:00.000Z",
    "2026-09-13T13:00:00.000Z",
    "2026-09-13T13:07:00.000Z",
  ]);
});

it("uses the actual month end, including leap years", () => {
  const cron = updateTableScriptCron("0 9 1 * *", {
    dayOfMonth: formatTableScriptCronValues(["L"]),
  });
  expect(
    previewTableScriptCron(
      cron,
      "Asia/Shanghai",
      new Date("2028-01-01T00:00:00Z")
    ).map((date) => date.toISOString())
  ).toEqual([
    "2028-01-31T01:00:00.000Z",
    "2028-02-29T01:00:00.000Z",
    "2028-03-31T01:00:00.000Z",
  ]);
});

it("skips months that do not contain a selected date", () => {
  expect(
    previewTableScriptCron(
      "0 9 31 * *",
      "UTC",
      new Date("2026-02-01T00:00:00Z")
    ).map((date) => date.toISOString())
  ).toEqual([
    "2026-03-31T09:00:00.000Z",
    "2026-05-31T09:00:00.000Z",
    "2026-07-31T09:00:00.000Z",
  ]);
});

it("previews local wall-clock time across daylight saving transitions", () => {
  expect(
    previewTableScriptCron(
      "0 9 * * *",
      "America/New_York",
      new Date("2026-10-31T00:00:00Z")
    ).map((date) => date.toISOString())
  ).toEqual([
    "2026-10-31T13:00:00.000Z",
    "2026-11-01T14:00:00.000Z",
    "2026-11-02T14:00:00.000Z",
  ]);
});

it("retains the scheduler's OR relationship between date and weekday", () => {
  const cron = updateTableScriptCron("0 9 1 * *", {
    dayOfWeek: formatTableScriptCronValues(["1"]),
  });
  expect(
    previewTableScriptCron(cron, "UTC", new Date("2026-09-28T10:00:00Z")).map(
      (date) => date.toISOString()
    )
  ).toEqual([
    "2026-10-01T09:00:00.000Z",
    "2026-10-05T09:00:00.000Z",
    "2026-10-12T09:00:00.000Z",
  ]);
});

it("compacts and restores selected values without turning them into wildcards", () => {
  const cron = formatTableScriptCronValues(["5", "1", "3", "2", "4", "3"]);
  expect(cron).toBe("1-5");
  expect(getTableScriptCronFieldRule("dayOfWeek", cron).values).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  expect(formatTableScriptCronValues(["0", "1", "2", "3", "4", "5", "6"])).toBe(
    "0-6"
  );
  expect(getTableScriptCronFieldRule("dayOfMonth", "1-3,15,L").values).toEqual([
    "1",
    "2",
    "3",
    "15",
    "L",
  ]);
});

it.each([
  ["0 9 * * *", "invalid-zone"],
  ["0 9 * * *", ""],
  ["0 0 9 * * *", "UTC"],
  ["0 9 31 2 *", "UTC"],
  ["60 * * * *", "UTC"],
  ["@daily", "UTC"],
  [`${"0,".repeat(50)}0 9 * * *`, "UTC"],
])("rejects an unsavable or impossible schedule %s in %s", (cron, timezone) => {
  expect(previewTableScriptCron(cron, timezone)).toEqual([]);
});
