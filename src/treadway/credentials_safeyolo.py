"""Read an already-authorized SafeYolo gateway token; never unlock a host vault."""
from pathlib import Path
import os
import stat

from .credentials import CredentialUnavailable, _text, _timeout
from .sessions import HttpSession


class SafeYoloGatewayProvider:
    """Exact service/capability/account binding. No access requests or renewal.

    Only the fixed proxy-mediated Agent API is contacted. Token files are read
    at explicit resolution time. Upstream credentials never enter this process.
    """
    def __init__(self, service, capability, account, agent_token_file="/app/agent_token", timeout_seconds=5):
        self.service = _text(service)
        self.capability = _text(capability)
        self.account = _text(account)
        self.agent_token_file = Path(agent_token_file)
        self.timeout_seconds = _timeout(timeout_seconds)

    def _agent_headers(self):
        # Avoid following a replacement symlink or blocking on a pipe. This is
        # an agent-scoped API token, never a host-vault or admin credential.
        fd = os.open(self.agent_token_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError()
            token = os.read(fd, 4097)
            if len(token) > 4096:
                raise ValueError()
            token = _text(token.decode().strip())
            if any(char.isspace() for char in token):
                raise ValueError()
            return {'Authorization': 'Bearer '+token}
        finally:
            os.close(fd)

    def read(self, reference):
        if reference.name != 'token' or reference.field is not None:
            raise CredentialUnavailable("gateway_token_reference_required")
        try:
            client = HttpSession(actor='gateway-credential-reader', origin='http://_safeyolo.proxy.internal',
                credential_headers=self._agent_headers,
                max_body_bytes=1024*1024)
            response = client.request('/gateway/services', timeout_seconds=self.timeout_seconds)
            if not response.complete or response.status != 200:
                raise ValueError()
            binding = response.json()['authorized'][self.service]
            if binding['capability'] != self.capability or binding['account'] != self.account:
                raise ValueError()
            token = _text(binding['token'])
            if not token.startswith('sgw_') or any(char.isspace() for char in token):
                raise ValueError()
            return token
        except Exception:
            raise CredentialUnavailable("gateway_binding_unavailable; operator authorization may be required") from None
