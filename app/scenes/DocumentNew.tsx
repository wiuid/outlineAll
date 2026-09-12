import { observer } from "mobx-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useHistory, useLocation, useRouteMatch } from "react-router-dom";
import { toast } from "sonner";
import { UserPreference } from "@shared/types";
import CenteredContent from "~/components/CenteredContent";
import Flex from "~/components/Flex";
import PlaceholderDocument from "~/components/PlaceholderDocument";
import useCurrentUser from "~/hooks/useCurrentUser";
import useQuery from "~/hooks/useQuery";
import useStores from "~/hooks/useStores";
import { preloadEditor } from "~/routes/scenes";
import { documentEditPath, documentPath } from "~/utils/routeHelpers";

function DocumentNew() {
  const history = useHistory();
  const location = useLocation();
  const query = useQuery();
  const user = useCurrentUser();
  const match = useRouteMatch<{ collectionSlug?: string }>();
  const { t } = useTranslation();
  const { documents, collections, userMemberships, groupMemberships } =
    useStores();
  const id = match.params.collectionSlug || query.get("collectionId");
  const creationStarted = useRef(false);

  useEffect(() => {
    // React StrictMode replays effects in development. A workbook has unique
    // IDs, so two creations cannot rely on HTTP request deduplication.
    if (creationStarted.current) {
      return;
    }
    creationStarted.current = true;
    // Download the editor while the document is being created on the server
    const isTable = query.get("type") === "table";
    if (!isTable) {
      preloadEditor();
    }

    async function createDocument() {
      const index = parseInt(query.get("index") || "0", 10);
      const parentDocumentId = query.get("parentDocumentId") ?? undefined;
      const parentDocument = parentDocumentId
        ? documents.get(parentDocumentId)
        : undefined;
      let collection;

      try {
        if (id) {
          collection = await collections.fetch(id);
        }

        const title = query.get("title") ?? "";
        const document = await documents.createEmptyDocument(
          {
            collectionId: collection?.id,
            parentDocumentId,
            fullWidth:
              parentDocument?.fullWidth ||
              user.getPreference(UserPreference.FullWidthDocuments),
            templateId: query.get("templateId") ?? undefined,
            title,
          },
          {
            publish: collection?.id || parentDocumentId ? true : undefined,
            index,
          },
          isTable ? "table" : "document"
        );

        if (parentDocumentId) {
          userMemberships
            .getByDocumentId(document.id)
            ?.addDocument(document, parentDocumentId);

          groupMemberships
            .getByDocumentId(document.id)
            ?.addDocument(document, parentDocumentId);
        }

        history.replace(
          !user.separateEditMode
            ? documentPath(document)
            : documentEditPath(document),
          location.state
        );
      } catch (_err) {
        toast.error(t("Couldn’t create the document, try again?"));
        history.goBack();
      }
    }

    void createDocument();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Flex column auto>
      <CenteredContent>
        <PlaceholderDocument />
      </CenteredContent>
    </Flex>
  );
}

export default observer(DocumentNew);
