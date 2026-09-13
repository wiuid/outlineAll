"""SDK regression tests against saved native and legacy workbook data."""

import unittest
from outline import Workbook


def document(table):
    return {"id": "document", "title": "销售表", "revision": 7, "table": table}


class WorkbookTest(unittest.TestCase):
    def setUp(self):
        self.workbook = Workbook(document({
            "version": 2,
            "workbook": {
                "sheetOrder": ["sales", "other"],
                "sheets": {
                    "other": {"name": "其他", "cellData": {}},
                    "sales": {
                        "name": "销售", "rowCount": 1000, "columnCount": 52,
                        "cellData": {
                            "0": {"0": {"v": "名称"}, "1": {"v": 0}, "2": {"v": 1, "t": 3}},
                            "1": {"0": {"p": {"body": {"dataStream": "苹果\r\n"}}}, "1": {"v": 12.5}},
                            "2": {"1": {"f": "=SUM(B1:B2)", "v": 12.5}},
                            "3": {"1": {"f": "=B3*2"}},
                            "4": {"26": {"v": "AA5"}},
                        },
                    },
                },
            },
        }))

    def test_tab_order_name_and_metadata(self):
        self.assertEqual(self.workbook.sheet_names, ("销售", "其他"))
        self.assertIs(self.workbook.sheet(0), self.workbook.sheet("销售"))
        self.assertEqual(self.workbook.revision, 7)
        self.assertEqual(self.workbook.title, "销售表")
        with self.assertRaises(KeyError):
            self.workbook.sheet("missing")
        with self.assertRaises(IndexError):
            self.workbook.sheet(-1)

    def test_values_preserve_types_blanks_rich_text_and_formula_cache(self):
        self.assertEqual(self.workbook.sheet().range("A1:C3").values, [
            ["名称", 0, True], ["苹果", 12.5, None], [None, 12.5, None],
        ])
        self.assertEqual(self.workbook.sheet().range("B3:B4").formulas, [["=SUM(B1:B2)"], ["=B3*2"]])

    def test_absolute_and_wide_references_and_detached_values(self):
        self.assertEqual(self.workbook.sheet().range("$aa$5").values, [["AA5"]])
        values = self.workbook.sheet().range("B1").values
        values[0][0] = "changed"
        self.assertEqual(self.workbook.sheet().range("B1").values, [[0]])

    def test_missing_formula_cache_does_not_silently_send_empty_data(self):
        with self.assertRaisesRegex(ValueError, "no saved formula result"):
            self.workbook.sheet().range("B4").values
        self.workbook.sheet()._cells["3"]["1"]["v"] = None
        with self.assertRaisesRegex(ValueError, "no saved formula result"):
            self.workbook.sheet().range("B4").values

    def test_invalid_ranges_fail_before_allocation(self):
        for address in ["A0", "A1:B0", "B2:A1", "A1001", "BA1", "销售!A1", "A:A", "A1:D9999999"]:
            with self.subTest(address=address), self.assertRaises(ValueError):
                self.workbook.sheet().range(address)
        huge = Workbook(document({"version": 2, "workbook": {
            "sheetOrder": ["s"], "sheets": {"s": {"rowCount": 10000, "columnCount": 100}},
        }}))
        with self.assertRaisesRegex(ValueError, "100000"):
            huge.sheet().range("A1:Z10000")

    def test_legacy_literals_and_formula_source(self):
        workbook = Workbook(document({
            "version": 1, "columns": [{}, {}, {}],
            "rows": [{"cells": [{"value": False}, {"value": ""}, {"formula": "=1+1"}]}],
        }))
        self.assertEqual(workbook.sheet().range("A1:B1").values, [[False, ""]])
        self.assertEqual(workbook.sheet().range("C1").formulas, [["=1+1"]])
        with self.assertRaises(ValueError):
            workbook.sheet().range("C1").values
