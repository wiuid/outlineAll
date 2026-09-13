"""Read the authorized, saved workbook snapshot supplied to this execution."""

from copy import deepcopy
import re


class Workbook:
    """A read-only view of one saved Outline document, never a database client."""

    def __init__(self, document):
        self.document_id = document["id"]
        self.title = document["title"]
        self.revision = document["revision"]
        table = document["table"]
        if table["version"] == 1:
            cells = {
                str(row_index): {
                    str(column_index): (
                        {"f": cell["formula"]}
                        if "formula" in cell
                        else {"v": cell.get("value")}
                    )
                    for column_index, cell in enumerate(row["cells"])
                }
                for row_index, row in enumerate(table["rows"])
            }
            self.sheets = (Worksheet({
                "id": "legacy",
                "name": "Sheet1",
                "rowCount": len(table["rows"]),
                "columnCount": len(table["columns"]),
                "cellData": cells,
            }),)
            return
        snapshot = table["workbook"]
        self.sheets = tuple(
            Worksheet(snapshot["sheets"][sheet_id], sheet_id)
            for sheet_id in snapshot["sheetOrder"]
        )

    @property
    def sheet_names(self):
        """Return sheet names in their saved tab order."""
        return tuple(sheet.name for sheet in self.sheets)

    def sheet(self, name_or_index=0):
        """Get a sheet by its exact name or zero-based index."""
        if isinstance(name_or_index, int) and not isinstance(name_or_index, bool):
            if name_or_index < 0 or name_or_index >= len(self.sheets):
                raise IndexError("Worksheet index is outside the workbook")
            return self.sheets[name_or_index]
        for sheet in self.sheets:
            if sheet.name == name_or_index:
                return sheet
        raise KeyError(f"Worksheet not found: {name_or_index}")


class Worksheet:
    """Saved native cell data, including hidden sheets and formula results."""

    def __init__(self, snapshot, sheet_id="legacy"):
        self.id = snapshot.get("id", sheet_id)
        self.name = snapshot.get("name", self.id)
        self.row_count = snapshot.get("rowCount", 1000)
        self.column_count = snapshot.get("columnCount", 26)
        self._cells = deepcopy(snapshot.get("cellData", {}))

    def range(self, address):
        """Read a bounded A1 range, for example A1, $B$2 or A1:D10."""
        match = re.fullmatch(
            r"\$?([A-Za-z]{1,4})\$?([1-9][0-9]{0,6})"
            r"(?::\$?([A-Za-z]{1,4})\$?([1-9][0-9]{0,6}))?",
            address,
        )
        if not match:
            raise ValueError("Expected an A1 cell or range, for example A1:D10")
        start_column = _column_index(match[1])
        start_row = int(match[2]) - 1
        end_column = _column_index(match[3] or match[1])
        end_row = int(match[4] or match[2]) - 1
        if (
            start_row > end_row
            or start_column > end_column
            or end_row >= self.row_count
            or end_column >= self.column_count
        ):
            raise ValueError("Range is outside the worksheet or reversed")
        if (end_row - start_row + 1) * (end_column - start_column + 1) > 100000:
            raise ValueError("Read at most 100000 cells in one range")
        return Range(self._cells, start_row, end_row, start_column, end_column)


class Range:
    """Detached two-dimensional values and formula source for a cell range."""

    def __init__(self, cells, start_row, end_row, start_column, end_column):
        self._rows = range(start_row, end_row + 1)
        self._columns = range(start_column, end_column + 1)
        self._cells = cells

    @property
    def values(self):
        """Return saved values; a formula without a saved result raises ValueError."""
        return [
            [self._value(row, column) for column in self._columns]
            for row in self._rows
        ]

    @property
    def formulas(self):
        """Return formula strings, or None for cells without a formula."""
        return [
            [self._cell(row, column).get("f") for column in self._columns]
            for row in self._rows
        ]

    def _cell(self, row, column):
        return (self._cells.get(str(row)) or {}).get(str(column)) or {}

    def _value(self, row, column):
        cell = self._cell(row, column)
        if (cell.get("f") or cell.get("si")) and cell.get("v") is None:
            raise ValueError(
                f"Cell at row {row + 1}, column {column + 1} has no saved formula "
                "result. Open and save the spreadsheet, or read .formulas."
            )
        value = cell.get("v")
        if value is not None:
            return bool(value) if cell.get("t") == 3 else value
        rich_text = (cell.get("p") or {}).get("body") or {}
        if "dataStream" in rich_text:
            return rich_text["dataStream"].removesuffix("\r\n")
        return None


def _column_index(name):
    index = 0
    for letter in name.upper():
        index = index * 26 + ord(letter) - ord("A") + 1
    return index - 1


# The bootstrap installs exactly one authorized snapshot before executing code.
workbook = None
