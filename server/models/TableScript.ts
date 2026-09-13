import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  AllowNull,
  Column,
  DataType,
  Default,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import Document from "./Document";
import Team from "./Team";
import User from "./User";
import ParanoidModel from "./base/ParanoidModel";
import Encrypted from "./decorators/Encrypted";

/** Stores a document's Python source and its optional schedule. */
@Table({ tableName: "table_scripts", modelName: "tableScript" })
export class TableScript extends ParanoidModel<
  InferAttributes<TableScript>,
  Partial<InferCreationAttributes<TableScript>>
> {
  static eventNamespace = "tableScripts";

  @ForeignKey(() => Document)
  @Column(DataType.UUID)
  documentId: string;

  @ForeignKey(() => Team)
  @Column(DataType.UUID)
  teamId: string;

  @ForeignKey(() => User)
  @AllowNull
  @Column(DataType.UUID)
  createdById: string | null;

  @ForeignKey(() => User)
  @AllowNull
  @Column(DataType.UUID)
  scheduledById: string | null;

  @Column(DataType.STRING)
  name: string;

  @Column(DataType.BLOB)
  @Encrypted
  source: string;

  @Default(1)
  @Column(DataType.INTEGER)
  revision: number;

  @AllowNull
  @Column(DataType.STRING)
  cron: string | null;

  @Default("UTC")
  @Column(DataType.STRING)
  timezone: string;

  @Default(false)
  @Column(DataType.BOOLEAN)
  scheduleEnabled: boolean;

  @AllowNull
  @Column(DataType.DATE)
  nextRunAt: Date | null;
}
