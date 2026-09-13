import { parseExpression } from "cron-parser";

/** The five fields accepted by the spreadsheet scheduler. */
export interface TableScriptCronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

/** Common visual scheduling patterns, with a field editor for other rules. */
export type TableScriptCronPeriod =
  | "minutes"
  | "hours"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom";

/** A visual representation of one field; unsupported syntax is preserved. */
export interface TableScriptCronFieldRule {
  mode: "every" | "values" | "interval" | "range" | "preserved";
  values: string[];
  start: number;
  end: number;
  interval: number;
}

/** Numeric choices offered by each field, using Sunday = 0. */
export const tableScriptCronRanges: Record<
  keyof TableScriptCronFields,
  { min: number; max: number }
> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 },
};

/**
 * Splits a saved expression without normalizing or replacing its syntax.
 *
 * @param cron the saved or locally edited expression.
 * @returns its five fields, or undefined for another expression format.
 */
export function getTableScriptCronFields(
  cron: string
): TableScriptCronFields | undefined {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return undefined;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/**
 * Changes only the fields explicitly edited by the user.
 *
 * @param cron the current expression.
 * @param changes the replacement field values.
 * @returns an expression retaining every other field.
 */
export function updateTableScriptCron(
  cron: string,
  changes: Partial<TableScriptCronFields>
): string {
  const fields = {
    minute: "0",
    hour: "9",
    dayOfMonth: "*",
    month: "*",
    dayOfWeek: "*",
    ...getTableScriptCronFields(cron),
    ...changes,
  };
  return [
    fields.minute,
    fields.hour,
    fields.dayOfMonth,
    fields.month,
    fields.dayOfWeek,
  ].join(" ");
}

/**
 * Reads supported field syntax while retaining complex existing expressions.
 *
 * @param field the cron field being edited.
 * @param value its unmodified expression.
 * @returns a visual rule, or a preserved rule requiring explicit replacement.
 */
export function getTableScriptCronFieldRule(
  field: keyof TableScriptCronFields,
  value: string
): TableScriptCronFieldRule {
  const { min, max } = tableScriptCronRanges[field];
  const rule: TableScriptCronFieldRule = {
    mode: "preserved",
    values: [],
    start: min,
    end: max,
    interval: 1,
  };
  const inRange = (number: number) => number >= min && number <= max;
  if (value === "*" || value === "?") {
    return { ...rule, mode: "every" };
  }
  const step = /^(\*|\d+)\/(\d+)$/.exec(value);
  if (step) {
    const start = step[1] === "*" ? min : Number(step[1]);
    const interval = Number(step[2]);
    if (inRange(start) && interval >= 1 && interval <= max - min + 1) {
      return { ...rule, mode: "interval", start, interval };
    }
    return rule;
  }
  const values: string[] = [];
  for (const part of value.split(",")) {
    if (part === "L" && field === "dayOfMonth") {
      values.push(part);
      continue;
    }
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) {
      return rule;
    }
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    if (!inRange(start) || !inRange(end) || start > end) {
      return rule;
    }
    for (let number = start; number <= end; number++) {
      values.push(String(number));
    }
  }
  const range = /^(\d+)-(\d+)$/.exec(value);
  return {
    ...rule,
    mode: range ? "range" : "values",
    values: [...new Set(values)],
    start: range ? Number(range[1]) : min,
    end: range ? Number(range[2]) : max,
  };
}

/**
 * Compresses selected numbers into ranges without converting them to a wildcard.
 *
 * @param values the nonempty selection, including L for the last day of a month.
 * @returns compact cron syntax that retains date and weekday matching semantics.
 */
export function formatTableScriptCronValues(values: string[]): string {
  const numbers = [...new Set(values.filter((value) => value !== "L"))]
    .map(Number)
    .sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < numbers.length; index++) {
    const start = numbers[index];
    let end = start;
    while (numbers[index + 1] === end + 1) {
      end = numbers[++index];
    }
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  if (values.includes("L")) {
    parts.push("L");
  }
  return parts.join(",");
}

/**
 * Recognizes common schedules without rewriting the original expression.
 *
 * @param cron the current expression.
 * @returns a matching preset, or custom for any other syntax.
 */
export function getTableScriptCronPeriod(cron: string): TableScriptCronPeriod {
  const fields = getTableScriptCronFields(cron);
  if (!fields) {
    return "custom";
  }
  const minute = getTableScriptCronFieldRule("minute", fields.minute);
  const hour = getTableScriptCronFieldRule("hour", fields.hour);
  const singleMinute = minute.mode === "values" && minute.values.length === 1;
  const singleHour = hour.mode === "values" && hour.values.length === 1;
  const plainDay = fields.dayOfMonth === "*" && fields.month === "*";
  const everyDay = plainDay && fields.dayOfWeek === "*";
  const startsAtZero = (value: string, rule: TableScriptCronFieldRule) =>
    value === "*" || (value.startsWith("*/") && rule.mode === "interval");
  if (everyDay && fields.hour === "*" && startsAtZero(fields.minute, minute)) {
    return "minutes";
  }
  if (everyDay && singleMinute && startsAtZero(fields.hour, hour)) {
    return "hours";
  }
  if (!singleMinute || !singleHour) {
    return "custom";
  }
  if (everyDay) {
    return "daily";
  }
  const weekday = getTableScriptCronFieldRule("dayOfWeek", fields.dayOfWeek);
  if (plainDay && weekday.values.length) {
    return "weekly";
  }
  const day = getTableScriptCronFieldRule("dayOfMonth", fields.dayOfMonth);
  if (fields.month === "*" && fields.dayOfWeek === "*" && day.values.length) {
    return "monthly";
  }
  return "custom";
}

/**
 * Applies a user-selected preset, keeping the existing time where possible.
 *
 * @param cron the current expression.
 * @param period the explicitly selected scheduling period.
 * @returns the preset expression; custom leaves the expression unchanged.
 */
export function setTableScriptCronPeriod(
  cron: string,
  period: TableScriptCronPeriod
): string {
  if (period === "custom") {
    return cron;
  }
  const fields = getTableScriptCronFields(cron);
  const minute = fields && /^\d+$/.test(fields.minute) ? fields.minute : "0";
  const hour = fields && /^\d+$/.test(fields.hour) ? fields.hour : "9";
  switch (period) {
    case "minutes":
      return "* * * * *";
    case "hours":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * 1`;
    case "monthly":
      return `${minute} ${hour} 1 * *`;
  }
}

/**
 * Previews occurrences with the same parser and timezone rules as the server.
 *
 * @param cron the draft five-field expression, limited to the API's 100 characters.
 * @param timezone the selected IANA timezone.
 * @param now the exclusive beginning of the preview.
 * @returns the next three occurrences, or an empty array for an invalid schedule.
 */
export function previewTableScriptCron(
  cron: string,
  timezone: string,
  now = new Date()
): Date[] {
  try {
    if (!getTableScriptCronFields(cron) || cron.trim().length > 100) {
      return [];
    }
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
    const expression = parseExpression(cron, {
      currentDate: now,
      tz: timezone,
    });
    return Array.from({ length: 3 }, () => expression.next().toDate());
  } catch {
    return [];
  }
}
