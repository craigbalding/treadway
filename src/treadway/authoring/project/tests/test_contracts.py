"""Cheap contract checks, no browser or live application required."""
import unittest

from app import validate_edit
from adapter import ReferenceFlow


class Contracts(unittest.TestCase):
    def test_constructor_is_passive(self):
        flow = ReferenceFlow()
        self.assertIsNone(flow.config)
        self.assertEqual(flow.bindings, {})

    def test_current_issued_binding_required(self):
        flow = ReferenceFlow()
        item = {"id": "actual", "revision": 2}
        flow.bindings["actual"] = item
        flow._issued(dict(item))
        with self.assertRaisesRegex(AssertionError, "issued_current_binding_required"):
            flow._issued({"id": "actual", "revision": 1})

    def test_stale_plan_is_refused_before_browser_dispatch(self):
        flow = ReferenceFlow()
        old = {"id": "same-actual-item", "revision": 2}
        current = {"id": "same-actual-item", "revision": 3}
        flow.bindings[current["id"]] = current
        calls = []
        flow._browser = lambda *args, **kwargs: calls.append((args, kwargs))
        with self.assertRaisesRegex(AssertionError, "issued_current_binding_required"):
            flow.commit_work_item_plan({"binding": old, "expected": {"ownerId": "person-17"}})
        self.assertEqual(calls, [])
        self.assertEqual(flow.bindings[current["id"]], current)

    def test_cleanup_observes_already_absent_without_repeating_delete(self):
        flow = ReferenceFlow()
        flow.config = {"run": "synthetic", "artifacts": "/does-not-exist"}
        flow.bindings["a"] = {"id": "a"}
        calls = []
        flow._http = lambda path, *args: (calls.append((path, args)) or (404, {}))
        flow._record = lambda value: None
        flow.cleanup_reference_items()
        self.assertTrue(all(not args for _, args in calls))
        self.assertEqual(flow.bindings, {})

    def test_explicit_dates_and_actual_owner(self):
        good = {"ownerId": "person-17", "start": "2026-12-07", "due": "2026-12-11", "note": "Synthetic note"}
        self.assertEqual(validate_edit(good), good)
        for patch in ({"ownerId": "Casey Rowan"}, {"start": "2026-02-30"}, {"due": "2026-12-01"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate_edit({**good, **patch})


if __name__ == "__main__":
    unittest.main()
