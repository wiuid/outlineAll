import {
  createCollaborationAvatar,
  observeCollaborationActivity,
  observeCollaborationCursors,
} from "./collaborationCursor";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("collaboration cursor avatars", () => {
  it("renders names as text, sanitizes image URLs and retains an image-error fallback", () => {
    const avatar = createCollaborationAvatar({
      id: "one",
      name: "<script>",
      color: "red;background:url(invalid)",
      avatarUrl: "javascript:alert(1)",
    });
    expect(avatar.querySelector("script")).toBeNull();
    expect(avatar.textContent).toBe("<");
    expect(avatar.style.getPropertyValue("--collaborator-color")).toBe(
      "#2563eb"
    );
    expect(avatar.querySelector("img")?.getAttribute("src")).not.toMatch(
      /^javascript:/i
    );
    const photo = createCollaborationAvatar({
      id: "two",
      name: "张三",
      color: "#2563eb",
      avatarUrl: "/avatar.png",
    });
    photo.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(photo.querySelector("img")).toBeNull();
    expect(photo.textContent).toBe("张");
  });

  it("separates overlapping avatars at the viewport edge and hides offscreen cursors", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
      320
    );
    const root = document.createElement("div");
    document.body.append(root);
    let top = 0;
    const rect = () => ({
      x: 308,
      y: top,
      left: 308,
      right: 310,
      top,
      bottom: top + 18,
      width: 2,
      height: 18,
      toJSON: () => ({}),
    });
    for (const id of ["one", "two", "three"]) {
      const anchor = document.createElement("span");
      anchor.dataset.collaborationCursor = id;
      anchor.append(
        createCollaborationAvatar({ id, name: id, color: "#2563eb" })
      );
      vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(rect);
      root.append(anchor);
    }
    const layout = observeCollaborationCursors(root);
    frames.shift()?.(0);
    const avatars = [
      ...root.querySelectorAll<HTMLElement>("[data-collaboration-avatar]"),
    ];
    const lefts = avatars.map(
      (avatar) => 308 + Number.parseFloat(avatar.style.left)
    );
    expect(new Set(lefts).size).toBe(3);
    expect(lefts.every((left) => left >= 4 && left + 24 <= 316)).toBe(true);
    top = -100;
    layout.refresh();
    frames.shift()?.(1);
    expect(
      avatars.every((avatar) => avatar.style.visibility === "hidden")
    ).toBe(true);
    layout.dispose();
  });
});

describe("collaboration editing activity", () => {
  it("stops editing on blur or hidden pages and removes its listeners on disposal", async () => {
    let focused = true;
    let hidden = false;
    let editing = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const changed = vi.fn();
    const activity = observeCollaborationActivity(() => editing, changed);
    expect(changed).toHaveBeenLastCalledWith(true);
    focused = false;
    window.dispatchEvent(new Event("blur"));
    await Promise.resolve();
    expect(changed).toHaveBeenLastCalledWith(false);
    focused = true;
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changed).toHaveBeenCalledTimes(2);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changed).toHaveBeenLastCalledWith(true);
    editing = false;
    activity.refresh();
    expect(changed).toHaveBeenLastCalledWith(false);
    activity.dispose();
    editing = true;
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(4);
  });
});
