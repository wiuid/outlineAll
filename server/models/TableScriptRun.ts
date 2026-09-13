import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  AllowNull,
  Column,
  DataType,
  Default,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import type { TableScriptRunStatus } from "@shared/types/tableScript";
import Document from "./Document";
import { TableScript } from "./TableScript";
import Team from "./Team";
import User from "./User";
import IdModel from "./base/IdModel";
import Encrypted from "./decorators/Encrypted";

/** Keeps the submitted source and outcome of exactly one script execution. */
@Table({ tableName: "table_script_runs", modelName: "tableScriptRun" })
export class TableScriptRun extends IdModel<
  InferAttributes<TableScriptRun>,
  Partial<InferCreationAttributes<TableScriptRun>>
> {
  @ForeignKey(() => TableScript)
  @Column(DataType.UUID)
  scriptId: string;

  @ForeignKey(() => Document)
  @Column(DataType.UUID)
  documentId: string;

  @ForeignKey(() => Team)
  @Column(DataType.UUID)
  teamId: string;

  @ForeignKey(() => User)
  @AllowNull
  @Column(DataType.UUID)
  actorId: string | null;

  @Column(DataType.INTEGER)
  scriptRevision: number;

  @AllowNull
  @Column(DataType.INTEGER)
  documentRevision: number | null;

  @Column(DataType.BLOB)
  @Encrypted
  source: string;

  @Column(DataType.BLOB)
  @Encrypted
  output: string;

  @Default("queued")
  @Column(DataType.STRING)
  status: TableScriptRunStatus;

  @Column(DataType.STRING)
  trigger: "manual" | "schedule";

  @AllowNull
  @Column(DataType.DATE)
  startedAt: Date | null;

  @AllowNull
  @Column(DataType.DATE)
  finishedAt: Date | null;
}
