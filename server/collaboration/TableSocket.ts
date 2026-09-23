import type { Server, Socket } from "socket.io";
import { z } from "zod";
import { toError } from "@shared/utils/error";
import { TABLE_COLLABORATION_CHANNEL } from "@server/commands/tableCollaborativeUpdater";
import Logger from "@server/logging/Logger";
import { Document, User } from "@server/models";
import { can } from "@server/policies";
import Redis from "@server/storage/redis";
import {
  TablePresenceSchema,
  TableSelectionSchema,
  type TablePresence,
} from "@shared/utils/tablePresence";

const changeSchema = z.object({
  documentId: z.uuid(),
  revision: z.number().int().positive(),
});
const watchSchema = z.object({
  documentId: z.uuid(),
  clientId: z.uuid(),
});
const presenceChannel = "tables:presence";
const presenceMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("update"), presence: TablePresenceSchema }),
  z.object({
    type: z.literal("remove"),
    documentId: z.uuid(),
    clientId: z.string(),
  }),
  z.object({ type: z.literal("request"), documentId: z.uuid() }),
]);
const selectionSchema = z.object({
  documentId: z.uuid(),
  clientId: z.uuid(),
  selection: TableSelectionSchema.nullable(),
});
const presenceLifetime = 45000;

interface Watcher {
  socket: Socket;
  userId: string;
  documentId: string;
  presence: TablePresence;
  lastSent: number;
}

/**
 * Delivers committed-revision notifications through Outline's existing socket.
 * Data and current permissions are rechecked by the authenticated sync API.
 */
export class TableSocket {
  constructor(private readonly io: Server) {}

  /** Subscribes this websocket process to revisions committed by any API process. */
  async start(): Promise<void> {
    this.stopped = false;
    Redis.defaultSubscriber.on("message", this.handleMessage);
    await Redis.defaultSubscriber.subscribe(TABLE_COLLABORATION_CHANNEL);
    await Redis.defaultSubscriber.subscribe(presenceChannel);
    this.heartbeat = setInterval(() => {
      void this.refreshPresence().catch((error) =>
        Logger.error("Unable to refresh table presence", toError(error))
      );
    }, 15000);
    this.heartbeat.unref();
  }

  /** Removes only this feature's listeners when the websocket process shuts down. */
  async dispose(): Promise<void> {
    this.stopped = true;
    Redis.defaultSubscriber.off("message", this.handleMessage);
    await Redis.defaultSubscriber.unsubscribe(TABLE_COLLABORATION_CHANNEL);
    await Redis.defaultSubscriber.unsubscribe(presenceChannel);
    clearInterval(this.heartbeat);
    for (const timer of this.broadcastTimers.values()) {
      clearTimeout(timer);
    }
    await Promise.all([...this.watchers.keys()].map((key) => this.remove(key)));
    this.watchers.clear();
  }

  /**
   * Installs a table subscription after the existing socket authentication.
   *
   * @param socket the authenticated browser connection.
   * @param user the authenticated member.
   */
  connect(socket: Socket, user: User): void {
    socket.on("table.watch", (input: object) => {
      void this.watch(socket, user.id, input).catch((error) => {
        Logger.error("Unable to subscribe to table", toError(error), {
          userId: user.id,
        });
      });
    });
    socket.on("table.presence", (input: object) => {
      void this.updatePresence(socket, input).catch((error) =>
        Logger.error("Unable to update table presence", toError(error))
      );
    });
    socket.on("table.unwatch", (input: object) => {
      const parsed = watchSchema.safeParse(input);
      if (parsed.success) {
        void this.remove(this.watcherKey(socket.id, parsed.data.clientId));
      }
    });
    socket.on("disconnect", () => {
      void this.removeSocket(socket.id);
    });
  }

  private watchers = new Map<string, Watcher>();
  private peers = new Map<string, TablePresence>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private broadcastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watchRequests = new Map<string, object>();
  private stopped = false;

  private async watch(
    socket: Socket,
    userId: string,
    input: object
  ): Promise<void> {
    const result = watchSchema.safeParse(input);
    if (!result.success || !socket.connected) {
      return;
    }
    const key = this.watcherKey(socket.id, result.data.clientId);
    const request = {};
    this.watchRequests.set(key, request);
    const member = await User.findByPk(userId);
    if (!member || member.isSuspended) {
      return;
    }
    const watcher: Watcher = {
      socket,
      userId,
      documentId: result.data.documentId,
      lastSent: 0,
      presence: {
        documentId: result.data.documentId,
        clientId: result.data.clientId,
        userId,
        name: member.name.slice(0, 100),
        avatarUrl: member.avatarUrl,
        color: member.color,
        selection: null,
        updatedAt: Date.now(),
      },
    };
    if (
      !(await this.canRead(watcher)) ||
      !socket.connected ||
      this.watchRequests.get(key) !== request
    ) {
      return;
    }
    const previous = this.watchers.get(key);
    if (previous?.documentId === watcher.documentId) {
      watcher.presence = previous.presence;
    } else if (previous) {
      await this.remove(key);
    }
    if (!socket.connected) {
      return;
    }
    this.watchers.set(key, watcher);
    // Fetch after registration to close the initial-load/subscription race.
    socket.emit("table.changed", { documentId: watcher.documentId });
    await this.publishPresence(watcher);
    await this.publish({ type: "request", documentId: watcher.documentId });
  }

  private handleMessage = (channel: string, message: string): void => {
    if (channel === presenceChannel) {
      void this.receivePresence(message).catch((error) =>
        Logger.error("Unable to deliver table presence", toError(error))
      );
      return;
    }
    if (channel !== TABLE_COLLABORATION_CHANNEL) {
      return;
    }
    void this.notify(message).catch((error) => {
      Logger.error("Unable to notify table subscribers", toError(error));
    });
  };

  private async notify(message: string): Promise<void> {
    const change = changeSchema.safeParse(JSON.parse(message));
    if (!change.success) {
      return;
    }
    const groups = this.groupBySocket(
      [...this.watchers.entries()].filter(
        ([, watcher]) => watcher.documentId === change.data.documentId
      )
    );
    await Promise.all(
      groups.map(async (watchers) => {
        const watcher = watchers[0][1];
        if (await this.canRead(watcher)) {
          this.io.to(watcher.socket.id).emit("table.changed", change.data);
          return;
        }
        await Promise.all(watchers.map(([key]) => this.remove(key)));
        watcher.socket.emit("table.revoked", {
          documentId: watcher.documentId,
        });
      })
    );
  }

  private async canRead(
    watcher: Watcher,
    ability: "read" | "update" = "read"
  ): Promise<boolean> {
    const user = await User.findByPk(watcher.userId);
    if (!user || user.isSuspended) {
      return false;
    }
    const document = await Document.findByPk(watcher.documentId, {
      userId: user.id,
    });
    return !!can(user, ability, document);
  }

  private async updatePresence(socket: Socket, input: object): Promise<void> {
    const parsed = selectionSchema.safeParse(input);
    if (!parsed.success) {
      return;
    }
    const key = this.watcherKey(socket.id, parsed.data.clientId);
    const watcher = this.watchers.get(key);
    if (
      !watcher ||
      watcher.documentId !== parsed.data.documentId ||
      Date.now() - watcher.lastSent < 150
    ) {
      return;
    }
    watcher.lastSent = Date.now();
    if (!(await this.canRead(watcher)) || this.watchers.get(key) !== watcher) {
      if (this.watchers.get(key) === watcher) {
        await this.remove(key);
        socket.emit("table.revoked", { documentId: watcher.documentId });
      }
      return;
    }
    const selection = parsed.data.selection;
    if (selection?.editing && !(await this.canRead(watcher, "update"))) {
      selection.editing = false;
    }
    if (this.watchers.get(key) !== watcher) {
      return;
    }
    watcher.presence.selection = selection;
    await this.publishPresence(watcher);
  }

  private async publish(
    message: z.infer<typeof presenceMessageSchema>
  ): Promise<void> {
    try {
      await Redis.defaultClient.publish(
        presenceChannel,
        JSON.stringify(message)
      );
    } catch (error) {
      Logger.error("Unable to announce table presence", toError(error));
    }
  }

  private async publishPresence(watcher: Watcher): Promise<void> {
    watcher.presence.updatedAt = Date.now();
    this.peers.set(
      this.peerKey(watcher.documentId, watcher.presence.clientId),
      { ...watcher.presence }
    );
    await this.publish({ type: "update", presence: watcher.presence });
    this.scheduleRoster(watcher.documentId);
  }

  private async remove(key: string): Promise<void> {
    this.watchRequests.delete(key);
    const watcher = this.watchers.get(key);
    if (!watcher) {
      return;
    }
    this.watchers.delete(key);
    this.peers.delete(
      this.peerKey(watcher.documentId, watcher.presence.clientId)
    );
    await this.publish({
      type: "remove",
      documentId: watcher.documentId,
      clientId: watcher.presence.clientId,
    });
    this.scheduleRoster(watcher.documentId);
  }

  private async receivePresence(message: string): Promise<void> {
    const parsed = presenceMessageSchema.safeParse(JSON.parse(message));
    if (!parsed.success) {
      return;
    }
    const event = parsed.data;
    if (event.type === "request") {
      await Promise.all(
        [...this.watchers.values()]
          .filter((watcher) => watcher.documentId === event.documentId)
          .map(async (watcher) => {
            if (await this.canRead(watcher)) {
              await this.publishPresence(watcher);
            }
          })
      );
      return;
    }
    const documentId =
      event.type === "update" ? event.presence.documentId : event.documentId;
    if (event.type === "remove") {
      this.peers.delete(this.peerKey(event.documentId, event.clientId));
    } else if (
      [...this.watchers.values()].some(
        (watcher) => watcher.documentId === documentId
      )
    ) {
      this.peers.set(
        this.peerKey(event.presence.documentId, event.presence.clientId),
        event.presence
      );
    }
    this.scheduleRoster(documentId);
  }

  private scheduleRoster(documentId: string): void {
    if (this.stopped || this.broadcastTimers.has(documentId)) {
      return;
    }
    this.broadcastTimers.set(
      documentId,
      setTimeout(() => {
        this.broadcastTimers.delete(documentId);
        void this.sendRoster(documentId).catch((error) =>
          Logger.error("Unable to send table roster", toError(error))
        );
      }, 200)
    );
  }

  private async sendRoster(documentId: string): Promise<void> {
    const watchers = [...this.watchers.entries()].filter(
      ([, watcher]) => watcher.documentId === documentId
    );
    if (!watchers.length) {
      for (const [id, peer] of this.peers) {
        if (peer.documentId === documentId) {
          this.peers.delete(id);
        }
      }
      return;
    }
    const peers = [...this.peers.values()]
      .filter(
        (peer) =>
          peer.documentId === documentId &&
          Date.now() - peer.updatedAt < presenceLifetime
      )
      .slice(0, 200);
    await Promise.all(
      this.groupBySocket(watchers).map(async (group) => {
        const watcher = group[0][1];
        if (!(await this.canRead(watcher))) {
          await Promise.all(group.map(([key]) => this.remove(key)));
          watcher.socket.emit("table.revoked", { documentId });
          return;
        }
        if (group.some(([key, item]) => this.watchers.get(key) === item)) {
          watcher.socket.emit("table.roster", { documentId, peers });
        }
      })
    );
  }

  private async refreshPresence(): Promise<void> {
    for (const [id, peer] of this.peers) {
      if (Date.now() - peer.updatedAt >= presenceLifetime) {
        this.peers.delete(id);
        this.scheduleRoster(peer.documentId);
      }
    }
    await Promise.all(
      [...this.watchers.entries()].map(async ([key, watcher]) => {
        if (await this.canRead(watcher)) {
          if (
            watcher.presence.selection?.editing &&
            Date.now() - watcher.lastSent >= presenceLifetime
          ) {
            watcher.presence.selection.editing = false;
          }
          await this.publishPresence(watcher);
        } else {
          await this.remove(key);
          watcher.socket.emit("table.revoked", {
            documentId: watcher.documentId,
          });
        }
      })
    );
  }

  private async removeSocket(socketId: string): Promise<void> {
    await Promise.all(
      [...this.watchers.entries()]
        .filter(([, watcher]) => watcher.socket.id === socketId)
        .map(([key]) => this.remove(key))
    );
  }

  private watcherKey(socketId: string, clientId: string): string {
    return `${socketId}:${clientId}`;
  }

  private peerKey(documentId: string, clientId: string): string {
    return `${documentId}:${clientId}`;
  }

  private groupBySocket(
    watchers: Array<[string, Watcher]>
  ): Array<Array<[string, Watcher]>> {
    const groups = new Map<string, Array<[string, Watcher]>>();
    for (const entry of watchers) {
      const socketId = entry[1].socket.id;
      const group = groups.get(socketId);
      if (group) {
        group.push(entry);
      } else {
        groups.set(socketId, [entry]);
      }
    }
    return [...groups.values()];
  }
}
