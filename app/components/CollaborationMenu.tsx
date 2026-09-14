import { useState, type ReactNode } from "react";
import { GroupIcon } from "outline-icons";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import type { CollaborationMember } from "@shared/utils/collaborationPresence";
import { Avatar, AvatarSize, type IAvatar } from "~/components/Avatar";
import Button from "~/components/Button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { CollaborationCursorStyles } from "./CollaborationCursorAvatars";

/** The public identity and live activity shown in the collaboration menu. */
export interface CollaborationMenuMember extends CollaborationMember, IAvatar {
  name: string;
  color: string;
}

interface Props {
  members: CollaborationMenuMember[];
  currentUserId: string;
  compact?: boolean;
  history?: ReactNode;
}

/**
 * Displays the same live people menu for Markdown documents and workbooks.
 *
 * @param props the current document's people, local identity and optional view history.
 * @returns the accessible collaboration menu and shared cursor styles.
 */
export function CollaborationMenu({
  members,
  currentUserId,
  compact,
  history,
}: Props) {
  const { t } = useTranslation();
  const [showHistory, setShowHistory] = useState(false);
  return (
    <>
      <CollaborationCursorStyles />
      <Popover modal onOpenChange={() => setShowHistory(false)}>
        <PopoverTrigger asChild>
          <Trigger
            neutral
            disclosure
            icon={compact ? <GroupIcon /> : undefined}
            data-collaboration-trigger
            aria-label={`${t("Collaboration")} · ${t("{{count}} people", { count: members.length })}`}
          >
            {!compact && t("Collaboration")}
            {!compact && " · "}
            {compact
              ? members.length
              : t("{{count}} people", { count: members.length })}
          </Trigger>
        </PopoverTrigger>
        <Content
          align="end"
          side="bottom"
          width={300}
          collisionPadding={8}
          aria-label={t("Collaboration")}
        >
          {showHistory ? (
            <>
              <Button neutral onClick={() => setShowHistory(false)}>
                {t("Back")}
              </Button>
              {history}
            </>
          ) : (
            <>
              <Caption>
                {t("Online")} ·{" "}
                {t("{{count}} people", { count: members.length })}
              </Caption>
              <People aria-label={t("Online")} data-collaboration-members>
                {members.map((member) => (
                  <Person
                    key={member.userId}
                    data-collaboration-user={member.userId}
                    data-editing={member.isEditing}
                  >
                    <Portrait $color={member.color}>
                      <Avatar
                        model={member}
                        size={AvatarSize.Medium}
                        alt={member.name}
                      />
                    </Portrait>
                    <Details>
                      <Name>
                        {member.name}
                        {member.userId === currentUserId && (
                          <You> ({t("You")})</You>
                        )}
                      </Name>
                      <Status>
                        {member.isEditing
                          ? t("Currently editing")
                          : t("Currently viewing")}
                      </Status>
                      {!!member.locations.length && (
                        <Location title={member.locations.join(" · ")}>
                          {member.locations.join(" · ")}
                        </Location>
                      )}
                    </Details>
                    {member.connections > 1 && (
                      <Connections
                        aria-label={t("{{count}} connections", {
                          count: member.connections,
                        })}
                      >
                        ×{member.connections}
                      </Connections>
                    )}
                  </Person>
                ))}
              </People>
              {history && (
                <HistoryButton neutral onClick={() => setShowHistory(true)}>
                  {t("Viewers")}
                </HistoryButton>
              )}
            </>
          )}
        </Content>
      </Popover>
    </>
  );
}

const Trigger = styled(Button)`
  font-variant-numeric: tabular-nums;
  margin-inline-end: 4px;
`;
const Content = styled(PopoverContent)`
  max-width: calc(100vw - 16px);
  box-sizing: border-box;
  padding: 12px;
`;
const Caption = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.textSecondary};
  margin: 0 4px 8px;
`;
const People = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`;
const Person = styled.li`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
`;
const Portrait = styled.span<{ $color: string }>`
  display: inline-flex;
  padding: 2px;
  border: 2px solid ${({ $color }) => $color};
  border-radius: 50%;
  flex-shrink: 0;
`;
const Details = styled.div`
  flex: 1;
  min-width: 0;
`;
const Name = styled.div`
  font-size: 14px;
  font-weight: 500;
  overflow-wrap: anywhere;
`;
const You = styled.span`
  color: ${({ theme }) => theme.textSecondary};
  font-weight: normal;
`;
const Status = styled.div`
  color: ${({ theme }) => theme.textSecondary};
  font-size: 12px;
`;
const Location = styled(Status)`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const Connections = styled.span`
  color: ${({ theme }) => theme.textSecondary};
  font-size: 12px;
  white-space: nowrap;
`;
const HistoryButton = styled(Button)`
  margin-top: 8px;
`;
