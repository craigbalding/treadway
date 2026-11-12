"""Cheap policy contracts. No application, browser, database or network startup."""
import copy
import unittest
from unittest.mock import Mock

from robot.api.types import Secret
from pathlib import Path
from treadway.credentials import CredentialResolver
from treadway.properties import PrerequisiteNotEstablished

from collaboration import approval_error, can_read
from collaborative_flow import CollaborativeFlow


class CollaborationTests(unittest.TestCase):
    def test_constructor_is_passive(self):
        flow = CollaborativeFlow()
        self.assertIsNone(flow.config)
        self.assertEqual(flow.actors, {})

    def test_reference_configuration_loads_without_resolving_credentials(self):
        source = CredentialResolver.from_file(Path(__file__).parent.parent/'identities.json')
        self.assertEqual(source.identity('sam').expected['principal'], 'user-sam')
        self.assertEqual(source.identity('casey').credentials['password'].name,
                         'TREADWAY_FIXTURE_CASEY_PASSWORD')

    def test_login_rejects_plaintext_before_starting_browser(self):
        flow = CollaborativeFlow()
        with self.assertRaisesRegex(AssertionError, 'native_robot_secret_required'):
            flow.open_authenticated_actor('reviewer', 'sam', 'sam', 'synthetic-only')
        self.assertEqual(flow.actors, {})

    def test_login_consumes_secret_inside_helper_and_checks_actual_identity(self):
        flow = CollaborativeFlow()
        flow.identities = Mock()
        flow.identities.identity.return_value.expected = {'principal': 'user-sam', 'tenant': 'synthetic-team'}
        flow._open_actor = Mock()
        flow._call = Mock(return_value={'complete': True, 'dispatched': True, 'status': 200,
                                        'body': {'loggedIn': True}})
        flow._request = Mock(return_value={'complete': True, 'dispatched': True, 'status': 200,
            'body': {'principal': 'wrong-user', 'tenant': 'synthetic-team'}})
        with self.assertRaises(PrerequisiteNotEstablished):
            flow.open_authenticated_actor('reviewer', 'sam', Secret('sam'), Secret('synthetic-only'))
        flow._call.assert_called_once_with('reviewer', 'login', account='sam', password='synthetic-only')
        flow._request.assert_called_once_with('reviewer', '/api/collaboration/session')

    def test_self_approval_requires_a_distinct_principal_and_current_revision(self):
        resource = {"creator": "user-casey", "revision": 4, "approvedBy": None}
        before = copy.deepcopy(resource)
        self.assertEqual(approval_error(resource, "user-casey", 4), (403, "self_approval"))
        self.assertIsNone(approval_error(resource, "user-sam", 4))
        self.assertEqual(approval_error(resource, "user-sam", 3), (409, "stale_revision"))
        self.assertEqual(approval_error(resource, "user-sam", True), (409, "stale_revision"))
        self.assertEqual(resource, before)

    def test_private_id_knowledge_does_not_change_resource_ownership(self):
        resource = {"id": "known-id", "creator": "user-casey", "kind": "private"}
        self.assertTrue(can_read(resource, "user-casey"))
        self.assertFalse(can_read(resource, "user-sam"))
        self.assertFalse(can_read(resource, None))
        self.assertTrue(can_read({**resource, "kind": "request"}, "user-sam"))
