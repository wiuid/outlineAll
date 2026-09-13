import { Op } from "sequelize";
import type { Transaction } from "sequelize";
import { TableScriptLimits } from "@shared/types/tableScript";
import { getTableDocument } from "@shared/utils/tableDocument";
import {
  NotFoundError,
  TableScriptConflictError,
  TableScriptUnavailableError,
  ValidationError,
} from "@server/errors";
import { Document, TableScript, TableScriptRun } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import type User from "@server/models/User";
import { authorize } from "@server/policies";
import { sequelize } from "@server/storage/database";
import { LockHelper } from "@server/storage/LockHelper";
import {
  authorizeTableScriptDeveloper,
  getTableScriptExecutionConfig,
} from "@server/utils/tableScriptConfig";
import { nextTableScriptRun } from "@server/utils/tableScriptSchedule";

/** Source fields accepted by script creation and update commands. */
export interface TableScriptSourceInput {
  name: string;
  source: string;
}

/** The states that reserve an execution slot for a script. */
export const activeTableScriptStates = ["queued", "running", "stopping"];

/**
 * Resolves a table only after checking the member's document permissions.
 *
 * @param user the current member.
 * @param id the document UUID or slug.
 * @param transaction the optional database transaction.
 * @returns the authorized table document.
 * @throws {ValidationError} if the document is not a table.
 */
export async function getTableScriptDocument(
  user: User,
  id: string,
  transaction?: Transaction
): Promise<Document> {
  const document = await Document.findByPk(id, {
    userId: user.id,
    transaction,
  });
  authorize(user, "update", document);
  if (!document || !getTableDocument(await DocumentHelper.toJSON(document))) {
    throw ValidationError("Scripts are available for spreadsheet documents");
  }
  return document;
}

/**
 * Resolves a script after checking current spreadsheet ownership and access.
 *
 * @param user the current member.
 * @param id the script UUID.
 * @param transaction the optional transaction, which also locks the script.
 * @returns the authorized script.
 * @throws {NotFoundError} if the script is absent from the member's team.
 */
export async function getAuthorizedTableScript(
  user: User,
  id: string,
  transaction?: Transaction
): Promise<TableScript> {
  const script = await TableScript.findOne({
    where: { id, teamId: user.teamId },
    transaction,
    ...(transaction && { lock: transaction.LOCK.UPDATE }),
  });
  if (!script) {
    throw NotFoundError();
  }
  const document = await getTableScriptDocument(
    user,
    script.documentId,
    transaction
  );
  authorizeTableScriptDeveloper(user, document);
  return script;
}

/**
 * Creates an encrypted Python source file without changing the workbook.
 *
 * @param user the developer.
 * @param documentId the containing document.
 * @param input the source and display name.
 * @returns the saved script.
 * @throws {ValidationError} if the document's script limit has been reached.
 */
export async function createTableScript(
  user: User,
  documentId: string,
  input: TableScriptSourceInput
): Promise<TableScript> {
  return sequelize.transaction(async (transaction) => {
    const document = await getTableScriptDocument(
      user,
      documentId,
      transaction
    );
    authorizeTableScriptDeveloper(user, document);
    await LockHelper.acquire(
      sequelize,
      `tableScripts:create:${document.id}`,
      transaction
    );
    const count = await TableScript.count({
      where: { documentId: document.id },
      transaction,
    });
    if (count >= TableScriptLimits.scriptsPerDocument) {
      throw ValidationError("This spreadsheet has reached its script limit");
    }
    return TableScript.create(
      {
        ...input,
        documentId: document.id,
        teamId: user.teamId,
        createdById: user.id,
        scheduledById: null,
        revision: 1,
        cron: null,
        timezone: "UTC",
        scheduleEnabled: false,
        nextRunAt: null,
      },
      { transaction }
    );
  });
}

/**
 * Saves source against the revision displayed by the editor.
 *
 * @param user the developer.
 * @param id the script UUID.
 * @param revision the expected revision.
 * @param input the source and display name.
 * @returns the saved script and incremented revision.
 * @throws {TableScriptConflictError} if another editor has already saved.
 */
export async function updateTableScript(
  user: User,
  id: string,
  revision: number,
  input: TableScriptSourceInput
): Promise<TableScript> {
  return sequelize.transaction(async (transaction) => {
    const script = await getAuthorizedTableScript(user, id, transaction);
    checkRevision(script, revision);
    return script.update(
      { ...input, revision: script.revision + 1 },
      { transaction }
    );
  });
}

/**
 * Enables or pauses a five-field cron schedule owned by the current developer.
 *
 * @param user the developer responsible for scheduled executions.
 * @param id the script UUID.
 * @param revision the expected revision.
 * @param schedule the cron expression, timezone and enabled state.
 * @returns the saved schedule and incremented revision.
 */
export async function scheduleTableScript(
  user: User,
  id: string,
  revision: number,
  schedule: { enabled: boolean; cron: string; timezone: string }
): Promise<TableScript> {
  const next = nextTableScriptRun(schedule.cron, schedule.timezone);
  return sequelize.transaction(async (transaction) => {
    const script = await getAuthorizedTableScript(user, id, transaction);
    checkRevision(script, revision);
    if (schedule.enabled) {
      requireTableScriptRunner();
    }
    return script.update(
      {
        cron: schedule.cron,
        timezone: schedule.timezone,
        scheduleEnabled: schedule.enabled,
        scheduledById: user.id,
        nextRunAt: schedule.enabled ? next : null,
        revision: script.revision + 1,
      },
      { transaction }
    );
  });
}

/**
 * Deletes an idle script and disables its schedule in the same transaction.
 *
 * @param user the developer.
 * @param id the script UUID.
 * @param revision the expected revision.
 * @throws {ValidationError} if the script still has an active execution.
 */
export async function deleteTableScript(
  user: User,
  id: string,
  revision: number
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const script = await getAuthorizedTableScript(user, id, transaction);
    checkRevision(script, revision);
    const active = await TableScriptRun.count({
      where: { scriptId: id, status: { [Op.in]: activeTableScriptStates } },
      transaction,
    });
    if (active) {
      throw ValidationError(
        "Stop the active execution before deleting this script"
      );
    }
    await script.update(
      { scheduleEnabled: false, nextRunAt: null },
      { transaction }
    );
    await script.destroy({ transaction });
  });
}

/**
 * Enqueues one immutable source revision for a manual run, without retries.
 *
 * @param user the developer whose document access will be rechecked at execution.
 * @param id the script UUID.
 * @param revision the expected script revision.
 * @returns the durable, queued execution record.
 */
export async function runTableScript(
  user: User,
  id: string,
  revision: number
): Promise<TableScriptRun> {
  return sequelize.transaction(async (transaction) => {
    const script = await getAuthorizedTableScript(user, id, transaction);
    checkRevision(script, revision);
    requireTableScriptRunner();
    const run = await enqueueTableScriptSnapshot(
      script,
      user.id,
      "manual",
      transaction
    );
    if (!run) {
      throw ValidationError(
        "This script is already running or the execution queue is full"
      );
    }
    return run;
  });
}

/**
 * Reserves a single pending execution while holding the script's row lock.
 *
 * @param script the locked script and source to snapshot.
 * @param actorId the member responsible for the run.
 * @param trigger whether the run is manual or scheduled.
 * @param transaction the transaction holding the script lock.
 * @returns the execution, or undefined when a resource limit prevents queuing.
 */
export async function enqueueTableScriptSnapshot(
  script: TableScript,
  actorId: string,
  trigger: "manual" | "schedule",
  transaction: Transaction
): Promise<TableScriptRun | undefined> {
  await LockHelper.acquire(sequelize, "tableScripts:queue", transaction);
  const active = await TableScriptRun.count({
    where: {
      scriptId: script.id,
      status: { [Op.in]: activeTableScriptStates },
    },
    transaction,
  });
  const queued = await TableScriptRun.count({
    where: { status: "queued" },
    transaction,
  });
  if (active || queued >= 100) {
    return undefined;
  }
  return TableScriptRun.create(
    {
      scriptId: script.id,
      documentId: script.documentId,
      teamId: script.teamId,
      actorId,
      scriptRevision: script.revision,
      documentRevision: null,
      source: script.source,
      output: "",
      trigger,
      status: "queued",
      startedAt: null,
      finishedAt: null,
    },
    { transaction }
  );
}

/**
 * Rejects execution until a separate authenticated runner has been configured.
 *
 * @throws {TableScriptUnavailableError} if execution is unavailable.
 */
export function requireTableScriptRunner(): void {
  if (!getTableScriptExecutionConfig().executionEnabled) {
    throw TableScriptUnavailableError();
  }
}

function checkRevision(script: TableScript, revision: number): void {
  if (script.revision !== revision) {
    throw TableScriptConflictError();
  }
}
