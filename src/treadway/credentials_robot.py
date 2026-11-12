"""Native Robot Secret values over the optional, passive credential resolver."""
from robot.api.deco import keyword
from robot.api.types import Secret

from .credentials import CredentialResolver


class CredentialLibrary:
    ROBOT_LIBRARY_SCOPE = 'SUITE'
    ROBOT_AUTO_KEYWORDS = False

    def __init__(self, configuration):
        # Library import and Robot dry-run must not read credentials or vaults.
        self.configuration = configuration
        self._resolver = None

    def _configured(self):
        if self._resolver is None:
            self._resolver = (self.configuration if isinstance(self.configuration, CredentialResolver)
                              else CredentialResolver.from_file(self.configuration))
        return self._resolver

    @keyword
    def get_identity_expectations(self, identity):
        """Return configured expectations, not an assertion about a live session."""
        return dict(self._configured().identity(identity).expected)

    @keyword
    def get_credential(self, identity, field) -> Secret:
        """Resolve one credential explicitly; no login, renewal, cache or fallback."""
        return Secret(self._configured().read(identity, field))
