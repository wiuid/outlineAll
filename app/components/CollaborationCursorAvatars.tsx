import { useLayoutEffect, useRef } from "react";
import { createGlobalStyle } from "styled-components";
import {
  createCollaborationAvatar,
  type CollaborationCursorUser,
} from "~/utils/collaborationCursor";

/**
 * Renders editor avatars inside Univer's cell-anchored popup.
 *
 * @param props the people currently editing this cell.
 * @returns noninteractive cursor avatars with shared document styling.
 */
export function CollaborationCursorAvatars({
  users,
}: {
  users: CollaborationCursorUser[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) {
      return;
    }
    container.replaceChildren(...users.map(createCollaborationAvatar));
    const popup = container.closest<HTMLElement>('[data-u-comp="rect-popup"]');
    if (popup) {
      popup.style.pointerEvents = "none";
    }
  }, [users]);
  return <div ref={ref} data-collaboration-cursors aria-hidden="true" />;
}

/** Shared cursor styling for native spreadsheet popups and ProseMirror decorations. */
export const CollaborationCursorStyles = createGlobalStyle`
  [data-collaboration-cursors] {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: min(280px, calc(100vw - 16px));
    pointer-events: none;
  }
  [data-collaboration-avatar] {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    box-sizing: border-box;
    border: 2px solid var(--collaborator-color);
    border-radius: 50%;
    background: ${({ theme }) => theme.background};
    color: ${({ theme }) => theme.text};
    opacity: 0.7;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
    font: 600 12px/1 ${({ theme }) => theme.fontFamily};
    vertical-align: middle;
  }
  [data-collaboration-avatar] > img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  [data-collaboration-cursor] {
    pointer-events: none;
  }
  [data-collaboration-cursor] > [data-collaboration-avatar] {
    position: absolute;
    top: -28px;
    left: 4px;
    z-index: 2;
  }
`;
