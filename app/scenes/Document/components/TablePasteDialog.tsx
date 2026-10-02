import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import Button from "~/components/Button";
import Modal from "~/components/Modal";
import { parseTableCSV } from "~/utils/tableCSVImport";
import type { TablePastePreview, TablePasteTarget } from "~/utils/tablePaste";

interface Props {
  target: TablePasteTarget;
  initialText?: string;
  editable: boolean;
  onClose: () => void;
}

/**
 * Previews clipboard text and confirms replacement at a captured destination.
 *
 * @param props the paste destination, initial clipboard text and permission.
 * @returns a text input and a guarded multi-cell paste confirmation.
 */
export function TablePasteDialog({
  target,
  initialText = "",
  editable,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [preview, setPreview] = useState<TablePastePreview>();
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const parsed = useMemo(() => {
    if (!text) {
      return undefined;
    }
    try {
      return parseTableCSV(text, "\t");
    } catch {
      return undefined;
    }
  }, [text]);

  const handlePreview = () => {
    if (!editable || !parsed) {
      return;
    }
    try {
      setPreview(target.prepare(parsed));
      setError(undefined);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("Could not prepare this paste.")
      );
    }
  };
  const handlePaste = async () => {
    if (
      !editable ||
      !preview ||
      running.current ||
      (preview.occupiedCells > 0 && !replace)
    ) {
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      await preview.apply();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("Could not paste this data.")
      );
      setPreview(undefined);
      setReplace(false);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      title={t("Paste data")}
      width={640}
      onRequestClose={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <Content>
        <label>
          {t("Data")}
          <TextInput
            aria-label={t("Data")}
            value={text}
            disabled={busy || !!preview}
            onChange={(event) => {
              setText(event.target.value);
              setError(undefined);
            }}
          />
        </label>
        {text && !parsed && (
          <p role="alert">
            {t(
              "Invalid data. Paste up to 1 MB, 10,000 rows, 256 columns and 50,000 cells of tab-separated text."
            )}
          </p>
        )}
        {parsed && (
          <p>
            {t("{{ rows }} rows × {{ columns }} columns", {
              rows: parsed.rowCount,
              columns: parsed.columnCount,
            })}
          </p>
        )}
        {parsed && (
          <PreviewScroll>
            <table aria-label={t("Paste preview")}>
              <tbody>
                {parsed.rows.slice(0, 6).map((row, index) => (
                  <tr key={index}>
                    {Array.from(
                      { length: Math.min(parsed.columnCount, 6) },
                      (_, column) => (
                        <td key={column}>{row[column] ?? ""}</td>
                      )
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </PreviewScroll>
        )}
        {preview && <p>{preview.destination}</p>}
        {preview && preview.occupiedCells > 0 && (
          <label>
            <input
              type="checkbox"
              checked={replace}
              disabled={busy}
              onChange={(event) => setReplace(event.target.checked)}
            />{" "}
            {t("Replace {{ count }} nonempty cells", {
              count: preview.occupiedCells,
            })}
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <Actions>
          <Button neutral disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          {preview && (
            <Button
              neutral
              disabled={busy}
              onClick={() => {
                setPreview(undefined);
                setReplace(false);
              }}
            >
              {t("Back")}
            </Button>
          )}
          <Button
            disabled={
              !editable ||
              busy ||
              !parsed ||
              (!!preview && preview.occupiedCells > 0 && !replace)
            }
            onClick={preview ? handlePaste : handlePreview}
          >
            {preview ? t("Paste") : t("Preview")}
          </Button>
        </Actions>
      </Content>
    </Modal>
  );
}

const Content = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 24px 24px;
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
`;
const TextInput = styled.textarea`
  display: block;
  width: 100%;
  min-height: 120px;
  margin-top: 8px;
  padding: 8px;
  color: ${({ theme }) => theme.text};
  background: ${({ theme }) => theme.background};
  border: 1px solid ${({ theme }) => theme.divider};
  border-radius: 4px;
  resize: vertical;
`;
const PreviewScroll = styled.div`
  overflow: auto;
  max-height: 180px;
  table {
    border-collapse: collapse;
  }
  td {
    border: 1px solid ${({ theme }) => theme.divider};
    padding: 4px 8px;
    min-width: 64px;
    max-width: 180px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
`;
const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
`;
