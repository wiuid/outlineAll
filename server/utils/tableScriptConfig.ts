import { TableScriptLimits } from "@shared/types/tableScript";
import { AuthorizationError } from "@server/errors";
import type Document from "@server/models/Document";
import type User from "@server/models/User";
import environment from "./environment";

/**
 * Resolves operator-controlled execution settings without exposing credentials.
 *
 * @returns the private runner connection settings.
 */
export function getTableScriptConfig() {
  return {
    runnerUrl: runnerUrl(environment.TABLE_SCRIPT_RUNNER_URL),
    runnerToken: environment.TABLE_SCRIPT_RUNNER_TOKEN,
  };
}

/**
 * Restricts scripts to the spreadsheet's current owner; access is additional.
 *
 * @param user the authenticated member.
 * @param document the spreadsheet whose scripts are being accessed.
 * @returns whether the active member owns the spreadsheet in the same team.
 */
export function canDevelopTableScripts(
  user: User,
  document: Document
): boolean {
  return (
    !user.isSuspended &&
    !user.isGuest &&
    user.teamId === document.teamId &&
    user.id === document.createdById
  );
}

/**
 * Requires current ownership in addition to the spreadsheet's access policy.
 *
 * @param user the authenticated member.
 * @param document the spreadsheet whose scripts are being accessed.
 * @throws {AuthorizationError} if the member does not own the spreadsheet.
 */
export function authorizeTableScriptDeveloper(
  user: User,
  document: Document
): void {
  if (!canDevelopTableScripts(user, document)) {
    throw AuthorizationError(
      "Scripts are only available to the spreadsheet owner"
    );
  }
}

/**
 * Reports whether an authenticated, separately deployed runner is configured.
 *
 * @returns whether execution can be offered, along with its time limit.
 */
export function getTableScriptExecutionConfig() {
  const { runnerUrl, runnerToken } = getTableScriptConfig();
  return {
    executionEnabled: !!runnerUrl && !!runnerToken && runnerToken.length >= 32,
    executionSeconds: TableScriptLimits.executionMs / 1000,
  };
}

function runnerUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
