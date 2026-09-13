import { parseExpression } from "cron-parser";
import { ValidationError } from "@server/errors";

/**
 * Calculates the next five-field cron occurrence in the chosen IANA timezone.
 *
 * @param cron the minute, hour, day, month and weekday expression.
 * @param timezone the IANA timezone, including UTC.
 * @param now the time after which to find one occurrence.
 * @returns the next scheduled date; missed executions are not replayed.
 * @throws {ValidationError} if the expression or timezone is invalid.
 */
export function nextTableScriptRun(
  cron: string,
  timezone: string,
  now = new Date()
): Date {
  try {
    if (cron.trim().split(/\s+/).length !== 5) {
      throw new Error("Expected five cron fields");
    }
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
    return parseExpression(cron, { currentDate: now, tz: timezone })
      .next()
      .toDate();
  } catch {
    throw ValidationError(
      "Use a valid five-field cron expression and timezone"
    );
  }
}
