import { sanitizeUrl } from "@shared/utils/urls";

/** Public display information for a remote editing cursor. */
export interface CollaborationCursorUser {
  id: string;
  name: string;
  color: string;
  avatarUrl?: string | null;
}

/**
 * Builds a noninteractive avatar usable by both canvas popups and text cursors.
 *
 * @param user the remote editor's display information.
 * @returns an avatar with a text fallback and a sanitized image source.
 */
export function createCollaborationAvatar(
  user: CollaborationCursorUser
): HTMLSpanElement {
  const avatar = document.createElement("span");
  avatar.dataset.collaborationAvatar = user.id;
  avatar.setAttribute("aria-hidden", "true");
  avatar.style.setProperty(
    "--collaborator-color",
    /^#[\da-f]{6}$/i.test(user.color) ? user.color : "#2563eb"
  );
  const initial = document.createElement("span");
  initial.textContent =
    typeof user.name === "string"
      ? (Array.from(user.name)[0]?.toLocaleUpperCase() ?? "")
      : "";
  avatar.append(initial);
  const src = sanitizeUrl(
    typeof user.avatarUrl === "string" ? user.avatarUrl : undefined
  );
  if (src) {
    const image = document.createElement("img");
    image.alt = "";
    image.draggable = false;
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = src;
    avatar.append(image);
  }
  return avatar;
}

/**
 * Positions text cursor avatars outside the input line, separating nearby editors.
 *
 * @param root the ProseMirror editing surface containing cursor decorations.
 * @returns a refresh callback and cleanup for scrolling and size observations.
 */
export function observeCollaborationCursors(root: HTMLElement) {
  let frame = 0;
  let disposed = false;
  const refresh = () => {
    if (disposed || frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      const placed: { left: number; top: number }[] = [];
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      for (const anchor of root.querySelectorAll<HTMLElement>(
        "[data-collaboration-cursor]"
      )) {
        const avatar = anchor.querySelector<HTMLElement>(
          "[data-collaboration-avatar]"
        );
        if (!avatar) {
          continue;
        }
        const rect = anchor.getBoundingClientRect();
        const visible =
          rect.bottom > 0 &&
          rect.top < height &&
          rect.right >= 0 &&
          rect.left < width;
        avatar.style.visibility = visible ? "visible" : "hidden";
        if (!visible) {
          continue;
        }
        const baseLeft = Math.min(Math.max(4, rect.right + 4), width - 28);
        const baseTop = rect.top >= 28 ? rect.top - 28 : rect.bottom + 4;
        let left = baseLeft;
        let top = baseTop;
        let found = false;
        for (let row = 0; row <= placed.length && !found; row++) {
          for (
            let column = 0;
            column <= placed.length * 2 && !found;
            column++
          ) {
            const offset = Math.ceil(column / 2) * (column % 2 ? 28 : -28);
            left = baseLeft + offset;
            top = baseTop + Math.ceil(row / 2) * (row % 2 ? -28 : 28);
            found =
              left >= 4 &&
              left <= width - 28 &&
              top >= 4 &&
              top <= height - 28 &&
              !placed.some(
                (position) =>
                  Math.abs(position.left - left) < 26 &&
                  Math.abs(position.top - top) < 26
              );
          }
        }
        if (!found) {
          avatar.style.visibility = "hidden";
          continue;
        }
        placed.push({ left, top });
        avatar.style.left = `${left - rect.left}px`;
        avatar.style.top = `${top - rect.top}px`;
      }
    });
  };
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(refresh);
  observer?.observe(root);
  window.addEventListener("scroll", refresh, true);
  window.addEventListener("resize", refresh);
  refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    },
  };
}

/**
 * Publishes editing only while the input surface and browser are active.
 *
 * @param isEditing whether the editor currently has an editable input focus.
 * @param onChange the callback for a change between editing and viewing.
 * @returns a refresh callback and cleanup for browser activity listeners.
 */
export function observeCollaborationActivity(
  isEditing: () => boolean,
  onChange: (editing: boolean) => void
) {
  let previous: boolean | undefined;
  let disposed = false;
  const refresh = () => {
    if (disposed) {
      return;
    }
    const editing = !document.hidden && document.hasFocus() && isEditing();
    if (editing !== previous) {
      previous = editing;
      onChange(editing);
    }
  };
  const handleFocus = () => queueMicrotask(refresh);
  window.addEventListener("focus", handleFocus);
  window.addEventListener("blur", handleFocus);
  document.addEventListener("visibilitychange", refresh);
  document.addEventListener("focusin", handleFocus);
  document.addEventListener("focusout", handleFocus);
  refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleFocus);
      document.removeEventListener("visibilitychange", refresh);
      document.removeEventListener("focusin", handleFocus);
      document.removeEventListener("focusout", handleFocus);
    },
  };
}
