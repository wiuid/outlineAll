import * as Y from "yjs";
import {
  createTableCollaboration,
  encodeTableBytes,
} from "@shared/utils/tableCollaboration";
import { createTableWorkbook, snapshotTable } from "./tableWorkbook";
import { readTableRecovery } from "./tableRecovery";

it("reads both snapshot and collaborative drafts without changing their workbook", () => {
  const workbook = createTableWorkbook("Recovery");
  const doc = createTableCollaboration(workbook);
  try {
    const state = encodeTableBytes(Y.encodeStateAsUpdate(doc));
    expect(
      readTableRecovery(JSON.stringify({ title: "Recovered", state }))?.table
        .workbook.sheets
    ).toMatchObject(workbook.sheets);
    const table = snapshotTable(workbook);
    expect(
      readTableRecovery(JSON.stringify({ title: "Legacy", table }))
    ).toEqual({ title: "Legacy", table });
  } finally {
    doc.destroy();
  }
});

it.each([
  "invalid JSON",
  "{}",
  '{"title":"Broken","state":"invalid"}',
  '{"title":"Broken","table":{}}',
])("ignores unreadable recovery data: %s", (value) => {
  expect(readTableRecovery(value)).toBeUndefined();
});
