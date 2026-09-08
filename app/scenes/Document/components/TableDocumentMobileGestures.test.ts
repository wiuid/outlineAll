import {
  installMobileSheetGestures,
  MOBILE_SHEET_GESTURE_MEDIA_QUERY,
} from "./TableDocumentMobileGestures";

function pointerEvent(
  type: string,
  init: { pointerId: number; clientX: number; clientY: number }
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    pointerType: { value: "touch" },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    button: { value: 0 },
  });
  return event as PointerEvent;
}

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQueryList = {
    matches,
    media: MOBILE_SHEET_GESTURE_MEDIA_QUERY,
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void
    ) => {
      listeners.add(listener);
    },
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void
    ) => {
      listeners.delete(listener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => true,
  } as MediaQueryList;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mediaQueryList)
  );
  return mediaQueryList;
}

function setup(
  options: { editing?: boolean; enabled?: boolean; zoom?: number } = {}
) {
  mockMatchMedia(options.enabled ?? true);
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  const ribbon = document.createElement("div");
  ribbon.dataset.uComp = "ribbon-header-menu";
  root.append(canvas, ribbon);
  document.body.append(root);

  const scrollBy = vi.fn();
  const setZoom = vi.fn();
  const getZoom = vi.fn(() => options.zoom ?? 1);
  const isEditing = vi.fn(() => options.editing ?? false);
  const dispose = installMobileSheetGestures({
    root,
    scrollBy,
    getZoom,
    setZoom,
    isEditing,
    longPressDelay: 200,
  });

  return { root, canvas, ribbon, scrollBy, setZoom, dispose };
}

describe("installMobileSheetGestures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("keeps a light single-finger tap available to Univer selection", () => {
    const { canvas, scrollBy, setZoom } = setup();

    expect(
      canvas.dispatchEvent(
        pointerEvent("pointerdown", {
          pointerId: 1,
          clientX: 10,
          clientY: 20,
        })
      )
    ).toBe(true);
    canvas.dispatchEvent(
      pointerEvent("pointerup", {
        pointerId: 1,
        clientX: 10,
        clientY: 20,
      })
    );

    expect(scrollBy).not.toHaveBeenCalled();
    expect(setZoom).not.toHaveBeenCalled();
  });

  it("pans after a single-finger long press and suppresses the resulting click", () => {
    const { canvas, scrollBy } = setup();
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 10,
        clientY: 20,
      })
    );
    vi.advanceTimersByTime(200);

    const moveResult = canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 1,
        clientX: 24,
        clientY: 35,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointerup", {
        pointerId: 1,
        clientX: 24,
        clientY: 35,
      })
    );
    const clickResult = canvas.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );

    expect(moveResult).toBe(false);
    expect(scrollBy).toHaveBeenCalledWith(-14, -15);
    expect(clickResult).toBe(false);
  });

  it("converts screen movement to sheet offsets at the current zoom", () => {
    const { canvas, scrollBy } = setup({ zoom: 2 });
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 10,
        clientY: 20,
      })
    );
    vi.advanceTimersByTime(200);
    canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 1,
        clientX: 24,
        clientY: 35,
      })
    );

    expect(scrollBy).toHaveBeenCalledWith(-7, -7.5);
  });

  it("pans by the midpoint and zooms by distance during a two-finger gesture", () => {
    const { canvas, scrollBy, setZoom } = setup();
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      })
    );
    const secondDownResult = canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 2,
        clientX: 10,
        clientY: 0,
      })
    );
    const moveResult = canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 2,
        clientX: 20,
        clientY: 0,
      })
    );

    expect(secondDownResult).toBe(false);
    expect(moveResult).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(setZoom).toHaveBeenLastCalledWith(2);
  });

  it("pans with two fingers while preserving their final distance", () => {
    const { canvas, scrollBy, setZoom } = setup();
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 2,
        clientX: 100,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 1,
        clientX: 10,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 2,
        clientX: 110,
        clientY: 0,
      })
    );

    const totalScrollX = scrollBy.mock.calls.reduce(
      (total, [offsetX]) => total + offsetX,
      0
    );
    expect(totalScrollX).toBeCloseTo(-10);
    expect(setZoom).toHaveBeenLastCalledWith(1);
  });

  it("keeps tracking the first pointer when it moves before the second arrives", () => {
    const { canvas, setZoom } = setup();
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 1,
        clientX: 20,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 2,
        clientX: 30,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 2,
        clientX: 40,
        clientY: 0,
      })
    );

    expect(setZoom).toHaveBeenLastCalledWith(2);
  });

  it("compensates scroll so a stationary pinch midpoint stays anchored", () => {
    const { canvas, scrollBy, setZoom } = setup();
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 2,
        clientX: 10,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 1,
        clientX: -5,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 2,
        clientX: 15,
        clientY: 0,
      })
    );

    const totalScrollX = scrollBy.mock.calls.reduce(
      (total, [offsetX]) => total + offsetX,
      0
    );
    expect(setZoom).toHaveBeenLastCalledWith(2);
    expect(totalScrollX).toBeCloseTo(2.5);
  });

  it("does not intercept ribbon gestures or any gesture while cell editing", () => {
    const ribbonSetup = setup();
    const ribbonResult = ribbonSetup.ribbon.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      })
    );
    ribbonSetup.ribbon.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 1,
        clientX: 20,
        clientY: 0,
      })
    );
    expect(ribbonResult).toBe(true);
    expect(ribbonSetup.scrollBy).not.toHaveBeenCalled();
    ribbonSetup.dispose();

    const editingSetup = setup({ editing: true });
    editingSetup.canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      })
    );
    editingSetup.canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 2,
        clientX: 10,
        clientY: 0,
      })
    );
    editingSetup.canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 2,
        clientX: 20,
        clientY: 0,
      })
    );
    expect(editingSetup.scrollBy).not.toHaveBeenCalled();
    expect(editingSetup.setZoom).not.toHaveBeenCalled();
  });

  it("is inert unless both coarse pointer and mobile width match", () => {
    const { canvas, scrollBy } = setup({ enabled: false });
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 2,
        clientX: 10,
        clientY: 0,
      })
    );
    canvas.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 2,
        clientX: 20,
        clientY: 0,
      })
    );

    expect(scrollBy).not.toHaveBeenCalled();
  });
});
