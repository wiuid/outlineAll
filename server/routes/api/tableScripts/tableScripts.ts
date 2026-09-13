import Router from "koa-router";
import { Op } from "sequelize";
import type { z } from "zod";
import {
  createTableScript,
  deleteTableScript,
  getAuthorizedTableScript,
  getTableScriptDocument,
  runTableScript,
  scheduleTableScript,
  updateTableScript,
} from "@server/commands/tableScriptManager";
import { NotFoundError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { TableScript, TableScriptRun } from "@server/models";
import type User from "@server/models/User";
import {
  presentTableScript,
  presentTableScriptRun,
  presentTableScriptSummary,
} from "@server/presenters/tableScript";
import { sequelize } from "@server/storage/database";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import {
  authorizeTableScriptDeveloper,
  canDevelopTableScripts,
  getTableScriptExecutionConfig,
} from "@server/utils/tableScriptConfig";
import { cancelTableScriptExecution } from "@server/utils/tableScriptRunner";
import * as T from "./schema";

const router = new Router();

router.post(
  "tableScripts.capabilities",
  auth(),
  validate(T.TableScriptsDocumentSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsDocumentSchema>>) => {
    const { user } = ctx.state.auth;
    const document = await getTableScriptDocument(
      user,
      ctx.input.body.documentId
    );
    ctx.body = {
      data: {
        canDevelop: canDevelopTableScripts(user, document),
        ...getTableScriptExecutionConfig(),
      },
    };
  }
);

router.post(
  "tableScripts.list",
  auth(),
  validate(T.TableScriptsDocumentSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsDocumentSchema>>) => {
    const { user } = ctx.state.auth;
    const document = await getTableScriptDocument(
      user,
      ctx.input.body.documentId
    );
    authorizeTableScriptDeveloper(user, document);
    const scripts = await TableScript.findAll({
      where: { documentId: document.id, teamId: user.teamId },
      attributes: { exclude: ["source"] },
      order: [["createdAt", "ASC"]],
      limit: 50,
    });
    ctx.body = { data: scripts.map(presentTableScriptSummary) };
  }
);

router.post(
  "tableScripts.info",
  auth(),
  validate(T.TableScriptsIdSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsIdSchema>>) => {
    const script = await getAuthorizedTableScript(
      ctx.state.auth.user,
      ctx.input.body.id
    );
    ctx.body = { data: presentTableScript(script) };
  }
);

router.post(
  "tableScripts.create",
  auth(),
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  validate(T.TableScriptsCreateSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsCreateSchema>>) => {
    const { documentId, name, source } = ctx.input.body;
    const script = await createTableScript(ctx.state.auth.user, documentId, {
      name,
      source,
    });
    ctx.body = { data: presentTableScript(script) };
  }
);

router.post(
  "tableScripts.update",
  auth(),
  validate(T.TableScriptsUpdateSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsUpdateSchema>>) => {
    const { id, lastRevision, name, source } = ctx.input.body;
    const script = await updateTableScript(
      ctx.state.auth.user,
      id,
      lastRevision,
      { name, source }
    );
    ctx.body = { data: presentTableScript(script) };
  }
);

router.post(
  "tableScripts.delete",
  auth(),
  validate(T.TableScriptsRevisionSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsRevisionSchema>>) => {
    const { id, lastRevision } = ctx.input.body;
    await deleteTableScript(ctx.state.auth.user, id, lastRevision);
    ctx.body = { success: true };
  }
);

router.post(
  "tableScripts.schedule",
  auth(),
  validate(T.TableScriptsScheduleSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsScheduleSchema>>) => {
    const { id, lastRevision, enabled, cron, timezone } = ctx.input.body;
    const script = await scheduleTableScript(
      ctx.state.auth.user,
      id,
      lastRevision,
      { enabled, cron, timezone }
    );
    ctx.body = { data: presentTableScript(script) };
  }
);

router.post(
  "tableScripts.run",
  auth(),
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  validate(T.TableScriptsRevisionSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsRevisionSchema>>) => {
    const { id, lastRevision } = ctx.input.body;
    const run = await runTableScript(ctx.state.auth.user, id, lastRevision);
    ctx.body = { data: presentTableScriptRun(run) };
  }
);

router.post(
  "tableScripts.runs",
  auth(),
  validate(T.TableScriptsRunsSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsRunsSchema>>) => {
    const { id, offset, limit } = ctx.input.body;
    await getAuthorizedTableScript(ctx.state.auth.user, id);
    const runs = await TableScriptRun.findAll({
      where: { scriptId: id },
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      offset,
      limit,
    });
    ctx.body = {
      data: runs.map(presentTableScriptRun),
      pagination: { offset, limit },
    };
  }
);

router.post(
  "tableScripts.runInfo",
  auth(),
  validate(T.TableScriptsIdSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsIdSchema>>) => {
    const run = await authorizedRun(ctx.state.auth.user, ctx.input.body.id);
    ctx.body = { data: presentTableScriptRun(run) };
  }
);

router.post(
  "tableScripts.stop",
  auth(),
  validate(T.TableScriptsIdSchema),
  async (ctx: APIContext<z.infer<typeof T.TableScriptsIdSchema>>) => {
    const run = await authorizedRun(ctx.state.auth.user, ctx.input.body.id);
    const cancelRemote = await sequelize.transaction(async (transaction) => {
      await run.reload({ transaction, lock: transaction.LOCK.UPDATE });
      if (run.status === "queued") {
        await run.update(
          { status: "cancelled", finishedAt: new Date() },
          { transaction }
        );
        return false;
      }
      if (run.status !== "running" && run.status !== "stopping") {
        return false;
      }
      await run.update({ status: "stopping" }, { transaction });
      return true;
    });
    if (cancelRemote) {
      await cancelTableScriptExecution(run.id);
      await TableScriptRun.update(
        { status: "cancelled", finishedAt: new Date() },
        {
          where: { id: run.id, status: { [Op.in]: ["running", "stopping"] } },
        }
      );
      await run.reload();
    }
    ctx.body = { data: presentTableScriptRun(run) };
  }
);

async function authorizedRun(user: User, id: string): Promise<TableScriptRun> {
  const run = await TableScriptRun.findOne({
    where: { id, teamId: user.teamId },
  });
  if (!run) {
    throw NotFoundError();
  }
  await getAuthorizedTableScript(user, run.scriptId);
  return run;
}

export default router;
