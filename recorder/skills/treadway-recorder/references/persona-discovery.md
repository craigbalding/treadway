# Discover and enrich usable personas

## Start with the context available

Assume the forms may be unknown. A client's one- or two-sentence description,
their market and the intended actor are sufficient to start selecting domains.
Use existing engagement notes and operator answers before asking again. Ask a
few focused questions only when they materially change the persona: the intended
role/journey, unusual prerequisites, or a verification contact the operator can
receive. Do not turn this into a requirements interview or ask the human to list
every field. Infer a useful first domain set and record remaining assumptions.

Refine that set using available application documentation, client/public product
information, existing captures and observed UI. Where available and authorised,
download the delivered SPA entry point and referenced scripts or public source
maps for offline inspection. Look for labels, enums, validators, locales, route
names and data models. This evidence suggests coverage; it does not prove that
a route is reachable, a field is required for this actor, or a submission works.
Record the asset version/source. Stay within existing access and scope; do not
submit forms, create accounts, enumerate hidden resources or initiate assessment
testing merely to discover persona fields. Unavailable assets are a gap, not a
reason to block persona preparation.

## Generate a generous core and selected domains

Use a coherent identity, portrait and contextual narrative. Reuse generators for
raw ingredients; the agent supplies meaningful histories and circumstances.
Core coverage includes names, contact and verification bindings, date of birth,
physical attributes, residence and citizenship, relevant identity documents,
immigration circumstances and sample personal banking/identifier records. Keep
countries and issuers explicit. One residence country must not force all
citizenships, bank accounts and historical identifiers to have that same country.
Use explicit values or applicability where relevant; avoid filling a huge
catalogue with unsupported guesses or treating a missing value as No.

Choose domain coverage from the brief, then refine it from evidence. For a
recruitment service, useful domains include education/qualifications, employment,
professional registrations, experience/subjects, eligibility, availability and
references. For insurance, choose the relevant product's financial, health,
property, vehicle or claims history. These are coverage examples, not fixed
requirements for every application.

Keep directly fillable, unambiguous values in the flat `facts` map as well as
related contextual records. Extra fact keys are available to field classification.
Do not flatten several histories into one institution/qualification value; use
explicit row-specific fact keys when the intended record is known. Structured
context supports categorical deductions, not generation of missing search text.

Concrete histories have distinct records: an education record carries its own
institution, subject, qualification, grade and dates; an employment record has
employer, role, responsibilities, achievements and dates. Explain motivations,
preferences, practical constraints and current circumstances in the narrative.
Keep it consistent with the records and rich enough to support unforeseen
questions. Do not replace history with generic prose such as 'experienced
professional'. Preserve the portrait for the same identity across journeys.

Include preferences, motivations and practical circumstances in both core and
application domains. Paint a broad, concrete picture: work/life priorities,
location and travel preferences, communication or accessibility needs, learning
goals, availability, commitments and relevant financial circumstances can all
help. Let the actual client, market and application suggest additional dimensions;
these examples must not become an exhaustive or mandatory domain checklist.
Distinguish desired arrangements, hard constraints, capabilities and current
facts: wanting at least two days working from home differs from being available
only two days, and receiving a benefit is a current circumstance rather than a
preference. Give relevant qualifiers, dates or thresholds where they change the
answer. Do not infer such circumstances from age, appearance or occupation alone.

## Check usability and consistency before handoff

Pin the generator version, seed and reference date, then save the generated
result. Check required properties, units, dates, identifier syntax/checksums and
record links in code. Derive age from date of birth and the reference date.
Locale-aware generation does not establish that address components are related,
that a country picker is constrained, or that an issuer accepts an identifier.
Use documented test fixtures where external verification is required and retain
that prerequisite if a usable fixture is unavailable.

Where Jev is available, batch named semantic checks against the facts and
narrative: contradictory current status, inconsistent histories, unsupported
claims and whether the selected domains have enough context for likely questions.
Keep individual pass/fail/uncertain outcomes; a high overall score must not hide
a failed check. The preparing agent resolves real contradictions upfront.
Overlapping study and employment or retirement with occasional work need not be
contradictions. Treat deliberate negative-test circumstances explicitly.

Use the installed recorder's parser and persona manager preflight to validate
actual fill data. Recorder 0.1.8 preserves the rich description, portrait,
structured domains/histories/preferences and revision metadata, and provides
profile-to-option deduction for missing categorical facts. Older versions such as
0.1.6 require a private dossier beside compatible flat fill data; unsupported
JSON properties do not make context available to those runtimes.

For a new identity, the optional `recorder/tools/personas` Node tool reuses pinned
Faker ingredients, DiceBear portraits and existing Treadway helpers. Read its
README and run its checks before use. It supplies ingredients, not a finished
persona: complete the relevant histories, preferences and coherent narrative.
Use cryptographic test credentials, not seeded Faker passwords. Save the private
candidate and generated portrait; preserve them during later enrichment. Never
invent a supposedly deliverable contact to satisfy a draft gap.

Readiness is a usable persona with relevant domain coverage and disclosed gaps,
not merely valid JSON or a large field count. Confirm deliverable contacts under
the main skill's existing rules; generated email syntax is not delivery.

## Revisit discovery during an engagement

Rerun discovery when more UI, requirements, SPA assets or assessment evidence
become available. Compare the new coverage with one or several selected personas.
Add missing domains, propose corrections and create additional distinct personas
where roles or circumstances need coverage. Preserve IDs, contact bindings,
credentials, portraits and existing account links. Do not regenerate an existing
identity from its seed to enrich it: call order and package versions can change
the original values.

Operator edits are authoritative. Keep their values and surface conflicting
enrichment proposals for review. Track sources and revisions, recheck affected
deductions when supporting facts change, and retain the persona revision used by
an earlier recording. A persona correction does not update an application's
stored account. Reconcile that separately; do not silently mutate the account or
rewrite earlier captures. Apply persona changes at an appropriate boundary rather
than changing facts underneath an active fill.

In 0.2 the persona manager exposes New persona, Create with AI, editable
inspection and Enrich selected. Creation/enrichment calls the configured structured
provider directly. Give the brief, market and actor; no form inventory or local
agent inbox is required. Local cryptographic credentials and distinct embedded
portraits complement model-generated histories, preferences and narrative.
Candidates are validated and reviewed before applying; original revision/signature
bindings reject late, cancelled or stale replies. Existing contacts, credentials,
manual overrides and stable history IDs remain authoritative. Enrichment does not
navigate, submit or alter an application account.

The single Fill all action uses local facts and Jev, then structured inference for
missing required content. Additions are compare-and-swap persisted before the
same native filler uses them. Its ordered executor stops on unresolved required
prerequisites and uncertain effects. Repeated histories use explicit record
bindings, exposed in the remaining-fields list, rather than ordinal guesses.

Use the local and optional named Jev checks before presenting a candidate as
ready. Expose failures and uncertainties individually and repair contradictions
upfront. During filling, Jev may deduce missing categorical answers only from
relevant redacted context plus observed options, with independent choice/support
gates. Explicit facts win; missing evidence stays a gap. Check qualifications
and repeated histories by record, rather than applying one generic institution
or degree fact to all rows. Preserve cached deduction revision/control context
and the capture's historical inputs for later flow authoring.
