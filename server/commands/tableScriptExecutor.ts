import { Op } from "sequelize";
import { TableScriptLimits } from "@shared/types/tableScript";
import { getTableDocument } from "@shared/utils/tableDocument";
import { Document, TableScript, TableScriptRun, User } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { can } from "@server/policies";
import { sequelize } from "@server/storage/database";
import { LockHelper } from "@server/storage/LockHelper";
import {
  authorizeTableScriptDeveloper,
  canDevelopTableScripts,
} from "@server/utils/tableScriptConfig";
import { executeTableScript } from "@server/utils/tableScriptRunner";
import { nextTableScriptRun } from "@server/utils/tableScriptSchedule";
import {
  enqueueTableScriptSnapshot,
  getTableScriptDocument,
} from "./tableScriptManager";

/**
 * Advances due schedules once; an outage never replays missed occurrences.
 *
 * @param now the scheduling clock.
 * @returns when the due schedules have been handled.
 */
export async function scheduleDueTableScripts(now = new Date()): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const scripts = await TableScript.findAll({
      where: { scheduleEnabled: true, nextRunAt: { [Op.lte]: now } },
      order: [["nextRunAt", "ASC"]],
      limit: 20,
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
    for (const script of scripts) {
      const actor = script.scheduledById
        ? await User.findByPk(script.scheduledById, { transaction })
        : null;
      const document = actor
        ? await Document.findByPk(script.documentId, {
            userId: actor.id,
            transaction,
          })
        : null;
      if (
        !script.cron ||
        !actor ||
        !document ||
        script.teamId !== document.teamId ||
        !canDevelopTableScripts(actor, document) ||
        !can(actor, "update", document)
      ) {
        await script.update(
          {
            scheduleEnabled: false,
            nextRunAt: null,
            revision: script.revision + 1,
          },
          { transaction }
        );
        continue;
      }
      const nextRunAt = nextTableScriptRun(script.cron, script.timezone, now);
      await script.update({ nextRunAt }, { transaction });
      await enqueueTableScriptSnapshot(
        script,
        actor.id,
        "schedule",
        transaction
      );
    }
  });
}

/**
 * Atomically claims one queued execution, enforcing a shared concurrency limit.
 *
 * @returns the claimed run, or undefined when no execution can start.
 */
export async function claimTableScriptRun(): Promise<
  TableScriptRun | undefined
> {
  return sequelize.transaction(async (transaction) => {
    if (
      !(await LockHelper.tryAcquire(
        sequelize,
        "tableScripts:dispatch",
        transaction
      ))
    ) {
      return undefined;
    }
    const active = await TableScriptRun.count({
      where: { status: { [Op.in]: ["running", "stopping"] } },
      transaction,
    });
    if (active >= TableScriptLimits.concurrency) {
      return undefined;
    }
    const run = await TableScriptRun.findOne({
      where: { status: "queued" },
      order: [["createdAt", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
    if (!run) {
      return undefined;
    }
    await run.update(
      { status: "running", startedAt: new Date() },
      { transaction }
    );
    return run;
  });
}

/**
 * Rechecks the actor's current privileges and executes one claimed source once.
 *
 * @param run the already claimed execution.
 * @returns when the terminal result has been persisted.
 */
export async function performTableScriptRun(
  run: TableScriptRun
): Promise<void> {
  try {
    const actor = run.actorId ? await User.findByPk(run.actorId) : null;
    const script = await TableScript.findByPk(run.scriptId);
    if (
      !actor ||
      !script ||
      actor.teamId !== run.teamId ||
      script.teamId !== run.teamId ||
      script.documentId !== run.documentId
    ) {
      throw new Error("Execution is no longer authorized");
    }
    const document = await getTableScriptDocument(actor, run.documentId);
    authorizeTableScriptDeveloper(actor, document);
    const table = getTableDocument(await DocumentHelper.toJSON(document));
    if (!table) {
      throw new Error("Spreadsheet is no longer available");
    }
    await run.reload();
    if (run.status !== "running") {
      if (run.status === "stopping") {
        await run.update({ status: "cancelled", finishedAt: new Date() });
      }
      return;
    }
    await run.update({ documentRevision: document.revisionCount });
    const result = await executeTableScript({
      id: run.id,
      source: run.source,
      document: {
        id: document.id,
        title: document.title,
        revision: document.revisionCount,
        table,
      },
    });
    await TableScriptRun.update(
      { ...result, finishedAt: new Date() },
      {
        where: { id: run.id, status: { [Op.in]: ["running", "stopping"] } },
      }
    );
  } catch {
    await TableScriptRun.update(
      {
        status: "failed",
        finishedAt: new Date(),
        output:
          "Execution could not complete. Check document permissions and the isolated execution service.",
      },
      { where: { id: run.id, status: { [Op.in]: ["running", "stopping"] } } }
    );
  }
}

/**
 * Closes abandoned runs without rerunning them and expires old console records.
 *
 * @param now the maintenance clock.
 * @returns when stale records have been handled.
 */
export async function expireTableScriptRuns(now = new Date()): Promise<void> {
  await TableScriptRun.update(
    {
      status: "timed_out",
      finishedAt: now,
      output: "Execution exceeded its time limit or its worker stopped.",
    },
    {
      where: {
        status: { [Op.in]: ["running", "stopping"] },
        startedAt: {
          [Op.lt]: new Date(
            now.getTime() - TableScriptLimits.executionMs - 20000
          ),
        },
      },
    }
  );
  await TableScriptRun.destroy({
    where: {
      finishedAt: {
        [Op.lt]: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      },
    },
  });
}
