import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  Column,
  DataType,
  Default,
  ForeignKey,
  Table,
  Unique,
} from "sequelize-typescript";
import Document from "./Document";
import IdModel from "./base/IdModel";

/** Stores the durable Yjs state; its ID is the epoch of the native workbook. */
@Table({ tableName: "table_collaborations", modelName: "tableCollaboration" })
export class TableCollaboration extends IdModel<
  InferAttributes<TableCollaboration>,
  Partial<InferCreationAttributes<TableCollaboration>>
> {
  @ForeignKey(() => Document)
  @Unique
  @Column(DataType.UUID)
  documentId: string;

  @Column(DataType.BLOB)
  state: Buffer;

  @Default(0)
  @Column(DataType.INTEGER)
  barrierRevision: number;
}
