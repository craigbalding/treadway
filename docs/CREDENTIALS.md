# Supply identity credentials

Store references in `identities.json` and provision their values privately through
environment variables or a supported vault. Resolve them inside the login
operation. Reading a credential does not authenticate a browser or renew a session.

Follow [the credential setup](../src/treadway/authoring/skill/treadway-flows/references/CREDENTIALS.md#configure-your-own-identity)
for a complete reference file and Robot example, or run the synthetic example
from a generated project:

```sh
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

Use [Entra sign-in](ENTRA.md) when your app redirects to Microsoft Entra. For
1Password, RPA Vault, SafeYolo or custom retrieval, open the
[provider reference](../src/treadway/authoring/skill/treadway-flows/references/CREDENTIAL-PROVIDERS.md).
The installed setup guide is `treadway guide credentials`.
