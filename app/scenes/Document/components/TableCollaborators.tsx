import { observer } from "mobx-react";
import {
  CollaborationMenu,
  type CollaborationMenuMember,
} from "~/components/CollaborationMenu";
import DocumentViews from "~/components/DocumentViews";
import useCurrentUser from "~/hooks/useCurrentUser";
import usePolicy from "~/hooks/usePolicy";
import type Document from "~/models/Document";
import type { TableCollaborationSession } from "~/stores/TableCollaborationSession";

interface Props {
  document: Document;
  session: TableCollaborationSession;
  mobile: boolean;
}

/**
 * Displays the workbook roster using the same people menu as Markdown.
 *
 * @param props the document, collaborative session and compact layout preference.
 * @returns current people and their editing locations.
 */
export const TableCollaborators = observer(function TableCollaborators({
  document,
  session,
  mobile,
}: Props) {
  const currentUser = useCurrentUser();
  const can = usePolicy(document);
  const members: CollaborationMenuMember[] = session.collaborators.flatMap(
    (member) => {
      const peer = session.peers.find(
        (candidate) => candidate.userId === member.userId
      );
      return peer
        ? [
            {
              ...member,
              name: peer.name,
              avatarUrl: peer.avatarUrl,
              color: peer.color,
            },
          ]
        : [];
    }
  );
  if (!members.some((member) => member.userId === currentUser.id)) {
    members.push({
      userId: currentUser.id,
      name: currentUser.name,
      avatarUrl: currentUser.avatarUrl,
      color: currentUser.color,
      isEditing: false,
      connections: 1,
      locations: [],
    });
  }
  members.sort(
    (a, b) =>
      Number(b.isEditing) - Number(a.isEditing) || a.name.localeCompare(b.name)
  );
  return (
    <span data-table-collaborators>
      <CollaborationMenu
        members={members}
        currentUserId={currentUser.id}
        compact={mobile}
        history={
          document.insightsEnabled && can.listViews ? (
            <DocumentViews document={document} />
          ) : undefined
        }
      />
    </span>
  );
});
