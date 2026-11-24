# Persona generator evaluation

This offline experiment tests reusable ingredients for a generous core persona,
application-specific records, a contextual narrative and a stable portrait. It
does not implement a production generator or the extension's persona manager.
The recorder skill's [discovery reference](../../recorder/skills/treadway-recorder/references/persona-discovery.md)
captures preparation, repeatable enrichment and operator-edit requirements.

Use Node 22.13 or later and run from this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run evaluate
```

An optional Chromium check compares rendered avatar PNGs, avoiding differences
caused only by SVG IDs or metadata:

```sh
npx playwright install chromium
npm run evaluate:avatars
# Or use an existing sandbox-capable Chromium:
# CHROME_BIN=/path/to/chromium npm run evaluate:avatars
```

Versions and transitive downloads are pinned in the local lockfile. The packages
are isolated from the recorder's dependencies. The evaluation itself makes no
network calls. It writes `artifacts/report.json` and an example avatar SVG;
[results.json](results.json) records the reviewed run on 2026-11-24. Generated
contacts are syntax fixtures, not usable verification mailboxes.

## Observations

Tested 500 records in each of IE, GB, DE and US for each data generator, 100
schema-generated records, and 500 avatars. Counts are observations of these
versions and seeds, not statistical guarantees or external verification.

| Component | Observed benefit | Integration still needed |
| --- | --- | --- |
| Faker 10.6.0 | All 2,000 composed records repeated with the same seed/reference date. All 1,500 explicitly country-constrained IE/GB/DE IBANs passed structure/checksum checks. | Explicit country and date constraints, coherent address/history relationships, stable persisted identity and application-domain choices. Locale alone does not constrain the global country picker. Age was derived by our composer, not independently guaranteed by Faker. |
| JSON Schema Faker 0.6.4 | Required properties, enums and education arrays worked in the 100 checked records. | Seed both its PRNG and the supplied Faker instance. A schema allowing a qualification before birth produces that impossible history; relationship checks and meaningful history authorship remain separate. |
| SeedFaker 0.4.0-alpha.1 | All 2,000 strict-context records repeated, names agreed with their first/last parts and country fields matched the selected locale. | Contract distinctions below. It supplies useful correlated raw fields; it is not a full dossier generator. |
| DiceBear core 10.7.0/styles 10.6.0, Lorelei | All 500 SVGs repeated. A separate Chromium check produced 500 different rendered PNGs, with a repeated control rendering identically; a 16-avatar sheet was also visually reviewed. Lorelei's packaged licence is CC0. | Attribute choices and review at the application's display size. The sample does not guarantee distinctness for all seeds or a portrait matching the persona's physical description. Save the chosen result. |
| Existing Treadway PPSN generator | 500/500 outputs passed the existing checksum/format validator. | This validates local structure/checksum, not allocation or acceptance by an identity service. |

Inserting an earlier call changed Faker's later values despite an unchanged seed.
Persist identities rather than regenerating them during enrichment. These tests
do not verify address deliverability, city/postcode geography, document issuance,
bank-account ownership, narrative coherence or actual application acceptance.

## SeedFaker: contract review before interpreting failures

The initial suitability probes were broader than some package guarantees. The
reviewed script and results distinguish those differences from a documented
guarantee that is not met:

- **Age:** the [implementation](https://github.com/edtoken/seedfaker/blob/main/rust/core/src/gen/age.rs)
  deliberately uses a reference year and assumes the birthday has not happened.
  The Node constructor's `until` is a year, not a Unix timestamp. Exact age on
  our reference day is a different requirement; derive it from date of birth.
  The script checks the documented year rule separately from exact-day age.
- **PPSN:** the [generator](https://github.com/edtoken/seedfaker/blob/main/rust/core/src/gen/pps.rs)
  emits digits and letters. Its field description promises a shape, not the
  Irish checksum. Failing our existing checksum validator does not by itself
  establish a package defect.
- **Cross-field country links:** [strict context](https://github.com/edtoken/seedfaker/blob/main/docs/context.md)
  correlates supported identity fields. Do not assume arbitrary financial fields
  share all those relationships, or require a foreign bank account to match
  current residence. The script observes IBAN prefix linkage without asserting it.
- **IBAN:** the [field documentation](https://github.com/edtoken/seedfaker/blob/main/docs/fields.md)
  explicitly promises valid check digits. The [source](https://github.com/edtoken/seedfaker/blob/main/rust/core/src/gen/iban.rs)
  fills those digits randomly, and the published native binding failed checksum
  tests. The report also uses IBANTools 4.5.4 as an independent structure/checksum
  validator, with a known valid control vector. Direct `field('iban')` probes
  also failed; this was not limited to strict record generation or an external
  bank rejecting an otherwise valid number.

On 2026-11-24 npm's `latest` and `next` both resolved to 0.4.0-alpha.1, published
2026-05-03. The [0.4.0-alpha.2 release PR](https://github.com/edtoken/seedfaker/pull/9)
was still open. The complete issue listing contained PRs and no separate bug
reports; the other open PR concerned repository relocation. No matching open
or closed checksum report was found. Absence of a report is not proof of quality.

## Recommendation

Start with Faker for constrained ingredients, existing Treadway generators where
they already meet requirements, and DiceBear for an optional illustrated portrait.
Use JSON Schema Faker if schema-driven generation saves enough custom composition
to justify it. SeedFaker remains a candidate for correlated identity ingredients;
wrap or substitute fields needing stronger guarantees. The tested release should
not supply checksum-dependent bank identifiers without replacement/validation.

The agent's role is to create rich, consistent histories, preferences and narrative
from a short application brief and available evidence. Code checks measurable
relationships; Jev checks named semantic questions upfront and, once the runtime
supports it, resolves new categorical questions during filling. A library passing
these ingredient probes does not replace that preparation and preflight work.

## Fair comparison and contract boundaries

Both providers were also tested under the same composition policy: retain their
generated birth dates, derive exact-day age locally, and explicitly bind the
requested residence country. Both then met those two constraints in 2,000/2,000
records. Our composer receives that credit, not Faker. For bank identifiers,
both providers use the same local structure/checksum checks and IBANTools.
Faker's 1,500 explicitly requested IE/GB/DE IBANs also passed that independent
validator. SeedFaker's matching locale records passed it in 0/500, 2/500 and
3/500 respectively. This establishes a difference in these samples, not issuer
acceptance or a general ranking across unrelated capabilities.

Faker's [finance contract](https://fakerjs.dev/api/finance.html#iban) warns that
random bank codes and country-specific rules can still make an IBAN invalid;
our samples do not overturn that limitation. Its global country picker and
seed/call-order behavior are documented behavior, not bugs. Our age derivation
and field relationships must not be described as raw Faker guarantees.

JSON Schema Faker's repeated output depends on seeding its own generator and
the supplied Faker instance. Accepting semantically impossible constants in a
schema that permits them is expected behavior, not a defect. These 100 record
checks exercise a bounded schema subset, not full JSON Schema compliance.

DiceBear promises seeded avatars within the chosen implementation/style; the
test pins both and uses a rendered-pixel check in addition to byte comparison.
It supplies illustrations. It does not promise photorealism, body measurements
or automatic consistency with a biography. General persona coherence, delivered
contacts, external identifier validation and appropriate domain coverage remain
outside all four packages' demonstrated guarantees.
