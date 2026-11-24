# Generate private persona ingredients

This optional Node tool creates an initial candidate for the preparing agent.
It reuses pinned Faker ingredients, existing Treadway PPSN/password helpers and
DiceBear Lorelei. The extension does not load these Node dependencies.

From this directory, with Node 22.13 or later:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node generate.mjs --id applicant-new --role applicant --country IE --reference-date 2026-11-24 --output /path/to/private/candidate.json
npm test
```

Use a private writable output path outside the repository. An existing output
file is never overwritten. The command prints the output path and preparation
gaps, not credential values. The resulting file is private mode 0600 and contains
a cryptographically generated test password; it must not be committed or shared
as a public fixture. Rerunning a seed reproduces ingredients and the portrait,
not the random password. Preserve the saved identity and credential when enriching.

Optional `--seed`, `--given-name`, `--family-name`, `--email` and `--brief` provide
known inputs. Supply an email only after its delivery route is operator-confirmed;
the tool does not invent a mailbox. `--citizenship` and `--bank-country` are separate
from residence `--country`. The initial templates cover IE, GB, US and DE; the
main persona schema supports additional countries and arbitrary application
records authored by the agent. Unsupported jurisdictions need calibrated data.

The output deliberately remains an ingredient candidate: the agent must author a
consistent contextual narrative, discover relevant application domains, add
concrete histories/preferences/circumstances and resolve verification prerequisites.
Its `generation.remaining` records those tasks. The portrait is a stable self-contained
illustration; it is not a guarantee of physical-attribute fidelity. Identifier,
address, passport and account samples are synthetic fixtures. Local checksum
checks do not establish address deliverability, document issuance, account ownership
or acceptance by external services. The agent must check actual form requirements
before presenting a persona as usable for a real demonstration.

Use the persona manager's proposed enrichment and conflict review for an existing
identity. Do not regenerate an account's persona from a seed, replace its password,
or rewrite old captures to incorporate later corrections.
