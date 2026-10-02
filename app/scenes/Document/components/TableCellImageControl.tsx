import { EyeIcon, ImageIcon, TrashIcon, ImportIcon } from "outline-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { createPortal } from "react-dom";
import { AttachmentPreset } from "@shared/types";
import { toError } from "@shared/utils/error";
import {
  TableCellImageSchema,
  TableCellImageSizeSchema,
} from "@shared/utils/tableCellImage";
import type { TableCellImageSize } from "@shared/utils/tableCellImage";
import { sanitizeUrl } from "@shared/utils/urls";
import Button from "~/components/Button";
import Modal from "~/components/Modal";
import useIsMounted from "~/hooks/useIsMounted";
import { uploadFile } from "~/utils/files";
import type {
  TableCellImageController,
  TableCellImageTarget,
} from "~/utils/tableCellImage";
import { getDefaultTableCellImageSize } from "~/utils/tableCellImage";
import { TableCellImageViewer } from "./TableCellImageViewer";

interface Props {
  documentId: string;
  editable: boolean;
  ready: boolean;
  workspaceRef: RefObject<HTMLDivElement>;
  getController: () => TableCellImageController | undefined;
  canDownload?: boolean;
  mobile?: boolean;
}

/**
 * Provides upload, screenshot paste, preview, replacement and removal of cell images.
 *
 * @param props the document, permissions and current workbook image operations.
 * @returns an image toolbar button and an accessible preview dialog.
 */
export function TableCellImageControl({
  documentId,
  editable,
  ready,
  workspaceRef,
  getController,
  canDownload = false,
  mobile = false,
}: Props) {
  const { t } = useTranslation();
  const isMounted = useIsMounted();
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const opening = useRef(false);
  const [target, setTarget] = useState<TableCellImageTarget>();
  const [controller, setController] = useState<TableCellImageController>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  const [pendingFile, setPendingFile] = useState<File>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<string>();
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [keepAspect, setKeepAspect] = useState(true);
  const [keepSize, setKeepSize] = useState(true);
  const [editing, setEditing] = useState(false);
  const [selectedImage, setSelectedImage] = useState<TableCellImageTarget>();

  useEffect(() => {
    const size =
      target?.size ??
      (target?.image ? getDefaultTableCellImageSize(target.image) : undefined);
    setWidth(size ? String(size.width) : "");
    setHeight(size ? String(size.height) : "");
    setKeepAspect(true);
  }, [target]);
  useEffect(() => {
    if (!pendingFile) {
      setPendingPreview(undefined);
      return;
    }
    const src = URL.createObjectURL(pendingFile);
    setPendingPreview(src);
    return () => URL.revokeObjectURL(src);
  }, [pendingFile]);
  const size = useMemo(() => {
    const result = TableCellImageSizeSchema.safeParse({
      width: Number(width),
      height: Number(height),
    });
    return result.success ? result.data : undefined;
  }, [width, height]);
  const originalSize =
    target?.size ??
    (target?.image ? getDefaultTableCellImageSize(target.image) : undefined);
  const sizeChanged =
    !!size &&
    (size.width !== originalSize?.width ||
      size.height !== originalSize?.height);

  const handleUpload = useCallback(
    async (
      operations: TableCellImageController,
      destination: TableCellImageTarget,
      file: File
    ) => {
      if (running.current || !editable) {
        return;
      }
      running.current = true;
      setBusy(true);
      setUploading(true);
      setProgress(0);
      setError(undefined);
      setPendingFile(undefined);
      try {
        if (
          ![
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "image/avif",
          ].includes(file.type)
        ) {
          throw new Error(t("Choose a PNG, JPEG, WebP, GIF, or AVIF image."));
        }
        if (file.size > 10 * 1024 * 1024) {
          throw new Error(t("Images must be smaller than 10 MB."));
        }
        const blob = file;
        const dimensions = await measureImage(blob);
        if (
          dimensions.width > 16384 ||
          dimensions.height > 16384 ||
          dimensions.width * dimensions.height > 40_000_000
        ) {
          throw new Error(
            t("Images must be at most 16384 pixels per side and 40 megapixels.")
          );
        }
        const replacement =
          keepSize && destination.size
            ? TableCellImageSizeSchema.safeParse({
                width: destination.size.width,
                height: Math.max(
                  1,
                  Math.round(
                    (destination.size.width * dimensions.height) /
                      dimensions.width
                  )
                ),
              })
            : undefined;
        if (replacement && !replacement.success) {
          throw new Error(
            t(
              "The replacement exceeds the maximum display height at this width."
            )
          );
        }
        if (!isMounted()) {
          return;
        }
        const attachment = await uploadFile(blob, {
          documentId,
          name: file.name,
          preset: AttachmentPreset.DocumentAttachment,
          onProgress: (fraction) => {
            if (isMounted()) {
              setProgress(fraction);
            }
          },
        });
        if (!isMounted()) {
          return;
        }
        const image = TableCellImageSchema.parse({
          attachmentId: attachment.id,
          src: `/api/attachments.redirect?id=${attachment.id}`,
          name: file.name.slice(0, 255),
          ...dimensions,
        });
        const replacementSize = replacement?.success
          ? replacement.data
          : undefined;
        await operations.setImage(destination, image, replacementSize);
        if (isMounted()) {
          setTarget(undefined);
        }
      } catch (err) {
        if (isMounted()) {
          setError(toError(err).message);
        }
      } finally {
        running.current = false;
        if (isMounted()) {
          setBusy(false);
          setUploading(false);
        }
      }
    },
    [documentId, editable, isMounted, keepSize, t]
  );

  const handleOpen = useCallback(
    async (file?: File) => {
      if (running.current || opening.current || !ready) {
        return;
      }
      const operations = getController();
      if (!operations) {
        return;
      }
      opening.current = true;
      try {
        const destination = await operations.getTarget();
        if (!isMounted()) {
          return;
        }
        setController(operations);
        setTarget(destination);
        setEditing(!destination.image || !!file);
        setError(undefined);
        setPreviewFailed(false);
        setPendingFile(undefined);
        setKeepSize(true);
        if (file && editable) {
          if (destination.occupied || destination.image) {
            setPendingFile(file);
          } else {
            await handleUpload(operations, destination, file);
          }
        }
      } catch (err) {
        if (isMounted()) {
          toast.error(toError(err).message);
        }
      } finally {
        opening.current = false;
      }
    },
    [editable, getController, handleUpload, isMounted, ready]
  );

  useEffect(() => {
    const operations = getController();
    if (!ready || !operations?.getSelectedImage) {
      setSelectedImage(undefined);
      return;
    }
    let frame = 0;
    const handleSelection = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (isMounted()) {
          setSelectedImage(operations.getSelectedImage?.());
        }
      });
    };
    handleSelection();
    const unsubscribe = operations.subscribeSelection?.(handleSelection);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe?.();
    };
  }, [documentId, getController, isMounted, ready]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || mobile || !ready) {
      return;
    }
    const handleDoubleClick = (event: MouseEvent) => {
      if (
        !(event.target instanceof HTMLCanvasElement) ||
        !getController()?.getSelectedImage?.()
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      void handleOpen();
    };
    workspace.addEventListener("dblclick", handleDoubleClick, true);
    return () =>
      workspace.removeEventListener("dblclick", handleDoubleClick, true);
  }, [getController, handleOpen, mobile, ready, workspaceRef]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    return getController()?.subscribeViewRequest?.(() => void handleOpen());
  }, [documentId, getController, handleOpen, ready]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !editable || !ready) {
      return;
    }
    const ownerDocument = workspace.ownerDocument;
    let ownsSelection = workspace.contains(ownerDocument.activeElement);
    const handleFocus = (event: Event) => {
      if (event.target instanceof Node && event.target !== ownerDocument.body) {
        ownsSelection = workspace.contains(event.target);
      }
    };
    const handlePaste = (event: ClipboardEvent) => {
      const element = event.target;
      if (
        running.current ||
        opening.current ||
        (!ownsSelection &&
          !(element instanceof Node && workspace.contains(element))) ||
        (element instanceof Element &&
          element.closest("input, textarea, [contenteditable='true']") &&
          !element.closest("[data-u-comp='editor']"))
      ) {
        return;
      }
      const file = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();
      if (!file) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void handleOpen(file);
    };
    ownerDocument.addEventListener("pointerdown", handleFocus, true);
    ownerDocument.addEventListener("focusin", handleFocus, true);
    ownerDocument.addEventListener("paste", handlePaste, true);
    return () => {
      ownerDocument.removeEventListener("pointerdown", handleFocus, true);
      ownerDocument.removeEventListener("focusin", handleFocus, true);
      ownerDocument.removeEventListener("paste", handlePaste, true);
    };
  }, [editable, handleOpen, ready, workspaceRef]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !target || !controller || !editable) {
      return;
    }
    if (target.occupied || target.image) {
      setPendingFile(file);
      return;
    }
    void handleUpload(controller, target, file);
  };

  const handleRemove = async () => {
    if (!target || !controller || running.current || !editable) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await controller.setImage(target, null);
      if (isMounted()) {
        setTarget(undefined);
      }
    } catch (err) {
      if (isMounted()) {
        setError(toError(err).message);
      }
    } finally {
      running.current = false;
      if (isMounted()) {
        setBusy(false);
      }
    }
  };

  const handleResize = async (dimensions: TableCellImageSize | null) => {
    if (
      !target?.image ||
      !controller ||
      running.current ||
      !editable ||
      !ready
    ) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await controller.setImage(
        target,
        target.image,
        dimensions
      );
      if (isMounted()) {
        setTarget(updated);
      }
    } catch (err) {
      if (isMounted()) {
        setError(toError(err).message);
      }
    } finally {
      running.current = false;
      if (isMounted()) {
        setBusy(false);
      }
    }
  };
  const handleWidthChange = (event: ChangeEvent<HTMLInputElement>) => {
    setWidth(event.target.value);
    if (keepAspect && target?.image && event.target.value) {
      setHeight(
        String(
          Math.max(
            1,
            Math.round(
              (Number(event.target.value) * target.image.height) /
                target.image.width
            )
          )
        )
      );
    }
  };
  const handleHeightChange = (event: ChangeEvent<HTMLInputElement>) => {
    setHeight(event.target.value);
    if (keepAspect && target?.image && event.target.value) {
      setWidth(
        String(
          Math.max(
            1,
            Math.round(
              (Number(event.target.value) * target.image.width) /
                target.image.height
            )
          )
        )
      );
    }
  };

  return (
    <>
      <Button
        icon={<ImageIcon />}
        neutral
        borderOnHover
        aria-label={t("Cell image")}
        tooltip={{ content: t("Cell image") }}
        disabled={!ready || busy}
        onClick={() => void handleOpen()}
      />
      {selectedImage &&
        !target &&
        workspaceRef.current &&
        createPortal(
          <SelectionViewButton
            neutral
            icon={<EyeIcon />}
            aria-label={t("View image")}
            tooltip={{ content: t("View image") }}
            disabled={!ready || busy}
            onClick={() => void handleOpen()}
            data-table-image-selection-action
          >
            {t("View image")}
          </SelectionViewButton>,
          workspaceRef.current
        )}
      {target?.image && !editing && !pendingFile && (
        <TableCellImageViewer
          key={`${target.image.attachmentId}:${target.image.src}`}
          image={target.image}
          destination={`${target.sheetName ?? ""} · ${target.address ?? `${target.row + 1}, ${target.column + 1}`}`}
          canDownload={canDownload}
          onClose={() => setTarget(undefined)}
          onEdit={editable ? () => setEditing(true) : undefined}
        />
      )}
      <Modal
        isOpen={!!target && (editing || !target.image || !!pendingFile)}
        title={t("Cell image")}
        width={640}
        onRequestClose={() => {
          if (!running.current) {
            setTarget(undefined);
            setPendingFile(undefined);
          }
        }}
      >
        <Content>
          {(target?.image || pendingPreview) && (
            <Previews $replacement={!!pendingPreview}>
              {target?.image && (
                <Preview
                  src={sanitizeUrl(target.image.src)}
                  alt={target.image.name}
                  $size={
                    pendingFile
                      ? target.size
                      : (size ?? target.size ?? target.image)
                  }
                  onError={() => setPreviewFailed(true)}
                />
              )}
              {pendingPreview && pendingFile && (
                <Preview src={pendingPreview} alt={pendingFile.name} />
              )}
            </Previews>
          )}
          {pendingFile && <Filename>{pendingFile.name}</Filename>}
          {previewFailed && (
            <Message role="alert">{t("Could not load this image.")}</Message>
          )}
          {error && <Message role="alert">{error}</Message>}
          {uploading && (
            <UploadProgress
              aria-label={t("Uploading image")}
              max={1}
              value={progress}
            />
          )}
          {busy && !uploading && <p role="status">{t("Saving image…")}</p>}
          {pendingFile && (
            <>
              <p>
                {target?.image
                  ? t("Replace the image in this cell?")
                  : t(
                      "Replace the text or formula in this cell with an image?"
                    )}
              </p>
              {target?.image && target.size && (
                <label>
                  <input
                    type="checkbox"
                    checked={keepSize}
                    disabled={busy}
                    onChange={(event) => setKeepSize(event.target.checked)}
                  />{" "}
                  {t("Keep display width")}
                </label>
              )}
              <Actions>
                <Button
                  danger
                  disabled={busy || !editable}
                  onClick={() => {
                    if (controller && target) {
                      void handleUpload(controller, target, pendingFile);
                    }
                  }}
                >
                  {t("Replace")}
                </Button>
                <Button
                  neutral
                  disabled={busy}
                  onClick={() => setPendingFile(undefined)}
                >
                  {t("Cancel")}
                </Button>
              </Actions>
            </>
          )}
          {editable && target?.image && !pendingFile && (
            <SizeControls>
              <SizeFields>
                <label>
                  {t("Width (px)")}
                  <SizeInput
                    type="number"
                    min={1}
                    max={2048}
                    step={1}
                    aria-label={t("Width (px)")}
                    value={width}
                    disabled={busy || !ready}
                    onChange={handleWidthChange}
                  />
                </label>
                <label>
                  {t("Height (px)")}
                  <SizeInput
                    type="number"
                    min={1}
                    max={2048}
                    step={1}
                    aria-label={t("Height (px)")}
                    value={height}
                    disabled={busy || !ready}
                    onChange={handleHeightChange}
                  />
                </label>
              </SizeFields>
              <label>
                <input
                  type="checkbox"
                  checked={keepAspect}
                  disabled={busy}
                  onChange={(event) => {
                    setKeepAspect(event.target.checked);
                    if (event.target.checked && target.image && width) {
                      setHeight(
                        String(
                          Math.max(
                            1,
                            Math.round(
                              (Number(width) * target.image.height) /
                                target.image.width
                            )
                          )
                        )
                      );
                    }
                  }}
                />{" "}
                {t("Keep aspect ratio")}
              </label>
              {!size && (
                <Message role="alert">
                  {t(
                    "Image dimensions must be whole numbers between 1 and 2048 pixels."
                  )}
                </Message>
              )}
              <Actions>
                <Button
                  disabled={busy || !ready || !size || !sizeChanged}
                  onClick={() => {
                    if (size) {
                      void handleResize(size);
                    }
                  }}
                >
                  {t("Apply size")}
                </Button>
                <Button
                  neutral
                  disabled={busy || !ready || !target.size}
                  onClick={() => void handleResize(null)}
                >
                  {t("Reset image size")}
                </Button>
              </Actions>
            </SizeControls>
          )}
          {editable && !pendingFile && (
            <Actions>
              {target?.image && (
                <Button
                  neutral
                  icon={<EyeIcon />}
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  {t("View image")}
                </Button>
              )}
              <Button
                icon={<ImportIcon />}
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                {target?.image ? t("Replace image") : t("Upload image")}
              </Button>
              {target?.image && (
                <Button
                  icon={<TrashIcon />}
                  neutral
                  danger
                  disabled={busy}
                  onClick={() => void handleRemove()}
                >
                  {t("Remove image")}
                </Button>
              )}
            </Actions>
          )}
          {!editable && !target?.image && <p>{t("This cell has no image.")}</p>}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            hidden
            onChange={handleFileChange}
          />
        </Content>
      </Modal>
    </>
  );
}

async function measureImage(
  blob: Blob
): Promise<{ width: number; height: number }> {
  const src = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = src;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(src);
  }
}

const Content = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
`;
const SelectionViewButton = styled(Button)`
  position: absolute;
  right: 12px;
  bottom: calc(56px + env(safe-area-inset-bottom));
  z-index: 110;
  min-height: 44px;
  background: ${({ theme }) => theme.background};
  border: 1px solid ${({ theme }) => theme.divider};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
`;
const Preview = styled.img<{ $size?: TableCellImageSize }>`
  display: block;
  width: ${({ $size }) =>
    $size
      ? `min(100%, ${$size.width}px, calc(min(35dvh, 280px) * ${$size.width / $size.height}))`
      : "100%"};
  height: ${({ $size }) => ($size ? "auto" : "min(35dvh, 280px)")};
  aspect-ratio: ${({ $size }) =>
    $size ? `${$size.width} / ${$size.height}` : "auto"};
  object-fit: ${({ $size }) => ($size ? "fill" : "contain")};
`;
const Previews = styled.div<{ $replacement: boolean }>`
  display: grid;
  grid-template-columns: ${({ $replacement }) =>
    $replacement ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)"};
  gap: 12px;
  height: min(35dvh, 280px);
  place-items: center;
`;
const Filename = styled.p`
  margin: 0;
  overflow-wrap: anywhere;
`;
const SizeControls = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;
const SizeFields = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  label {
    min-width: 0;
  }
`;
const SizeInput = styled.input`
  display: block;
  width: 100%;
  min-height: 36px;
  margin-top: 4px;
  padding: 4px 8px;
  color: ${({ theme }) => theme.text};
  background: ${({ theme }) => theme.background};
  border: 1px solid ${({ theme }) => theme.divider};
  border-radius: 4px;
`;
const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;
const Message = styled.p`
  color: ${({ theme }) => theme.danger};
  overflow-wrap: anywhere;
`;
const UploadProgress = styled.progress`
  width: 100%;
`;
