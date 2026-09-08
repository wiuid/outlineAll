export const MOBILE_SHEET_GESTURE_MEDIA_QUERY =
  "(pointer: coarse) and (max-width: 768px)";

const DEFAULT_LONG_PRESS_DELAY = 200;
const PRE_LONG_PRESS_MOVE_TOLERANCE = 8;
const CLICK_SUPPRESSION_MS = 500;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

type Point = {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  target: HTMLCanvasElement;
  captured: boolean;
};

type GestureMode = "pending" | "single-pan" | "multi-touch";

type Options = {
  root: HTMLElement;
  scrollBy: (offsetX: number, offsetY: number) => void;
  getZoom: () => number;
  setZoom: (zoom: number) => void;
  isEditing: () => boolean;
  longPressDelay?: number;
};

function isTouchOnCanvas(event: PointerEvent): event is PointerEvent & {
  target: HTMLCanvasElement;
} {
  return (
    event.pointerType === "touch" && event.target instanceof HTMLCanvasElement
  );
}

function midpoint(first: Point, second: Point) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function distance(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function consume(event: Event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Adds touch gestures around Univer's canvas. Pixel panning uses Univer's
 * SetScrollRelativeCommand through the callback; zoom uses the worksheet facade.
 * A synthetic pointercancel is sent when ownership changes so Univer's selection
 * drag state cannot leak into the gesture. Pointerdown is otherwise untouched,
 * preserving Univer's native tap-to-select behavior.
 */
export function installMobileSheetGestures({
  root,
  scrollBy,
  getZoom,
  setZoom,
  isEditing,
  longPressDelay = DEFAULT_LONG_PRESS_DELAY,
}: Options) {
  const mediaQuery = window.matchMedia(MOBILE_SHEET_GESTURE_MEDIA_QUERY);
  const points = new Map<number, Point>();
  let mode: GestureMode = "pending";
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let initialPinchDistance = 0;
  let initialPinchZoom = 1;
  let currentGestureZoom = 1;
  let lastMidpoint = { x: 0, y: 0 };
  let pinchCanvasOrigin = { x: 0, y: 0 };
  let singlePanEligible = true;
  let suppressClickUntil = 0;
  let forwardingCancelFor: number | undefined;

  const clearLongPress = () => {
    clearTimeout(longPressTimer);
    longPressTimer = undefined;
  };

  const releasePointer = (point: Point) => {
    if (!point.captured) {
      return;
    }
    try {
      if (point.target.hasPointerCapture?.(point.id)) {
        point.target.releasePointerCapture(point.id);
      }
    } catch {
      // The pointer may already have been released by the browser.
    }
  };

  const reset = () => {
    clearLongPress();
    points.forEach(releasePointer);
    points.clear();
    mode = "pending";
  };

  const forwardPointerCancel = (point: Point) => {
    const view = point.target.ownerDocument.defaultView;
    if (!view) {
      return;
    }

    forwardingCancelFor = point.id;
    try {
      const CancelEvent = view.PointerEvent;
      if (CancelEvent) {
        point.target.dispatchEvent(
          new CancelEvent("pointercancel", {
            bubbles: true,
            pointerId: point.id,
            pointerType: "touch",
            clientX: point.x,
            clientY: point.y,
          })
        );
      } else {
        const event = new view.Event("pointercancel", { bubbles: true });
        Object.defineProperties(event, {
          pointerId: { value: point.id },
          pointerType: { value: "touch" },
          clientX: { value: point.x },
          clientY: { value: point.y },
        });
        point.target.dispatchEvent(event);
      }
    } finally {
      forwardingCancelFor = undefined;
    }
  };

  const capturePointer = (point: Point) => {
    try {
      point.target.setPointerCapture?.(point.id);
      point.captured = true;
    } catch {
      // Pointer capture is an enhancement; root capture listeners remain active.
    }
  };

  const beginSinglePan = () => {
    if (
      points.size !== 1 ||
      mode !== "pending" ||
      !singlePanEligible ||
      isEditing()
    ) {
      return;
    }
    const point = points.values().next().value as Point;
    currentGestureZoom = Math.max(getZoom(), MIN_ZOOM);
    mode = "single-pan";
    forwardPointerCancel(point);
    capturePointer(point);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (
      !mediaQuery.matches ||
      isEditing() ||
      !isTouchOnCanvas(event) ||
      !root.contains(event.target)
    ) {
      return;
    }

    if (points.size === 0) {
      points.set(event.pointerId, {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        target: event.target,
        captured: false,
      });
      mode = "pending";
      singlePanEligible = true;
      longPressTimer = setTimeout(beginSinglePan, longPressDelay);
      return;
    }

    if (points.size === 1) {
      clearLongPress();
      const first = points.values().next().value as Point;
      const second: Point = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        target: event.target,
        captured: false,
      };
      points.set(event.pointerId, second);
      mode = "multi-touch";
      initialPinchDistance = Math.max(distance(first, second), 1);
      initialPinchZoom = Math.max(getZoom(), MIN_ZOOM);
      currentGestureZoom = initialPinchZoom;
      lastMidpoint = midpoint(first, second);
      const canvasRect = first.target.getBoundingClientRect();
      pinchCanvasOrigin = { x: canvasRect.left, y: canvasRect.top };
      forwardPointerCancel(first);
      capturePointer(first);
      capturePointer(second);
      consume(event);
      return;
    }

    consume(event);
  };

  const onPointerMove = (event: PointerEvent) => {
    const point = points.get(event.pointerId);
    if (!point) {
      return;
    }
    if (!mediaQuery.matches || isEditing()) {
      reset();
      return;
    }

    const previousX = point.x;
    const previousY = point.y;
    point.x = event.clientX;
    point.y = event.clientY;

    if (mode === "pending") {
      if (
        Math.hypot(point.x - point.startX, point.y - point.startY) >
        PRE_LONG_PRESS_MOVE_TOLERANCE
      ) {
        clearLongPress();
        singlePanEligible = false;
      }
      return;
    }

    if (mode === "single-pan") {
      consume(event);
      scrollBy(
        -(point.x - previousX) / currentGestureZoom,
        -(point.y - previousY) / currentGestureZoom
      );
      return;
    }

    const activePoints = [...points.values()];
    if (activePoints.length !== 2) {
      return;
    }
    const [first, second] = activePoints;
    const nextMidpoint = midpoint(first, second);
    const nextZoom = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        initialPinchZoom * (distance(first, second) / initialPinchDistance)
      )
    );
    const offsetX =
      (lastMidpoint.x - pinchCanvasOrigin.x) / currentGestureZoom -
      (nextMidpoint.x - pinchCanvasOrigin.x) / nextZoom;
    const offsetY =
      (lastMidpoint.y - pinchCanvasOrigin.y) / currentGestureZoom -
      (nextMidpoint.y - pinchCanvasOrigin.y) / nextZoom;

    lastMidpoint = nextMidpoint;
    currentGestureZoom = nextZoom;
    consume(event);
    if (offsetX || offsetY) {
      scrollBy(offsetX, offsetY);
    }
    setZoom(nextZoom);
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (forwardingCancelFor === event.pointerId) {
      return;
    }
    if (!points.has(event.pointerId)) {
      return;
    }

    const ownedGesture = mode !== "pending";
    if (ownedGesture) {
      consume(event);
      suppressClickUntil = Date.now() + CLICK_SUPPRESSION_MS;
    }
    reset();
  };

  const onClick = (event: MouseEvent) => {
    if (
      Date.now() < suppressClickUntil &&
      event.target instanceof HTMLCanvasElement
    ) {
      consume(event);
    }
  };

  const onMediaChange = () => {
    if (!mediaQuery.matches) {
      reset();
    }
  };

  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("pointermove", onPointerMove, true);
  root.addEventListener("pointerup", onPointerEnd, true);
  root.addEventListener("pointercancel", onPointerEnd, true);
  root.addEventListener("click", onClick, true);
  mediaQuery.addEventListener("change", onMediaChange);

  return () => {
    reset();
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("pointermove", onPointerMove, true);
    root.removeEventListener("pointerup", onPointerEnd, true);
    root.removeEventListener("pointercancel", onPointerEnd, true);
    root.removeEventListener("click", onClick, true);
    mediaQuery.removeEventListener("change", onMediaChange);
  };
}
