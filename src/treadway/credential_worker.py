"""Private optional-provider child. No credentials in arguments or diagnostics."""
import contextlib
import json
import logging
import os
import sys


def main():
    try:
        config = json.load(sys.stdin)
        # This process is disposable. Suppress third-party logs even at TRACE
        # in the parent Robot run; only the selected field crosses stdout.
        logging.disable(logging.CRITICAL)
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            from RPA.Robocorp.Vault import FileSecrets, RobocorpVault
            if config['mode'] == 'file':
                os.environ['RPA_SECRET_FILE'] = config['secret_file']
                adapter = FileSecrets(config['secret_file'])
            elif config['mode'] == 'control-room':
                adapter = RobocorpVault()
            else:
                raise ValueError()
            value = adapter.get_secret(config['name'])[config['field']]
            from .credentials import _credential_text
            value = _credential_text(value)
        sys.stdout.write(json.dumps({'value': value}))
        return 0
    except Exception:
        sys.stdout.write('{"unavailable":true}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
