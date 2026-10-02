import { LocaleType } from "@univerjs/core";
import {
  getTableCellImage,
  getTableCellImageSize,
  setTableCellImage,
  setTableCellImageSize,
} from "@shared/utils/tableCellImage";
import {
  getTableDocument,
  tableDocumentToMarkdown,
} from "@shared/utils/tableDocument";
import { parser } from "@server/editor";
import Attachment from "@server/models/Attachment";
import FileStorage from "@server/storage/files";
import { ProsemirrorHelper } from "./ProsemirrorHelper";

const image = {
  attachmentId: "f4a4e331-c5a5-4e78-a365-24975280b4a1",
  src: "/api/attachments.redirect?id=f4a4e331-c5a5-4e78-a365-24975280b4a1",
  name: "screenshot.png",
  width: 640,
  height: 480,
};

function imageDocument() {
  const doc = parser.parse(
    tableDocumentToMarkdown({
      format: "outline-table",
      version: 2,
      workbook: {
        id: "image-book",
        name: "Images",
        appVersion: "0.25.1",
        locale: LocaleType.EN_US,
        sheetOrder: ["sheet"],
        styles: {},
        sheets: {
          sheet: {
            id: "sheet",
            name: "Images",
            rowCount: 10,
            columnCount: 4,
            cellData: {
              0: {
                0: setTableCellImageSize(setTableCellImage(null, image), {
                  width: 120,
                  height: 90,
                }),
                1: setTableCellImage(null, image),
              },
            },
          },
        },
      },
    })
  );
  if (!doc) {
    throw new Error("Missing test document");
  }
  return doc;
}

describe("table cell image attachments", () => {
  it("tracks unique attachments inside a workbook's code-fence transport", () => {
    expect(ProsemirrorHelper.parseAttachmentIds(imageDocument())).toEqual([
      image.attachmentId,
    ]);
  });

  it("signs cell images for public readers without changing the saved source", async () => {
    const teamId = "f016651d-bdad-4179-82e6-29a6a5cbb21a";
    const doc = imageDocument();
    const before = doc.toJSON();
    const attachment = Attachment.build({
      id: image.attachmentId,
      teamId,
      key: "uploads/test/image.png",
    });
    const attachments = vi
      .spyOn(Attachment, "findAll")
      .mockResolvedValue([attachment]);
    const signedUrl = "https://storage.example.com/image.png?signature=public";
    const sign = vi
      .spyOn(FileStorage, "getSignedUrl")
      .mockResolvedValue(signedUrl);
    try {
      const result = getTableDocument(
        await ProsemirrorHelper.signAttachmentUrls(doc, teamId, 3600)
      );
      expect(attachments).toHaveBeenCalledWith({
        where: { id: [image.attachmentId], teamId },
      });
      expect(sign).toHaveBeenCalledWith(attachment.key, 3600);
      if (result?.version !== 2) {
        throw new Error("Expected native workbook");
      }
      expect(
        getTableCellImage(result.workbook.sheets.sheet.cellData?.[0]?.[0])?.src
      ).toBe(signedUrl);
      expect(
        getTableCellImage(result.workbook.sheets.sheet.cellData?.[0]?.[1])?.src
      ).toBe(signedUrl);
      expect(
        getTableCellImageSize(result.workbook.sheets.sheet.cellData?.[0]?.[0])
      ).toEqual({ width: 120, height: 90 });
      expect(doc.toJSON()).toEqual(before);
    } finally {
      attachments.mockRestore();
      sign.mockRestore();
    }
  });
});
