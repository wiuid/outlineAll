import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import Button from "~/components/Button";
import Modal from "~/components/Modal";
import Time from "~/components/Time";
import useIsMounted from "~/hooks/useIsMounted";
import useStores from "~/hooks/useStores";
import type Document from "~/models/Document";
import type Revision from "~/models/Revision";
import { tableSaves } from "~/stores/TableSaveCoordinator";

interface Props {
  document: Document;
  revisionId: string;
  editable: boolean;
  onClose: () => void;
  onRestored: () => void;
}

/**
 * Confirms a version replacement against the document revision loaded on opening.
 *
 * @param props the document, selected revision, permissions and completion handlers.
 * @returns the restore confirmation with save, loading and conflict protection.
 */
export function TableRevisionRestoreDialog({
  document,
  revisionId,
  editable,
  onClose,
  onRestored,
}: Props) {
  const { t } = useTranslation();
  const { documents, revisions, policies } = useStores();
  const isMounted = useIsMounted();
  const [revision, setRevision] = useState<Revision>();
  const [lastRevision, setLastRevision] = useState<number>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        await tableSaves.flush(document.id);
        const version = await revisions.fetch(revisionId);
        if (version.documentId !== document.id) {
          throw new Error("Revision does not belong to this document");
        }
        const current = await documents.fetch(document.id, { force: true });
        if (alive) {
          setRevision(version);
          setLastRevision(current.revision);
        }
      } catch {
        if (alive) {
          setError(
            t(
              "Could not prepare this version for restoration. Check that your current changes are saved, then try again."
            )
          );
        }
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [document.id, revisionId, documents, revisions, t]);

  const handleRestore = async () => {
    if (
      running.current ||
      !editable ||
      !revision ||
      lastRevision === undefined ||
      !policies.abilities(document.id).update
    ) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await tableSaves.flush(document.id);
      if (!policies.abilities(document.id).update) {
        throw new Error("This table is read only");
      }
      await document.restore({ revisionId, lastRevision });
      onRestored();
    } catch {
      if (isMounted()) {
        setError(
          t(
            "Could not restore this version. The table may have changed or your editing permission was removed. Reopen this confirmation before trying again."
          )
        );
      }
    } finally {
      running.current = false;
      if (isMounted()) {
        setBusy(false);
      }
    }
  };

  return (
    <Modal
      isOpen
      title={t("Restore version")}
      width={480}
      onRequestClose={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <Content aria-busy={loading || busy}>
        {loading && <p role="status">{t("Loading…")}</p>}
        {revision && (
          <>
            <strong>{revision.title || t("Untitled")}</strong>
            <p>
              <Time dateTime={revision.createdAt} relative={false} /> ·{" "}
              {revision.createdBy?.name}
            </p>
            <p>
              {t(
                "This replaces the current document with the selected version, including all worksheets and cell images. A copy of the current version will be kept in history."
              )}
            </p>
          </>
        )}
        {error && <ErrorMessage role="alert">{error}</ErrorMessage>}
        <Actions>
          <Button neutral disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={
              loading ||
              busy ||
              !editable ||
              !revision ||
              lastRevision === undefined ||
              !!error
            }
            onClick={handleRestore}
          >
            {busy ? t("Restoring…") : t("Restore")}
          </Button>
        </Actions>
      </Content>
    </Modal>
  );
}

const Content = styled.div`
  padding: 24px;
  overflow-wrap: anywhere;
  p {
    color: ${({ theme }) => theme.textSecondary};
    font-size: 14px;
  }
`;
const ErrorMessage = styled.p`
  color: ${({ theme }) => theme.danger} !important;
`;
const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 20px;
`;
