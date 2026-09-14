import { groupCollaborationMembers } from "./collaborationPresence";

describe("live collaboration members", () => {
  it("counts people once while retaining their distinct browser connections", () => {
    expect(
      groupCollaborationMembers([
        { clientId: "a", userId: "one", isEditing: false },
        {
          clientId: "b",
          userId: "one",
          isEditing: true,
          location: "Sheet1!B6",
        },
        { clientId: "c", userId: "two", isEditing: false },
      ])
    ).toEqual([
      {
        userId: "one",
        isEditing: true,
        connections: 2,
        locations: ["Sheet1!B6"],
      },
      { userId: "two", isEditing: false, connections: 1, locations: [] },
    ]);
  });

  it("uses the latest state of each connection and prioritizes editing locations", () => {
    expect(
      groupCollaborationMembers([
        { clientId: "a", userId: "one", isEditing: true, location: "Old!A1" },
        {
          clientId: "a",
          userId: "one",
          isEditing: false,
          location: "Sheet1!A1",
        },
        {
          clientId: "b",
          userId: "one",
          isEditing: true,
          location: "Sheet2!C9",
        },
        {
          clientId: "c",
          userId: "one",
          isEditing: false,
          location: "Sheet2!C9",
        },
      ])
    ).toEqual([
      {
        userId: "one",
        isEditing: true,
        connections: 3,
        locations: ["Sheet2!C9", "Sheet1!A1"],
      },
    ]);
  });

  it("drops departed people and sorts editors before viewers", () => {
    const viewers = [{ clientId: "a", userId: "one", isEditing: false }];
    expect(
      groupCollaborationMembers([
        ...viewers,
        { clientId: "b", userId: "two", isEditing: true },
      ]).map((person) => person.userId)
    ).toEqual(["two", "one"]);
    expect(
      groupCollaborationMembers(viewers).map((person) => person.userId)
    ).toEqual(["one"]);
    expect(groupCollaborationMembers([])).toEqual([]);
  });
});
