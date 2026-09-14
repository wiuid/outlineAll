import type { AwarenessChangeEvent } from "~/types";
import PresenceStore from "./DocumentPresenceStore";

const position = {
  type: { client: 1, clock: 0 },
  tname: null,
  item: { client: 1, clock: 1 },
  assoc: 0,
};
const cursor = { anchor: position, head: position };

describe("document live presence", () => {
  it("includes the local editor and combines another connection belonging to the same person", () => {
    const store = new PresenceStore();
    const event: AwarenessChangeEvent = {
      states: [
        {
          clientId: 1,
          user: { id: "one" },
          cursor,
          activity: { editing: true },
          scrollY: 0,
        },
        {
          clientId: 2,
          user: { id: "one" },
          cursor: null,
          activity: { editing: false },
          scrollY: 0,
        },
        {
          clientId: 3,
          user: { id: "two" },
          cursor,
          activity: { editing: false },
          scrollY: 0,
        },
      ],
    };
    store.updateFromAwarenessChangeEvent("doc", event);
    expect(store.get("doc")?.get("one")).toMatchObject({
      isEditing: true,
      connections: 2,
    });
    expect(store.get("doc")?.get("two")).toMatchObject({
      isEditing: false,
      connections: 1,
    });
    store.updateFromAwarenessChangeEvent("doc", {
      states: event.states.slice(1),
    });
    expect(store.get("doc")?.get("one")).toMatchObject({
      isEditing: false,
      connections: 1,
    });
    store.updateFromAwarenessChangeEvent("doc", { states: [] });
    expect(store.get("doc")?.size).toBe(0);
  });

  it("keeps documents separate and removes stale people when a connection closes", () => {
    const store = new PresenceStore();
    const event: AwarenessChangeEvent = {
      states: [
        {
          clientId: 1,
          user: { id: "one" },
          cursor,
          activity: { editing: true },
          scrollY: 0,
        },
      ],
    };
    store.updateFromAwarenessChangeEvent("first", event);
    store.updateFromAwarenessChangeEvent("second", event);
    store.clearDocument("first");
    expect(store.get("first")).toBeUndefined();
    expect(store.get("second")?.size).toBe(1);
  });
});
