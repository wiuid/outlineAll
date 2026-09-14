import { observer } from "mobx-react";
import { useEffect, useMemo, useState } from "react";
import type { CollaborationMember } from "@shared/utils/collaborationPresence";
import type Document from "~/models/Document";
import useCurrentUser from "~/hooks/useCurrentUser";
import usePolicy from "~/hooks/usePolicy";
import useStores from "~/hooks/useStores";
import {
  CollaborationMenu,
  type CollaborationMenuMember,
} from "./CollaborationMenu";
import DocumentViews from "./DocumentViews";

interface Props {
  document: Document;
  compact?: boolean;
}

/**
 * Resolves the current document's live people into the shared collaboration menu.
 *
 * @param props the document and compact header preference.
 * @returns the live roster, with historical visits available separately.
 */
function Collaborators({ document, compact }: Props) {
  const currentUser = useCurrentUser();
  const { users, presence } = useStores();
  const can = usePolicy(document);
  const [requestedIds, setRequestedIds] = useState<string[]>([]);
  const documentPresence = presence.get(document.id);
  const present = useMemo(() => {
    const members = new Map(documentPresence);
    if (!members.has(currentUser.id)) {
      members.set(currentUser.id, {
        userId: currentUser.id,
        isEditing: false,
        connections: 1,
        locations: [],
      });
    }
    return [...members.values()];
  }, [documentPresence, currentUser.id]);
  const missing = present
    .filter((member) => !users.get(member.userId))
    .map((member) => member.userId);
  useEffect(() => {
    const ids = missing.filter((id) => !requestedIds.includes(id));
    if (!ids.length) {
      return;
    }
    setRequestedIds((previous) => [...previous, ...ids]);
    void users.fetchPage({ ids, limit: 100 });
  }, [missing, requestedIds, users]);
  const members: CollaborationMenuMember[] = present
    .flatMap((member: CollaborationMember) => {
      const user =
        member.userId === currentUser.id
          ? currentUser
          : users.get(member.userId);
      if (!user || user.isSuspended) {
        return [];
      }
      return [
        {
          ...member,
          name: user.name,
          avatarUrl: user.avatarUrl,
          color: user.color,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(b.isEditing) - Number(a.isEditing) ||
        a.name.localeCompare(b.name)
    );
  return (
    <CollaborationMenu
      members={members}
      currentUserId={currentUser.id}
      compact={compact}
      history={
        document.insightsEnabled && can.listViews ? (
          <DocumentViews document={document} />
        ) : undefined
      }
    />
  );
}

export default observer(Collaborators);
