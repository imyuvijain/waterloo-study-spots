import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_site_data as b  # noqa: E402

FX = Path(__file__).parent / "fixtures"


class BuildTests(unittest.TestCase):
    def setUp(self):
        meetings = json.loads((FX / "schedule_fixture.json").read_text())
        buildings = json.loads((FX / "buildings_fixture.json").read_text())
        self.data, self.report = b.build(meetings, buildings, term=9999, term_start="2026-09-08",
                                         term_end="2026-12-11", generated="t")
        self.rooms = {r["id"]: r for r in self.data["rooms"]}

    def test_rooms_and_buildings(self):
        self.assertEqual(sorted(self.rooms), ["DC 1350", "MC 2065", "MC 2066"])
        self.assertEqual(sorted(self.data["buildings"]), ["DC", "MC"])
        self.assertIn("polygon", self.data["buildings"]["MC"])
        self.assertNotIn("polygon", self.data["buildings"]["DC"])

    def test_dropped_and_reported(self):
        self.assertEqual(self.report["dropped_no_room"], 3)  # null, TBA, ONLINE
        self.assertEqual(self.report["unknown_buildings"], {"ZZZ": ["101"]})

    def test_exact_duplicate_deduped_and_weekdays_numeric(self):
        busy = self.rooms["MC 2065"]["busy"]
        self.assertEqual(sorted(busy), ["1", "2", "3", "4", "5"])
        self.assertEqual(busy["1"], [[630, 680, "2026-09-08", "2026-12-01", "CS 135 LEC 001"]])

    def test_null_dates_filled_with_term_range(self):
        self.assertEqual(self.rooms["MC 2065"]["busy"]["2"],
                         [[510, 590, "2026-09-08", "2026-12-11", "MATH 135 LEC 001"]])

    def test_cross_listed_merged_into_one_interval_with_both_labels(self):
        t = self.rooms["MC 2066"]["busy"]["2"]
        self.assertEqual(t[0][4], "AMATH 449 LEC 001 / PHYS 449 LEC 001 / CS 246 LEC 001")

    def test_adjacent_merged_only_when_same_date_range(self):
        # 13:00-14:20 + touching 14:20-15:20 (same range) merge; TUT 15:00-16:00 has another range: NOT merged
        t = self.rooms["MC 2066"]["busy"]["2"]
        self.assertEqual([x[:4] for x in t],
                         [[780, 920, "2026-09-08", "2026-12-11"],
                          [900, 960, "2026-10-01", "2026-11-01"]])
        # same date range + touching (09:00-09:50 and 09:50-10:30) -> merged
        self.assertEqual(self.rooms["DC 1350"]["busy"]["5"],
                         [[540, 630, "2026-09-08", "2026-12-04", "ECE 106 LEC 001 / ECE 106 LEC 002"]])

    def test_day_tokens(self):
        self.assertEqual(b.normalise_days(["M", "T", "W", "Th", "F"]), [1, 2, 3, 4, 5])
        self.assertEqual(b.normalise_days(["Sa", "Su"]), [6, 7])
        with self.assertRaises(ValueError):
            b.normalise_days(["Xx"])


if __name__ == "__main__":
    unittest.main()
