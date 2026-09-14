import { action, makeObservable, observable } from "mobx";
import {
  groupCollaborationMembers,
  type CollaborationMember,
} from "@shared/utils/collaborationPresence";
import type { AwarenessChangeEvent } from "~/types";
import type RootStore from "./RootStore";

type DocumentPresence = Map<string, CollaborationMember>;

export default class PresenceStore {
  @observable
  data: Map<string, DocumentPresence> = new Map();

  constructor(_rootStore?: RootStore) {
    makeObservable(this);
  }

  /**
   * Removes a user from the presence store
   *
   * @param documentId ID of the document to remove the user from
   * @param userId ID of the user to remove
   */
  @action
  public leave(documentId: string, userId: string) {
    const existing = this.data.get(documentId);

    if (existing) {
      existing.delete(userId);
    }
  }

  /**
   * Updates the presence store based on an awareness event from YJS
   *
   * @param documentId ID of the document the event is for
   * @param event The awareness event
   */
  @action public updateFromAwarenessChangeEvent(
    documentId: string,
    event: AwarenessChangeEvent
  ) {
    const members = groupCollaborationMembers(
      event.states.flatMap((state) =>
        state.user
          ? [
              {
                clientId: String(state.clientId),
                userId: state.user.id,
                isEditing: !!state.cursor && (state.activity?.editing ?? true),
              },
            ]
          : []
      )
    );
    const previous = this.data.get(documentId);
    if (
      previous?.size === members.length &&
      members.every((member) => {
        const existing = previous.get(member.userId);
        return (
          existing?.isEditing === member.isEditing &&
          existing.connections === member.connections
        );
      })
    ) {
      return;
    }
    this.data.set(
      documentId,
      new Map(members.map((member) => [member.userId, member]))
    );
  }

  /**
   * Clears a document's live roster when its connection closes or its editor unmounts.
   *
   * @param documentId the document whose connection ended.
   */
  @action public clearDocument(documentId: string): void {
    this.data.delete(documentId);
  }

  /**
   * Updates the presence store to indicate that a user is present in a document
   * and then removes the user after a timeout of inactivity.
   *
   * @param documentId ID of the document to update
   * @param userId ID of the user to update
   * @param isEditing Whether the user is "editing" the document
   */
  public touch(documentId: string, userId: string, isEditing: boolean) {
    const id = `${documentId}-${userId}`;
    let timeout = this.timeouts.get(id);

    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(id);
    }

    this.update(documentId, userId, isEditing);

    timeout = setTimeout(() => {
      this.leave(documentId, userId);
    }, this.offlineTimeout);
    this.timeouts.set(id, timeout);
  }

  /**
   * Updates the presence store to indicate that a user is present in a document.
   *
   * @param documentId ID of the document to update
   * @param userId ID of the user to update
   * @param isEditing Whether the user is "editing" the document
   */
  @action
  private update(documentId: string, userId: string, isEditing: boolean) {
    const presence = this.data.get(documentId) || new Map();
    const existing = presence.get(userId);

    if (!existing || existing.isEditing !== isEditing) {
      presence.set(userId, {
        isEditing,
        userId,
        connections: 1,
        locations: [],
      });
      this.data.set(documentId, presence);
    }
  }

  public get(documentId: string): DocumentPresence | null | undefined {
    return this.data.get(documentId);
  }

  @action
  public clear() {
    this.data.clear();
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
  }

  private timeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private offlineTimeout = 30000;
}
