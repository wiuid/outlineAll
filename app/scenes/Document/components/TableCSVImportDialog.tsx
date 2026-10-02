import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import Button from "~/components/Button";
import Modal from "~/components/Modal";
import {
  parseTableCSV,
  TABLE_CSV_MAX_BYTES,
  type TableCSVImport,
} from "~/utils/tableCSVImport";

interface Props {
  editable: boolean;
  onClose: () => void;
  onImport: (data: TableCSVImport, name: string) => Promise<void>;
}

/**
 * Previews a CSV file before importing its text into a new worksheet.
 *
 * @param props the current permission and import operation.
 * @returns the file, encoding, separator and preview dialog.
 */
export function TableCSVImportDialog({ editable, onClose, onImport }: Props) {
  const { t } = useTranslation();
  const [bytes, setBytes] = useState<ArrayBuffer>();
  const [encoding, setEncoding] = useState("utf-8");
  const [delimiter, setDelimiter] = useState("");
  const [name, setName] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      request.current++;
    },
    []
  );

  const preview = useMemo(() => {
    if (!bytes) {
      return undefined;
    }
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      return { data: parseTableCSV(text, delimiter) };
    } catch (err) {
      if (err instanceof TypeError) {
        return {
          error: t("Could not decode this file. Choose another encoding."),
        };
      }
      if (err instanceof Error) {
        switch (err.message) {
          case "CSV files must be smaller than 1 MB.":
            return { error: t("CSV files must be smaller than 1 MB.") };
          case "The CSV contains invalid quotes or incomplete fields.":
            return {
              error: t("The CSV contains invalid quotes or incomplete fields."),
            };
          case "The CSV contains no data.":
            return { error: t("The CSV contains no data.") };
          case "CSV imports support up to 10,000 rows, 256 columns and 50,000 cells.":
            return {
              error: t(
                "CSV imports support up to 10,000 rows, 256 columns and 50,000 cells."
              ),
            };
        }
      }
      return {
        error: t("Could not read this CSV file."),
      };
    }
  }, [bytes, encoding, delimiter, t]);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const version = ++request.current;
    setBytes(undefined);
    setFilename("");
    setLoading(false);
    setError(undefined);
    if (!file) {
      return;
    }
    if (file.size > TABLE_CSV_MAX_BYTES) {
      setError(t("CSV files must be smaller than 1 MB."));
      return;
    }
    setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      if (request.current !== version) {
        return;
      }
      setBytes(buffer);
      setFilename(file.name);
      setName(file.name.replace(/\.(csv|tsv)$/i, "").slice(0, 31));
      setDelimiter(/\.tsv$/i.test(file.name) ? "\t" : "");
    } catch {
      if (request.current === version) {
        setError(t("Could not read this CSV file."));
      }
    } finally {
      if (request.current === version) {
        setLoading(false);
      }
    }
  };

  const handleImport = async () => {
    if (running.current || !editable || !preview?.data || !name.trim()) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onImport(preview.data, name);
      onClose();
    } catch {
      setError(
        t(
          "Could not import this CSV. Check your editing permissions and the workbook size, then try again."
        )
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      title={t("Import CSV")}
      width={720}
      onRequestClose={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <Content aria-busy={busy || loading}>
        <Field>
          {t("File")}
          <input
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
            disabled={busy || loading}
            onChange={handleFileChange}
          />
        </Field>
        {filename && <Filename>{filename}</Filename>}
        <Options>
          <Field>
            {t("Encoding")}
            <select
              value={encoding}
              disabled={busy}
              onChange={(event) => setEncoding(event.target.value)}
            >
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">GB18030 / GBK</option>
              <option value="utf-16le">UTF-16 LE</option>
            </select>
          </Field>
          <Field>
            {t("Separator")}
            <select
              value={delimiter}
              disabled={busy}
              onChange={(event) => setDelimiter(event.target.value)}
            >
              <option value="">{t("Automatic")}</option>
              <option value=",">{t("Comma")}</option>
              <option value={"\t"}>{t("Tab")}</option>
              <option value=";">{t("Semicolon")}</option>
            </select>
          </Field>
        </Options>
        <Field>
          {t("New worksheet name")}
          <input
            value={name}
            maxLength={31}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {preview?.data && (
          <>
            <p role="status">
              {t("{{ rows }} rows, {{ columns }} columns", {
                rows: preview.data.rowCount,
                columns: preview.data.columnCount,
              })}
            </p>
            <Preview>
              <table aria-label={t("CSV preview")}>
                <thead>
                  <tr>
                    {Array.from(
                      { length: Math.min(preview.data.columnCount, 8) },
                      (_, index) => (
                        <th key={index} scope="col">
                          {index + 1}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {preview.data.rows.slice(0, 10).map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {Array.from(
                        { length: Math.min(preview.data?.columnCount ?? 0, 8) },
                        (_, column) => (
                          <td key={column}>
                            {(row[column]?.length ?? 0) > 240
                              ? `${row[column]?.slice(0, 240)}\u2026`
                              : (row[column] ?? "")}
                          </td>
                        )
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Preview>
            {(preview.data.rowCount > 10 || preview.data.columnCount > 8) && (
              <p>{t("Showing the first 10 rows and 8 columns.")}</p>
            )}
          </>
        )}
        {(error || preview?.error) && (
          <ErrorMessage role="alert">{error || preview?.error}</ErrorMessage>
        )}
        <Actions>
          <Button neutral disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={
              busy || loading || !editable || !preview?.data || !name.trim()
            }
            onClick={handleImport}
          >
            {busy ? t("Importing…") : t("Import as new worksheet")}
          </Button>
        </Actions>
      </Content>
    </Modal>
  );
}

const Content = styled.div`
  min-width: 0;
  padding: 24px;
  p {
    font-size: 13px;
    color: ${({ theme }) => theme.textSecondary};
  }
`;
const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  margin-bottom: 14px;
  font-size: 13px;
  input,
  select {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 36px;
    padding: 6px 8px;
    border: 1px solid ${({ theme }) => theme.divider};
    border-radius: 4px;
    color: ${({ theme }) => theme.text};
    background: ${({ theme }) => theme.background};
  }
`;
const Options = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
`;
const Filename = styled.p`
  overflow-wrap: anywhere;
`;
const Preview = styled.div`
  max-height: 260px;
  overflow: auto;
  border: 1px solid ${({ theme }) => theme.divider};
  table {
    border-collapse: collapse;
    table-layout: fixed;
    width: 100%;
    min-width: 320px;
    font-size: 12px;
  }
  th,
  td {
    border: 1px solid ${({ theme }) => theme.divider};
    padding: 6px;
    min-width: 60px;
    max-width: 180px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    vertical-align: top;
  }
  th {
    background: ${({ theme }) => theme.backgroundSecondary};
  }
`;
const ErrorMessage = styled.p`
  color: ${({ theme }) => theme.danger} !important;
`;
const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
`;
