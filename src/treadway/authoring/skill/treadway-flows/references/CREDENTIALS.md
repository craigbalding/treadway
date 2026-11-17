# Credentials and optional vaults

Keep credential references in your flow configuration and values in environment
variables or a supported vault. Treadway resolves the named value when your login
operation asks for it. It does not log in or renew a session merely by reading a secret.

## Run the example

From a generated project:

```sh
CHROME_BIN=/absolute/path/to/chromium python run.py test --suite collaboration.robot
```

The runner supplies synthetic credentials. `identities.json` names them;
`collaboration.robot` resolves them and passes them to an explicit login keyword.
Anonymous sessions do not read credentials.

## Configure your own identity

Save a reference-only `identities.json` beside your adapter:

```json
{
  "providers": {"env": {"type": "environment"}},
  "identities": {
    "reviewer": {
      "expected": {"principal": "user-b"},
      "credentials": {
        "username": {"provider": "env", "name": "REVIEWER_USERNAME"},
        "password": {"provider": "env", "name": "REVIEWER_PASSWORD"}
      }
    }
  }
}
```

Provision those variables privately before running the flow. `expected` describes
what your application identity probe must find; it does not prove that user is
signed in. Missing references fail instead of choosing another account. An
explicitly empty value stays empty for intentional negative tests.

In Robot, use the shared resolver with your application's login library:

```robotframework
*** Settings ***
Library    treadway.credentials_robot.CredentialLibrary    ${CURDIR}/identities.json
Library    my_application.LoginLibrary

*** Test Cases ***
Explicit Login
    ${username}=    Get Credential    reviewer    username
    ${password}=    Get Credential    reviewer    password
    Login Actor    reviewer-browser    ${username}    ${password}
```

`Login Actor` is your application keyword. For Microsoft Entra, use the
[shared Entra flow](ENTRA.md) instead of implementing the login screens yourself.

Your Python keyword should accept `username: Secret, password: Secret` from
`robot.api.types`. Unwrap `.value` only inside that credential-consuming helper.
Keep values out of command arguments, normal input journals and returned results.
Robot's wrapper masks ordinary argument/return logs; it does not redact arbitrary
page text, screenshots or a library's own output.

For plain Python, `CredentialResolver.from_file(path).read(identity, field)`
returns a string. Call it inside the credential-consuming operation; do not print
or return that value to Robot. Imports, constructors and Robot dry-runs read no secrets.

## Choose another provider

| Source | Configuration and requirements |
| --- | --- |
| 1Password | [CLI setup and `op://` references](CREDENTIAL-PROVIDERS.md#1password) |
| RPA Vault | [Optional dependency, hosted and file modes](CREDENTIAL-PROVIDERS.md#rpa-vault) |
| SafeYolo gateway | [Already-authorized service binding](CREDENTIAL-PROVIDERS.md#safeyolo-gateway) |
| Custom provider | [Provider interface and error handling](CREDENTIAL-PROVIDERS.md#providers) |

[Provider reference](CREDENTIAL-PROVIDERS.md) covers exact text preservation,
timeouts and private retrieval. Reading a vault value is separate from verifying
the application's actual user.
