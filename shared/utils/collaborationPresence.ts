/** A single browser connection viewing the current document. */
export interface CollaborationConnection {
  clientId: string;
  userId: string;
  isEditing: boolean;
  location?: string;
}

/** A person, with activity aggregated across their current connections. */
export interface CollaborationMember {
  userId: string;
  isEditing: boolean;
  connections: number;
  locations: string[];
}

/**
 * Groups live connections by person, prioritizing locations being edited.
 *
 * @param connections the connections for a single document.
 * @returns people ordered by editing status and stable user identity.
 */
export function groupCollaborationMembers(
  connections: CollaborationConnection[]
): CollaborationMember[] {
  const clients = new Map(
    connections.map((connection) => [connection.clientId, connection])
  );
  const members = new Map<string, CollaborationMember>();
  for (const connection of [...clients.values()].sort(
    (a, b) => Number(b.isEditing) - Number(a.isEditing)
  )) {
    const member = members.get(connection.userId) ?? {
      userId: connection.userId,
      isEditing: false,
      connections: 0,
      locations: [],
    };
    member.connections++;
    member.isEditing ||= connection.isEditing;
    if (
      connection.location &&
      !member.locations.includes(connection.location)
    ) {
      member.locations.push(connection.location);
    }
    members.set(connection.userId, member);
  }
  return [...members.values()].sort(
    (a, b) =>
      Number(b.isEditing) - Number(a.isEditing) ||
      a.userId.localeCompare(b.userId)
  );
}
