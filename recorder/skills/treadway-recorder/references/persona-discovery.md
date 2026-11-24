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

Use the installed recorder's parser to validate actual fill data. Recorder
0.1.6 accepts string facts, credentials, generator names and secret references;
it does not preserve a narrative, portrait or structured histories through its
persona parser, and it has no profile-to-answer inference fallback. Preserve a
rich dossier privately alongside the compatible fill data until runtime support
exists. Do not claim that adding unsupported JSON properties makes them available
to Jev, the extension or the capture. Keep references between dossier and persona.

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

The planned persona manager should make this visible through Create, Inspect,
Edit and Enrich actions, including enrichment of several selected personas. The
operator must be able to add/correct facts, histories and narrative, see the
portrait and validation gaps, and review proposed changes. A JSON textarea alone
does not satisfy that interface. These controls are requirements for future
runtime work, not capabilities shipped by this skill update.
