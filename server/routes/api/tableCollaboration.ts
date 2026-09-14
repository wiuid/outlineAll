import Router from "koa-router";
import { z } from "zod";
import { TABLE_COLLABORATION_LIMIT } from "@shared/utils/tableCollaboration";
import { tableCollaborativeUpdater } from "@server/commands/tableCollaborativeUpdater";
import auth from "@server/middlewares/authentication";
import validate from "@server/middlewares/validate";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import type { APIContext } from "@server/types";
import { zodIdType } from "@server/utils/zod";
import { BaseSchema } from "./schema";

const router = new Router();
const vector = z
  .string()
  .max(128 * 1024)
  .optional();
const info = BaseSchema.extend({
  body: z.object({
    documentId: zodIdType(),
    epoch: z.uuid().optional(),
    vector,
  }),
});
const update = BaseSchema.extend({
  body: z.object({
    documentId: zodIdType(),
    epoch: z.uuid(),
    vector,
    update: z
      .string()
      .min(1)
      .max(Math.ceil((TABLE_COLLABORATION_LIMIT * 4) / 3)),
    title: z.string().max(1000).optional(),
    exclusiveRevision: z.number().int().positive().optional(),
    baseRevision: z.number().int().positive(),
  }),
});

router.post(
  "tableCollaboration.info",
  auth(),
  validate(info),
  async (ctx: APIContext<z.infer<typeof info>>) => {
    ctx.body = {
      data: await tableCollaborativeUpdater(
        ctx.state.auth.user,
        ctx.input.body
      ),
    };
  }
);
router.post(
  "tableCollaboration.update",
  auth(),
  rateLimiter({ requests: 240 }),
  validate(update),
  async (ctx: APIContext<z.infer<typeof update>>) => {
    ctx.body = {
      data: await tableCollaborativeUpdater(
        ctx.state.auth.user,
        ctx.input.body
      ),
    };
  }
);

export default router;
