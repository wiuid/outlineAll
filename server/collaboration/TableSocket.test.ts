import { createServer } from "node:http";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { v4 as uuid } from "uuid";
import { CollectionPermission } from "@shared/types";
import {
  TableRosterSchema,
  type TablePresence,
} from "@shared/utils/tablePresence";
import { publishTableChange } from "@server/commands/tableCollaborativeUpdater";
import {
  buildCollection,
  buildDocument,
  buildUser,
} from "@server/test/factories";
import type User from "@server/models/User";
import { TableSocket } from "./TableSocket";

async function endpoint(user: User) {
  const http = createServer();
  const io = new Server(http);
  const tables = new TableSocket(io);
  io.on("connection", (socket) => tables.connect(socket, user));
  await tables.start();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test socket address");
  }
  const client = connect(`http://127.0.0.1:${address.port}`, {
    transports: ["websocket"],
    reconnection: false,
  });
  const peers: TablePresence[][] = [];
  client.on("table.roster", (input: object) =>
    peers.push(TableRosterSchema.parse(input).peers)
  );
  await new Promise<void>((resolve) => client.once("connect", resolve));
  return {
    client,
    peers,
    close: async () => {
      client.disconnect();
      await tables.dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

function watch(client: Socket, documentId: string): Promise<string> {
  const clientId = uuid();
  return new Promise((resolve) => {
    client.once("table.changed", () => resolve(clientId));
    client.emit("table.watch", { documentId, clientId });
  });
}

describe("table websocket presence", () => {
  it("shares authenticated peers across websocket processes, removes disconnected peers and enforces revoked access", async () => {
    const first = await buildUser({ name: "First editor" });
    const second = await buildUser({
      teamId: first.teamId,
      name: "Second editor",
      avatarUrl: "https://example.com/test-avatar.png",
    });
    const collection = await buildCollection({
      teamId: first.teamId,
      permission: CollectionPermission.ReadWrite,
    });
    const document = await buildDocument({
      teamId: first.teamId,
      userId: first.id,
      collectionId: collection.id,
    });
    const a = await endpoint(first);
    const b = await endpoint(second);
    const another = await endpoint(second);
    try {
      await watch(a.client, document.id);
      const bClientId = await watch(b.client, document.id);
      await watch(another.client, document.id);
      await vi.waitFor(() =>
        expect(a.peers.at(-1)?.map((peer) => peer.userId)).toEqual(
          expect.arrayContaining([first.id, second.id])
        )
      );
      await vi.waitFor(() => {
        const connections = a.peers
          .at(-1)
          ?.filter((peer) => peer.userId === second.id);
        expect(connections).toHaveLength(2);
        expect(
          connections?.every(
            (peer) =>
              peer.color === second.color && peer.avatarUrl === second.avatarUrl
          )
        ).toBe(true);
      });
      b.client.emit("table.presence", {
        documentId: document.id,
        clientId: bClientId,
        userId: first.id,
        name: "Impersonated",
        avatarUrl: "https://example.com/impersonated.png",
        selection: {
          epoch: document.id,
          sheetId: "sheet",
          startRow: "r1",
          endRow: "r1",
          startColumn: "c2",
          endColumn: "c2",
          editing: true,
        },
      });
      await vi.waitFor(() => {
        const peer = a.peers.at(-1)?.find((item) => item.userId === second.id);
        expect(peer?.name).toBe("Second editor");
        expect(peer?.avatarUrl).toBe(second.avatarUrl);
        expect(peer?.color).toBe(second.color);
        expect(peer?.selection?.editing).toBe(true);
      });
      const revoked = new Promise<void>((resolve) =>
        b.client.once("table.revoked", () => resolve())
      );
      await second.update({ suspendedAt: new Date() });
      await publishTableChange(document.id, 2);
      await revoked;
      await vi.waitFor(() =>
        expect(a.peers.at(-1)?.some((peer) => peer.userId === second.id)).toBe(
          false
        )
      );
      const changes = vi.fn();
      b.client.on("table.changed", changes);
      await publishTableChange(document.id, 3);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(changes).not.toHaveBeenCalled();
      a.client.disconnect();
    } finally {
      await a.close();
      await b.close();
      await another.close();
    }
  }, 15000);

  it("keeps a read-only visitor in the roster without accepting a claimed editing state", async () => {
    const owner = await buildUser();
    const reader = await buildUser({ teamId: owner.teamId });
    const collection = await buildCollection({
      teamId: owner.teamId,
      permission: CollectionPermission.Read,
    });
    const document = await buildDocument({
      teamId: owner.teamId,
      userId: owner.id,
      collectionId: collection.id,
    });
    const view = await endpoint(reader);
    try {
      const clientId = await watch(view.client, document.id);
      view.client.emit("table.presence", {
        documentId: document.id,
        clientId,
        selection: {
          epoch: document.id,
          sheetId: "sheet",
          startRow: "r1",
          endRow: "r1",
          startColumn: "c1",
          endColumn: "c1",
          editing: true,
        },
      });
      await vi.waitFor(() => {
        const peer = view.peers
          .at(-1)
          ?.find((member) => member.userId === reader.id);
        expect(peer?.selection).toMatchObject({
          editing: false,
          sheetId: "sheet",
        });
      });
    } finally {
      await view.close();
    }
  }, 15000);

  it("keeps multiple table views on one websocket independently subscribed", async () => {
    const user = await buildUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      permission: CollectionPermission.ReadWrite,
    });
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
    });
    const view = await endpoint(user);
    try {
      const first = await watch(view.client, document.id);
      const second = await watch(view.client, document.id);
      await vi.waitFor(() =>
        expect(view.peers.at(-1)?.map((peer) => peer.clientId)).toEqual(
          expect.arrayContaining([first, second])
        )
      );

      view.client.emit("table.unwatch", {
        documentId: document.id,
        clientId: first,
      });
      await vi.waitFor(() => {
        const peers = view.peers.at(-1) ?? [];
        expect(peers.some((peer) => peer.clientId === first)).toBe(false);
        expect(peers.some((peer) => peer.clientId === second)).toBe(true);
      });

      const changed = vi.fn();
      view.client.on("table.changed", changed);
      await publishTableChange(document.id, 2);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    } finally {
      await view.close();
    }
  }, 15000);
});
