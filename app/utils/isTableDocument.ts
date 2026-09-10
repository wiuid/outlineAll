interface DocumentType {
  documentType?: string;
  /** An opaque legacy workbook snapshot; its contents are not inspected. */
  tableData?: unknown;
}

/**
 * Identifies standalone table documents, including legacy snapshot-only records.
 *
 * @param document the document metadata to inspect.
 * @returns whether the document uses the table renderer.
 */
export function isTableDocument(document?: DocumentType | null): boolean {
  return Boolean(
    document &&
    (document.documentType === "table" ||
      (document.tableData !== null && document.tableData !== undefined))
  );
}
