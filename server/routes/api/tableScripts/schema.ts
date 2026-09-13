import { z } from "zod";
import { TableScriptLimits } from "@shared/types/tableScript";
import { zodIdType } from "@server/utils/zod";
import { BaseSchema } from "../schema";

/** Selects one document before checking script-development privileges. */
export const TableScriptsDocumentSchema = BaseSchema.extend({
  body: z.object({ documentId: zodIdType() }),
});

/** Selects one script without accepting an actor or team from the client. */
export const TableScriptsIdSchema = BaseSchema.extend({
  body: z.object({ id: z.uuid() }),
});

/** Creates a bounded source file belonging to a table document. */
export const TableScriptsCreateSchema = BaseSchema.extend({
  body: z.object({
    documentId: zodIdType(),
    name: z.string().trim().min(1).max(100),
    source: z.string().max(TableScriptLimits.sourceLength),
  }),
});

/** Requires the displayed script revision for every source update. */
export const TableScriptsUpdateSchema = BaseSchema.extend({
  body: z.object({
    id: z.uuid(),
    lastRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    source: z.string().max(TableScriptLimits.sourceLength),
  }),
});

/** Runs or deletes precisely the revision visible in the editor. */
export const TableScriptsRevisionSchema = BaseSchema.extend({
  body: z.object({ id: z.uuid(), lastRevision: z.number().int().positive() }),
});

/** Stores a basic cron schedule without any automatic retry policy. */
export const TableScriptsScheduleSchema = BaseSchema.extend({
  body: z.object({
    id: z.uuid(),
    lastRevision: z.number().int().positive(),
    enabled: z.boolean(),
    cron: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).max(100),
  }),
});

/** Paginates a script's execution history. */
export const TableScriptsRunsSchema = BaseSchema.extend({
  body: z.object({
    id: z.uuid(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20),
  }),
});
