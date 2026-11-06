import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_room_sizes as rs  # noqa: E402


def m(nbr, bldg="MC", room="2065", typ="LEC", catalog="135", days=("M", "W"), start="10:30", sd="2026-09-09"):
    return {"class_nbr": nbr, "building": bldg, "room": room, "type": typ, "catalog": catalog,
            "days": list(days), "start": start, "end": "11:20", "start_date": sd}


class RoomSizeTests(unittest.TestCase):
    def test_largest_class_wins(self):
        sizes = rs.room_sizes([m("1"), m("2", start="12:30")], {"1": 90, "2": 140})
        self.assertEqual(sizes, {"MC 2065": 140})

    def test_cross_listed_same_time_add_up(self):
        sizes = rs.room_sizes([m("1"), m("2"), m("3", start="14:30")], {"1": 60, "2": 45, "3": 100})
        self.assertEqual(sizes["MC 2065"], 105)

    def test_labs_tutorials_placeholders_and_noncredit_ignored(self):
        meetings = [m("1", typ="LAB"), m("2", typ="TUT"), m("3", catalog="10"), m("4"), m("5", catalog="129R")]
        caps = {"1": 432, "2": 300, "3": 50, "4": 1000, "5": 25}
        self.assertEqual(rs.room_sizes(meetings, caps), {"MC 2065": 25})

    def test_seminars_count(self):
        self.assertEqual(rs.room_sizes([m("1", typ="SEM")], {"1": 28}), {"MC 2065": 28})

    def test_building_aliases_and_no_room(self):
        meetings = [m("1", bldg="PSE", room="4417"), m("2", bldg="ONLN", room="Online"), m("3", room="TBA"),
                    m("4", bldg="XYZ")]
        sizes = rs.room_sizes(meetings, {"1": 200, "2": 500, "3": 80, "4": 70}, code_of={"PSE": "E7", "MC": "MC"})
        self.assertEqual(sizes, {"E7 4417": 200})

    def test_unknown_class_numbers_skipped(self):
        self.assertEqual(rs.room_sizes([m("9")], {}), {})


if __name__ == "__main__":
    unittest.main()
