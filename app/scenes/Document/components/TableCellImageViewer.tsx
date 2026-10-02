import * as Dialog from "@radix-ui/react-dialog";
import {
  CloseIcon,
  DownloadIcon,
  EditIcon,
  RestoreIcon,
  ShrinkIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "outline-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import styled from "styled-components";
import { toast } from "sonner";
import { depths } from "@shared/styles";
import type { TableCellImage } from "@shared/utils/tableCellImage";
import { sanitizeUrl } from "@shared/utils/urls";
import Button from "~/components/Button";
import useIsMounted from "~/hooks/useIsMounted";
import { getTableCellImageViewScale } from "~/utils/tableCellImage";

interface Props {
  image: TableCellImage;
  destination: string;
  canDownload: boolean;
  onClose: () => void;
  onEdit?: () => void;
}

/**
 * Views cell attachments at their intrinsic aspect ratio without changing the workbook.
 *
 * @param props the attachment, cell address and permitted viewer actions.
 * @returns a full-screen, keyboard-accessible image viewer with native touch gestures.
 */
export function TableCellImageViewer({
  image,
  destination,
  canDownload,
  onClose,
  onEdit,
}: Props) {
  const { t } = useTranslation();
  const isMounted = useIsMounted();
  const transform = useRef<ReactZoomPanPinchRef>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState({
    width: image.width,
    height: image.height,
  });
  const [fitScale, setFitScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    "loading"
  );
  const [attempt, setAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const downloadRunning = useRef(false);
  const downloadAllowed = useRef(canDownload);
  downloadAllowed.current = canDownload;
  const downloadAbort = useRef<AbortController>();
  const source = sanitizeUrl(image.src);

  useEffect(() => () => downloadAbort.current?.abort(), []);

  const handleFit = useCallback(() => {
    transform.current?.centerView(fitScale, 0);
  }, [fitScale]);
  useEffect(handleFit, [handleFit]);

  useEffect(() => {
    if (!stage) {
      return;
    }
    const handleResize = () => {
      const next = getTableCellImageViewScale(
        dimensions.width,
        dimensions.height,
        Math.max(1, stage.clientWidth - 32),
        Math.max(1, stage.clientHeight - 32)
      );
      setFitScale(next);
      transform.current?.centerView(next, 0);
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(stage);
    handleResize();
    return () => observer.disconnect();
  }, [dimensions, stage]);

  const handleDownload = async () => {
    if (!source || !downloadAllowed.current || downloadRunning.current) {
      return;
    }
    downloadRunning.current = true;
    setDownloading(true);
    const abort = new AbortController();
    downloadAbort.current = abort;
    try {
      const response = await fetch(source, {
        credentials: "same-origin",
        signal: abort.signal,
      });
      if (!response.ok) {
        throw new Error(t("Unable to download image"));
      }
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) {
        throw new Error(t("Unable to download image"));
      }
      if (!isMounted() || !downloadAllowed.current) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = image.name || "image";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (isMounted() && !abort.signal.aborted) {
        toast.error(
          error instanceof Error ? error.message : t("Unable to download image")
        );
      }
    } finally {
      downloadRunning.current = false;
      if (isMounted()) {
        setDownloading(false);
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const controls = transform.current;
    if (
      !controls ||
      status !== "loaded" ||
      event.target !== event.currentTarget
    ) {
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      controls.zoomIn();
    } else if (event.key === "-") {
      event.preventDefault();
      controls.zoomOut();
    } else if (event.key === "0") {
      event.preventDefault();
      handleFit();
    } else if (event.key === "1") {
      event.preventDefault();
      controls.centerView(1, 0);
    } else {
      const offsets: Record<string, [number, number]> = {
        ArrowLeft: [40, 0],
        ArrowRight: [-40, 0],
        ArrowUp: [0, 40],
        ArrowDown: [0, -40],
      };
      const offset = offsets[event.key];
      if (offset) {
        event.preventDefault();
        controls.setTransform(
          controls.state.positionX + offset[0],
          controls.state.positionY + offset[1],
          controls.state.scale,
          0
        );
      }
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Viewer aria-describedby={undefined} data-table-image-viewer>
          <Header>
            <Details>
              <Dialog.Title>{image.name || t("Cell image")}</Dialog.Title>
              <span>
                {destination} · {dimensions.width} × {dimensions.height} px
              </span>
            </Details>
            {onEdit && (
              <Button
                neutral
                icon={<EditIcon />}
                aria-label={t("Edit image")}
                tooltip={{ content: t("Edit image") }}
                onClick={onEdit}
              />
            )}
            <Dialog.Close asChild>
              <Button
                neutral
                icon={<CloseIcon />}
                aria-label={t("Close")}
                tooltip={{ content: t("Close") }}
              />
            </Dialog.Close>
          </Header>
          <Stage
            ref={setStage}
            tabIndex={0}
            role="group"
            aria-label={t("Image preview")}
            aria-busy={status === "loading"}
            onKeyDown={handleKeyDown}
            data-table-image-stage
          >
            <TransformWrapper
              ref={transform}
              minScale={Math.min(fitScale, 1)}
              maxScale={8}
              initialScale={fitScale}
              centerOnInit
              disabled={status !== "loaded"}
              doubleClick={{ mode: "toggle", step: 1 }}
              onTransformed={(_, state) => setScale(state.scale)}
              onInit={() => transform.current?.centerView(fitScale, 0)}
            >
              <TransformComponent
                wrapperStyle={{
                  width: "100%",
                  height: "100%",
                  touchAction: "none",
                }}
                contentStyle={{
                  width: dimensions.width,
                  height: dimensions.height,
                }}
              >
                <FullImage
                  key={attempt}
                  src={source}
                  alt={image.name || t("Cell image")}
                  width={dimensions.width}
                  height={dimensions.height}
                  draggable={false}
                  $loaded={status === "loaded"}
                  onLoad={(event) => {
                    setDimensions({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    });
                    setStatus("loaded");
                  }}
                  onError={() => setStatus("error")}
                />
              </TransformComponent>
            </TransformWrapper>
            {status === "loading" && (
              <Status role="status">{t("Loading image…")}</Status>
            )}
            {status === "error" && (
              <Status role="alert">
                <p>{t("Could not load this image.")}</p>
                <Button
                  icon={<RestoreIcon />}
                  onClick={() => {
                    setStatus("loading");
                    setAttempt((value) => value + 1);
                  }}
                >
                  {t("Retry")}
                </Button>
              </Status>
            )}
          </Stage>
          <Tools role="toolbar" aria-label={t("Image tools")}>
            <Button
              neutral
              icon={<ZoomOutIcon />}
              aria-label={t("Zoom out")}
              tooltip={{ content: t("Zoom out") }}
              disabled={status !== "loaded" || scale <= fitScale + 0.001}
              onClick={() => transform.current?.zoomOut()}
            />
            <Zoom aria-live="polite" data-table-image-zoom>
              {Math.round(scale * 100)}%
            </Zoom>
            <Button
              neutral
              icon={<ZoomInIcon />}
              aria-label={t("Zoom in")}
              tooltip={{ content: t("Zoom in") }}
              disabled={status !== "loaded" || scale >= 8}
              onClick={() => transform.current?.zoomIn()}
            />
            <Button
              neutral
              icon={<ShrinkIcon />}
              aria-label={t("Fit to screen")}
              tooltip={{ content: t("Fit to screen") }}
              disabled={status !== "loaded"}
              onClick={handleFit}
            />
            <Button
              neutral
              aria-label={t("Actual size")}
              tooltip={{ content: t("Actual size") }}
              disabled={status !== "loaded"}
              onClick={() => transform.current?.centerView(1, 0)}
            >
              1:1
            </Button>
            {canDownload && (
              <Button
                neutral
                icon={<DownloadIcon />}
                aria-label={t("Download image")}
                tooltip={{ content: t("Download image") }}
                disabled={status !== "loaded" || downloading}
                onClick={handleDownload}
              />
            )}
          </Tools>
        </Viewer>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const Viewer = styled(Dialog.Content)`
  position: fixed;
  inset: 0;
  z-index: ${depths.modal};
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  color: ${({ theme }) => theme.text};
  background: ${({ theme }) => theme.background};
  outline: none;
  button {
    min-width: 40px;
    min-height: 44px;
    flex-shrink: 0;
  }
`;
const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: max(8px, env(safe-area-inset-top)) 12px 8px;
  border-bottom: 1px solid ${({ theme }) => theme.divider};
`;
const Details = styled.div`
  flex: 1;
  min-width: 0;
  h2 {
    margin: 0;
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  span {
    display: block;
    font-size: 12px;
    overflow-wrap: anywhere;
    color: ${({ theme }) => theme.textSecondary};
  }
`;
const Stage = styled.div`
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: ${({ theme }) => theme.backgroundSecondary};
  outline: none;
  &:focus-visible {
    box-shadow: inset 0 0 0 2px ${({ theme }) => theme.inputBorderFocused};
  }
`;
const FullImage = styled.img<{ $loaded: boolean }>`
  display: block;
  max-width: none;
  visibility: ${({ $loaded }) => ($loaded ? "visible" : "hidden")};
  user-select: none;
`;
const Status = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px;
  text-align: center;
`;
const Tools = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 4px max(8px, env(safe-area-inset-bottom));
  border-top: 1px solid ${({ theme }) => theme.divider};
  overflow-x: auto;
`;
const Zoom = styled.output`
  min-width: 48px;
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
`;
