# Kannabi

Kannabi is a modern, deployable inventory system for giving physical things identity and presence wherever they are managed.

## Development

Hono serves the API, React Router v7 Framework Mode provides the UI, and Neo4j stores domain and authentication data.
The first flow supports local sign-up/sign-in/sign-out, Group membership, and reporting, photographing, viewing, editing, and finding Assets with existing identifiers.

Use Node 24 and pnpm 10.32.0.
For a fresh full local deployment, generate credentials and start the app, Neo4j, and Alarik:

```sh
pnpm setup:env
docker compose up -d --build --wait
```

Open `http://127.0.0.1:3000` after startup.
The helper uses only Node built-ins and can also run as `node scripts/setup-env.mjs` before installing dependencies.
It creates `.env` in the current directory with independent random credentials and owner-only permissions on POSIX systems, never prints secrets, and refuses to overwrite an existing file.
It does not start services or rotate credentials in existing storage volumes.
Keep an existing deployment's `.env`; generating new credentials does not update Neo4j or Alarik's stored credentials.
For custom configuration, use `.env.example` as a reference.

For local Node/Vite development with containerized dependencies, use this alternative on a fresh checkout:

```sh
pnpm setup:env --dev
pnpm install
docker compose up -d --wait neo4j alarik
pnpm dev
```

Open `http://127.0.0.1:3000` after Vite and Hono start; this is the canonical Kannabi application origin in development.
For an existing local `.env`, set `APP_URL=http://127.0.0.1:3000` without replacing its stored credentials.
React Router/Vite may also print `http://127.0.0.1:5173`, but that listener is development tooling rather than the Kannabi browser entry point.
Hono connects to Neo4j.
Startup requires Neo4j and an accessible private S3 bucket; it installs uniqueness constraints before listening.
`GET /api/health` checks process liveness; `GET /api/ready` returns 503 if Neo4j becomes unreachable.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

The built application serves UI and API on port 3000 by default.
For the containerized application, run `docker compose up --build` after configuring `.env`.
Compose binds published ports to localhost and persists Neo4j data in a named volume.
[Alarik](https://github.com/achtungsoftware/alarik) is the default development object store, pinned to `1.0.0-beta-16`.
Compose creates a private `kannabi-photos` bucket and keeps bytes in its own named volume.
Alarik credentials and default bucket are seeded on first startup; changing environment values does not rotate existing stored credentials.
To use another S3-compatible backend, configure `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY` and provision a private bucket before starting Kannabi.
The application needs HeadBucket, PutObject, GetObject, and DeleteObject access; it does not depend on Alarik administration APIs.

## Development/demo dataset

The demo tools create 140 entirely synthetic Assets, three local email/password accounts, four Groups, three Owners, 47 photos using three bundled illustrations, and three GS1 Company Prefix namespaces.
Names, supported identifiers, relationships, and visibility are deterministic; internal keys, password hashes, and immutable reporting timestamps are generated normally.
Identifiers vary deliberately: the 140 Assets cycle through seven patterns, 20 each — no identifier, a class-level GTIN, an SGTIN with its trade-item GTIN, an externally assigned GIAI, an SGTIN beside an externally assigned GIAI, a serialised GRAI, and a type-level GRAI.
The checksum-valid values are synthetic examples, not identifiers for real inventory.
Demo Workshop manages two namespaces, Shared Studio one, and the remaining Groups none, so every allocation state is reachable.
Kannabi issues five GIAIs from `0614141`, whose existing-use exclusions make the issued references 5, 6, 7, 8 and 12.
Search by name using terms such as `camera`, `bench`, `studio`, or `backpack`; Owners appear in Asset details.

Run the tools on the host with Node 24, installed dependencies (`pnpm install`), and your existing local `.env` credentials.
For a fresh checkout, create `.env` with `pnpm setup:env --dev` first.
Stop `pnpm dev`/`pnpm start` before seeding, or stop the Compose app as below; leave Neo4j and Alarik running.

```sh
docker compose stop app
docker compose up -d --wait neo4j alarik
KANNABI_DEMO=local pnpm demo:seed
```

Seed requires empty application data and an empty media bucket; an initialized Settings node is allowed and receives optional-photo/UTC defaults.
A repeated seed fails without modifying the existing dataset rather than duplicating it.

**Reset permanently deletes all application data in the configured Neo4j database and every object in the configured `kannabi-photos` bucket, including data you created yourself, before recreating the demo.**
It preserves database schema, bucket configuration, and infrastructure credentials.
To replace an existing local development dataset yourself, stop the app and run:

```sh
KANNABI_DEMO=local pnpm demo:reset -- --yes
```

Both commands require explicit `KANNABI_DEMO=local` opt-in, non-production `NODE_ENV`, an HTTP loopback `APP_URL`, a direct loopback `bolt://` Neo4j endpoint, and a loopback HTTP S3 endpoint using the dedicated `kannabi-photos` bucket.
Use the default local Alarik setup; container service names, remote hosts, and wildcard addresses are rejected.
Demo commands also require object listing and bucket-versioning inspection permissions; enabled or suspended bucket versioning is rejected so reset cannot leave hidden media versions.
The opt-in asserts that these are dedicated, disposable development services: do not use forwarded remote ports or shared stores.
The tools refuse a responding application port; stop any other processes connected to the same stores and do not run demo commands concurrently.
If reset or seed fails partway through, keep the app stopped, fix the reported cause, and rerun the confirmed reset; database and object-storage changes cannot commit atomically together.

Resume `pnpm dev`, or `docker compose up -d --build app` for the full local deployment, with `APP_URL=http://127.0.0.1:3000`.
Use the same local configuration and infrastructure credentials as before.
All demo accounts use password **`Kannabi-demo-only-2026!`**; never expose this dataset or these credentials on a public deployment.

| Account | Role | All | Mine | Group access | Public |
| --- | --- | ---: | ---: | ---: | ---: |
| `evaluator@demo.invalid` | System administrator | 124 | 64 | 120 | 34 |
| `collaborator@demo.invalid` | Shared-Group collaborator | 88 | 56 | 72 | 34 |
| `outsider@demo.invalid` | Unrelated Group member | 50 | 20 | 20 | 34 |

Counts above apply before searching or editing; scopes overlap.
The evaluator cannot read 16 private Assets in Private Store, despite being a system administrator.
Mine filters immutable reporting provenance within readable Assets and grants no access.
The evaluator can open Administration → Members and Settings; the other accounts cannot.
The tools add no demo fields or relationships to the domain model.
`pnpm test:integration` verifies seed and destructive reset on disposable Neo4j and Alarik containers only.

## Identity integrity

Every Asset has an immutable native identity, `Asset.id`, assigned by `server/asset-id.ts` when the Asset is reported.
It is a canonical lowercase UUIDv7 (RFC 9562) generated by the `uuid` package and owned by Kannabi.
The UUIDv7 timestamp carries no domain meaning: it is never read as creation, reporting, migration, or inventory order.
`reportedAt` remains the authoritative record of when an Asset was reported.

`IdentityStore.open` establishes the invariant that every `:Asset` has a unique, canonical lowercase UUIDv7 `id`.
Assets reported before native identity existed are backfilled with a distinct UUIDv7, batch by batch.
Each batch runs in one transaction that first locks a single `:Migration` node, so a concurrently starting Kannabi waits and then observes the committed assignments instead of overwriting them; an assigned id is never replaced.
Startup then verifies presence and canonical form for every Asset, because a Neo4j uniqueness constraint establishes neither and Community Edition cannot express them.
A missing `id` is legacy data and is backfilled; a non-null `id` that is not a canonical lowercase UUIDv7 is corrupt or unsupported data, so startup fails closed and the unrecognized value is never repaired or replaced.
Uniqueness itself is enforced by the `:Asset(id)` constraint, installed once migration has completed.

Startup then migrates any pre-Phase-2 Asset from the single required SGTIN or GRAI claim to the external identifier model, under the same migration lock.
A stored SGTIN already kept its components apart; a stored GRAI is decomposed into its asset type and serial.
Legacy shape is migrated, and anything else is corruption: startup fails closed rather than repairing or discarding it.
No class-level GTIN is materialised from an SGTIN, because that fact stays derivable.

`Asset.id` addresses the Asset everywhere: lookup, editing, photos, links, and the native Asset URI.
Neo4j node identity is an implementation detail and is never exposed.
Kannabi owns its internal truth, and standards define its external contracts.

## External identification

A Kannabi Asset exists independently of GS1.
Reporting an Asset requires a name and a Group; it never requires GS1 knowledge or a GS1 identifier.
An Asset carries zero or more external identifiers, attached and detached at any time through `POST` and `DELETE /api/assets/{id}/identifiers`, and none of that changes `Asset.id`.
Carrying no external identifier is a normal state, not a deficiency.

`server/gs1.ts` is the only place GS1 rules are applied.
It accepts GTIN (AI 01), SGTIN (AI 01 with AI 21), GRAI (AI 8003) and GIAI (AI 8004), validates components, and derives everything else:

| Scheme | Input | Canonical form | Identifies |
| --- | --- | --- | --- |
| GTIN | `gtin` | `(01)00614141123452` | the trade item class |
| SGTIN | `gtin`, `serial` | `(01)00614141123452(21)A1B2` | this Asset |
| GRAI | `assetType`, optional `serial` | `(8003)00614141234561…` | the asset type, or this Asset when serialised |
| GIAI | complete existing `assetReference` | `(8004)0614141ASSET001` | this Asset |

The identification level is derived from GS1 semantics and is never supplied or edited by a caller.
An individual-level identifier identifies exactly one Asset; a class-level identifier describes any number of them.
Both facts are enforced by Neo4j uniqueness constraints on the distinct labels `:IndividualIdentifier` and `:ClassIdentifier` rather than by application sequencing, so concurrent writers cannot break them.
Those labels are persistence vocabulary for the derived level, nothing more: a `:ClassIdentifier` holding a GTIN is that GTIN, and Kannabi defines no class-identity scheme of its own.
Stored identifiers keep only their canonical form, so components and level are re-derived on every read and cannot drift.
That reversal is positional and is safe only because every component a scheme renders before its last one has a fixed length; `assertReversibleSchemes` turns any future scheme that breaks the property into a test failure rather than a corrupt read.
Each one also records the GS1 policy version that accepted it, which no later reading of the value could reconstruct.
Serials preserve case, leading zeros, and literal punctuation; they are never trimmed or URI-decoded.
GTIN/JAN accepts 8, 12, 13, or 14 digits with a valid check digit and normalizes to 14 digits.
GS1 `req=` and `ex=` association rules are applied to the AIs of one identifier, the coherent AI element string a scheme represents.
They are deliberately not applied across an Asset's identifiers: the Syntax Dictionary scopes those rules to the combined data marking a physical item, whereas an Asset's identifiers are independent records attached at different times from different sources, most of which are not marked on the item at all.
An Asset carrying a manufacturer's SGTIN beside an owner-assigned GIAI is therefore valid.
Across an Asset, Kannabi applies only its own three coherence rules: the same identifier may not appear twice, every AI (01) an Asset carries must name the same trade item, and every AI (8003) asset type it carries must name the same returnable asset type.
Identifiers of different schemes coexist freely — a Kannabi-issued GIAI, a serialised GRAI and an SGTIN on one Asset are three identities from three schemes, not a conflict.

An identifier supplied through **Record existing identifier** is an externally assigned value and is stored as syntax only; that operation neither issues the value nor claims its origin.
For a GIAI, enter the complete existing AI 8004 value, including its company prefix.
Locating a GS1 Company Prefix inside an arbitrary key requires the GS1 GCP Length Table, which is not openly available, so Kannabi makes no claim about prefix ownership or boundary for a value it did not build, and a stored identifier is never evidence that Kannabi allocated it.

## GS1 identifier issuance

A Group may configure GS1 Company Prefix namespaces and let Kannabi issue GS1 identifiers under them.
Configuring a prefix records an assertion by an authorized member, with who made it and when; Kannabi cannot verify GS1 licensing and never implies that it did.
General Specifications 26.0 §1.5 states that a licensed GS1 Company Prefix entitles its holder to allocate any GS1 identification key, which is why one namespace serves all three schemes below.

Four operations stay permanently distinct, and the UI keeps them distinct too — each has its own control, because collapsing two of them into one form where an empty field meant "allocate" hid exactly the difference the domain protects:

```text
record existing identifier   an observation. No authority required, none claimed, none conferred.
adopt managed class key      a Group asserts a GTIN or GRAI asset type it already allocated
                             into a prefix it manages, so Kannabi may issue serials under it.
allocate class key           Kannabi allocates a new GTIN or GRAI asset type from that prefix.
issue individual key         Kannabi issues a GIAI, serialised GRAI or SGTIN for one Asset.
```

**A recorded identifier can never become issuance authority.**
That is structural rather than a check: a serial is issuable only under a class-key record in a namespace the acting Group manages, and recording an identifier creates no such record, so there is no route from the first operation to the fourth.
Serialising another company's GTIN is unexpressible rather than forbidden.

The three schemes differ in where the sequence comes from:

```text
GIAI    GCP ──────────────────────────────► individual asset key
GRAI    GCP ──► asset type ──► serial ─────► individual returnable asset key
SGTIN   GCP ──► GTIN ──► serial ───────────► individual trade item key
```

`server/gs1.ts` is the only place any issued value is built.
A GIAI is the configured prefix followed by an unpadded decimal reference.
A GRAI asset type and a base GTIN share one computation — the prefix, a zero-padded reference filling the remaining digits, and the modulo-10 check digit — because the arithmetic is genuinely identical; they draw on separate counters, because §2.3 states that a GTIN and a GRAI sharing the same digits are different keys that do not conflict.
Ordering is by the stored sequence, never by comparing identifier strings.
Unlike a value Kannabi merely stores, an issued value's prefix boundary is known because Kannabi built it from a configured prefix — a statement about construction, not about licensing, so `gcppos1` stays unenforced for identifiers Kannabi did not build.

A prefix is four to twelve digits (§1.2.3.3), may not begin with the digits of another configured prefix, and may not fall in Restricted Circulation Number space, because an RCN SHALL NOT be encoded using any GS1 Application Identifier (§1.2.2.2.1) and every value Kannabi issues is an AI element string.
Publishing that length range is not the same as locating a prefix boundary inside an arbitrary key, which is what the unpublished GCP Length Table answers; the two claims are kept apart.
A prefix too long to leave a twelve-digit class reference is capability-limited, not invalid: it still issues GIAIs, and says so.
GTIN-8 allocation and adoption are refused, because a GTIN-8 comes from a GS1-8 Prefix allocated to Member Organisations (§1.2.3.2); a GTIN-14 with an indicator digit is refused too, because 1–8 identifies a trade item grouping derived from a base GTIN (§2.1.7) and 9 is variable measure whose measure data completes the identity (§2.1.10).
An externally observed GTIN-8 stays recordable through the ordinary identifier path, which claims nothing.

Adoption exists because §4.2.3 states that no downstream party may assign a different GTIN to a trade item that already has one: an operator holding a prefix already has GTINs, and an allocate-only design would push them into minting a second GTIN for an already-identified trade item.
Adoption verifies that the key's digits fall within the prefix the Group asserted — containment with exactly the standing of that assertion, and not a licensing check.
The record says which happened: `allocated` means Kannabi produced the reference; `adopted` means the Group asserted one it already held. Neither is inferred from the other.

Each counter may declare existing-use ranges such as `1-4,9-11,200-300`: numbers that were already unavailable when it was configured.
They normalise to sorted, disjoint, non-adjacent intervals, and allocation jumps over them by range rather than by number, so an exclusion covering a trillion references costs no more than one covering a single reference.
Exclusions are configuration and never a free list; what Kannabi issued is tracked only by the ledger.
A serial counter's guarantee is weaker than a reference counter's and is documented as such: §3.5.2 places serial non-duplication for a GTIN on the GTIN allocator as a party, so Kannabi discharges it for the serials it issues and records a commitment it cannot enforce for serials issued elsewhere.
Counters are inline state on whichever record owns them rather than one shared node type, so that difference stays visible where each is read.

`:Gs1ClassKeyAllocation` holds a managed class key — scheme, canonical form, prefix, sequence, provenance, active state, its serial counter and who asserted it.
It carries no name, description, product attribute, dimension or image: allocation bookkeeping is not a trade item, a product or an asset class, and a label would be the cheapest way to answer #50 by accretion.
`:Gs1KeyIssuance` is an append-only issuance ledger — `key`, `scheme`, `canonical`, `gcp`, `sequence`, `allocatedAt`, `allocatedForAssetId` and `allocatedBy`, with `ISSUED_UNDER` to the class key for a serialised GRAI or an SGTIN.
`allocatedForAssetId` is a property rather than a relationship, so the record outlives the Asset.
Kannabi's claim to have issued a value rests on these ledgers alone; nothing on the identifier marks its origin.
Seven constraints make the invariants schema facts: an issued value is issued once, a class key is managed once, issuance is idempotent per scheme per Asset, one GCP has exactly one set of counters, and namespaces, class keys and issuances are stably addressable.

That idempotency constraint is `(scheme, allocatedForAssetId)` rather than `allocatedForAssetId` alone, and the difference is deliberate.
One Asset may carry a Kannabi-issued GIAI, a serialised GRAI and an SGTIN at once.
The older single-property rule was true only because there was one scheme, and the closest thing to a normative basis for keeping it — §2.1.8's note that only one GS1 key should be marked on a single instrument — is sector-scoped to medical-device direct part marking, is a SHOULD, and is about marking a physical instrument rather than what identities a record may hold.
Per-scheme idempotency is a guarantee about the operation, not a claim that one scheme excludes another.

Issuance runs in one transaction that takes the write lock before deciding anything, so a double-click returns the same value without consuming a sequence number.
Repeating the operation always returns that scheme's existing issuance, whether or not the identifier is still attached, and leaves any other scheme's alone.
An issued value may be detached and reattached to the Asset it was issued for, and can never be attached to another — one scheme-neutral check on the canonical form; an externally assigned value keeps its ordinary correction semantics.
Deactivating a namespace or a class key stops new issuance under it and nothing else: the counters, the exclusions and every issued record survive, so reactivation resumes the same namespace or key.

Kannabi never reuses an allocated reference, class key or serial.
Most of those rules are **stricter than the GS1 floor** and are documented as Kannabi policy rather than as GS1 requirements: §4.2.5 permits GTIN reuse when the value was never published externally, §4.4.1.2 makes asset-identifier reuse absolute only in named cases, and §3.5.2 defers serial reuse to sector constraints.
Each stricter rule is justified by a fact Kannabi cannot observe — publication state, whether a value stayed on an asset, sector constraints — and overstating what a standard requires would be the same class of error as understating it.

Allocating a GTIN does not make Kannabi a product catalogue.
§4.2.6.1 states that GTIN management and product listing are two entirely autonomous decisions, and §4.2.6 leaves communicating a trade item's characteristics to trading partners with its allocator, in their own systems.
Kannabi says so where a GTIN is allocated, and models no product data.

One managed GCP belongs to one Group, because Group membership is currently the only authorization Kannabi has; this is a Kannabi authority boundary, not a GS1 organizational claim.
Any current Group member may configure a namespace, manage class keys in it and issue from it, which is deliberately broader than the eventual model and will be narrowed by Group-scoped privileges without changing allocation semantics or ledger data.
Class-key management touches no Asset and grants no Asset access; issuing an individual key additionally requires that the managing Group collaborates on the Asset.

Kannabi accepts normative 4–12 digit GS1 Company Prefixes for GS1 key allocation.
The EPC Tag Data Standard imposes additional treatment for 4- and 5-digit prefixes; EPC binary encoding and EPC URI generation are outside this release and tracked separately.

Asset links use `/asset/{id}`, and Asset-scoped photo requests use `/api/assets/{id}/photos/{key}`.
The native Asset URI carries no external identifier and never changes; what Kannabi surfaces beside it is described under GS1 Digital Link below.
Company-prefix inference and GS1-Conformant Resolver behaviour remain deferred and will be designed as explicit external interfaces.

### GS1 policy version

GS1 rules are versioned data, not application conditionals.
`server/gs1-syntax.ts` is derived from a pinned release of the [GS1 Barcode Syntax Dictionary](https://github.com/gs1/gs1-syntax-dictionary) and holds only mechanical content: component structure, character sets, lengths, check-digit requirements, and the `req=`/`ex=` associations.
`server/gs1.ts` holds the Kannabi overlay: scheme naming such as SGTIN being AI 01 with AI 21, the individual-versus-class derivation, and the policy identity itself.

The policy version is independent of the Kannabi software version:

```ts
{ version: '2026-01-27+kannabi.3', syntaxDictionaryRelease: '2026-01-27',
  generalSpecificationsRelease: '26.0', assertedBy: 'kannabi' }
```

GS1 date-versions the Syntax Dictionary and separately releases the General Specifications, and publishes no mapping between them.
`generalSpecificationsRelease` is therefore Kannabi's assertion, marked by `assertedBy`, and must never be presented as a GS1 statement.
`gcppos1` and `gcppos2` are declared unenforced rather than silently skipped, because locating a GS1 Company Prefix inside an arbitrary key needs the GCP Length Table, which GS1 does not publish openly.
That is a different claim from the prefix length range in §1.2.3.3, which is published and is enforced when a namespace is configured; the two are kept apart deliberately.

Bumping the version has exactly two triggers:

- pinning a newer Syntax Dictionary release changes `syntaxDictionaryRelease` and resets the suffix to `+kannabi.1`;
- changing the overlay — a scheme, a derivation, a Kannabi rule — while the pinned release is unchanged increments `+kannabi.N`.

A new policy governs future acceptance only.
Stored identifiers are never revalidated or rewritten, and there is no policy migration machinery.
Each identifier's stored `policyVersion` is historical provenance: it records which policy accepted that value, not a claim that the value would still be accepted today.
A missing stamp is rejected rather than replaced with the active version, because substituting it would assert an acceptance that never happened.
One thing a version bump may not change is a scheme's canonical layout: stored identifiers keep only their canonical form and are re-parsed with the active scheme definition, so altering a layout is a breaking data change requiring migration.

`IdentityStore.open(driver)` installs and verifies uniqueness constraints before returning the store.
It owns its sessions; the caller owns the driver.
Users, Groups, and Owners use internal keys, while Assets are addressed by their native `Asset.id`.
Reporting requires an existing User who belongs to the explicitly selected Group; the Group receives collaboration access atomically with the Asset.
`reportedBy` and `reportedAt` are captured by the reporting transaction; updates accept only name, Owner, and public visibility changes, so `Asset.id` cannot be changed and identifiers move only through their own explicit operations.
Owners remain independent from Users, and new Assets are private.
The API obtains the actor from the authenticated session; store reads and mutations check current Group membership in Neo4j.
Store actor arguments are trusted internal inputs, never accepted from request bodies.
Direct database access is trusted; application validation and Neo4j uniqueness constraints jointly enforce integrity.

## GS1 Digital Link

An Asset carrying a supported GS1 identity also has a standards-defined Web address, and Kannabi both constructs it and answers it.

Three levels are kept apart, and Kannabi implements the first two:

| Level | Status |
| --- | --- |
| Constructing standards-correct GS1 Digital Link URIs | implemented |
| Dereferencing the Digital Link forms Kannabi supports | implemented |
| GS1-Conformant Resolver behaviour | not implemented |

Kannabi is **not** a GS1-Conformant Resolver and must never be described as one.
It publishes no resolver description file at `/.well-known/gs1resolver`, declares no supported primary keys, answers no linkset, and handles no `linkType` or `context`.
Two status behaviours are taken from that standard because they are simply correct HTTP: a malformed Digital Link address is `400`, a well-formed one naming nothing Kannabi holds is `404`, and neither is ever `200`.

### Addresses

`Asset.id` is the identity. `/asset/{id}` is the native Asset URI: always valid, present for every Asset, and unchanged by any identifier the Asset gains or loses.
A Digital Link URI is derived from one identifier on every read and is never stored, so it cannot drift from the identifier it comes from or become a second source of truth.

| Kannabi scheme | AIs | Digital Link primary key | Path |
| --- | --- | --- | --- |
| GTIN | 01 | AI 01 | `/01/{gtin14}` |
| SGTIN | 01, 21 | AI 01 with the AI 21 qualifier | `/01/{gtin14}/21/{serial}` |
| GRAI | 8003 | AI 8003 | `/8003/0{assetType}{serial}` |
| GIAI | 8004 | AI 8004 | `/8004/{assetReference}` |

An SGTIN is not itself a Digital Link primary key: AI 01 is, and AI 21 qualifies it, so an SGTIN's path is rooted in a trade-item key.
The GRAI path carries the whole AI 8003 value, zero filler included, which is exactly what Kannabi stores after `(8003)`.
Which AI is a primary key and which qualifiers it takes in which order is the pinned Syntax Dictionary's `dlpkey` attribute, transcribed in full — including qualifiers Kannabi does not model, so the standard's data stays complete and Kannabi's narrower coverage stays a separate statement.
A guard holds every scheme to a declared primary key followed by an ordered subsequence of one declared qualifier group, so a reordered or undeclared qualifier is a test failure rather than a plausible-looking URI.

Six GS1 CSET 82 characters are not legal in a path segment and are percent-encoded: `"` `%` `/` `<` `>` `?`.
Encoding happens in one pass and decoding exactly once, and resolution matches against the raw path, because a path decoded before it is split cannot tell a separator from a `%2F` inside a GIAI or a serial.

Nothing Kannabi emits is a *canonical GS1 Digital Link URI*: the standard reserves that term for HTTPS on `id.gs1.org`.
Kannabi's own URIs are valid and non-canonical, and the word is not used for the native Asset URI either.

### Which URI is surfaced

An Asset with an eligible GS1 identity surfaces its Digital Link URI; every other Asset surfaces its native Asset URI, unqualified and not as a lesser case.
Selection is Kannabi presentation policy rather than GS1 policy: the standard expresses a GIAI and a GTIN in either order and states the two are not equivalent, so it defines what each form means without choosing between them.

- Only an individual-level identifier is eligible. A GTIN-only Digital Link denotes a trade item, not this Asset.
- GIAI, then a serialised GRAI, then SGTIN, because the first two are primary keys whose referent is the individual asset.
- A tie within one scheme breaks on the canonical form, so the same Asset surfaces the same URI on every read.
- Issuance decides nothing. A GIAI Kannabi issued does not outrank a recorded existing one; provenance grants no precedence.

Detaching the surfaced identifier changes the surfaced URI and nothing else.

The Asset page leads with its identifiers, because that is the identity the page is about; access and provenance follow under **Details**, and collaboration below them.
Each card shows the scheme, the value and its provenance, with what the scheme identifies available from the scheme name rather than spelled out beside the provenance badge, where two statements of different kinds read as one.

The native Asset URI is shown on the Asset page only when **Show Kannabi ID** is enabled in `/admin/settings`, because it is the UUIDv7 spelled as a URL and one setting governs both.
Hiding it is presentation alone: the address still resolves, still redirects, and remains what internal references and the API use.
A surfaced Digital Link URI is unaffected by the setting.

### Moving with the Asset

An identifier mutation can retire the address the viewer is standing on — detaching the GIAI whose Digital Link they navigated to — so after a successful attach, detach or issuance Kannabi recomputes where the Asset is served and navigates there if the current address is no longer one of them.
Losing the last eligible identity navigates back to the native Asset URI.

This is post-mutation client navigation, not canonicalization, and the distinction is load-bearing:

- a viewer at a **valid non-preferred** Digital Link stays there, because that address still serves the Asset;
- a retired Digital Link requested directly still resolves exactly as before, which is `404` once it no longer identifies the Asset;
- no Digital Link is ever redirected to another.

The rule is the same for every mutation rather than special-cased per scheme: leave an address that no longer serves this Asset, stay otherwise.

Mutations themselves are addressed by the native `Asset.id`, which the page carries with every submission, never by the address the form was submitted from.
A presentation address is for reaching a page: the router re-encodes a form's action URL, so a Digital Link carrying `%2F` in a serial arrives at the action as `%252F`, and an identity recovered from it would be a different identifier or none at all.
Changing an Asset's name or visibility, uploading a photo and attaching or detaching an identifier therefore behave identically however the page was reached.

### Resolution

Every supported Digital Link form renders the Asset directly with `200`. No Digital Link form ever redirects to another, including to the Asset's preferred one: preference governs presentation, and each supported form is an independent entry point to the same referent.

`/asset/{id}` answers with `307 Temporary Redirect` to the surfaced URI when one exists.
The redirect is temporary and uncacheable because the preferred identifier can be detached at any moment; `301` and `308` would invite a client to rewrite a link that is not permanent, and `303` would claim the target is a different resource when it is the same Asset.
`/api/assets/{id}/...`, internal references and persistence keys never redirect.

Rendering an Asset and redirecting to its surfaced URI are separate operations, which is what makes a loop impossible rather than merely unlikely: the only redirect target is a Digital Link address, and a Digital Link address never redirects.

Resolution grants nothing.
A Digital Link naming an Asset the reader may not see returns exactly what one naming nothing returns, because a GTIN and serial are printed on the object and a distinguishable answer would let a label tell an outsider that this instance is held here.
For the same reason `/asset/{id}` does not redirect for an Asset the reader cannot see.
Concretely, an unauthenticated request for a **private** Asset's Digital Link answers `404` even though the address is correct and the Asset exists — the same answer an unknown identifier gets, which is the point.
Signing in as a reader entitled to that Asset makes the same address resolve.

Class-level addresses such as `/01/{gtin}` return `404`.
Whether a GTIN becomes a Kannabi referent in its own right is an open architectural question, and answering with a list of Assets now would settle it by accident.

The numeric path space at the deployment's origin is reserved for Digital Link.
Digital Link URIs are constructed at the application origin; a separate Digital Link origin belongs with resolver work.
The status and redirect are decided in the server, which the single-page build cannot do for itself, so they apply to production builds rather than to the Vite dev server.

## Agent access over MCP

Kannabi exposes a domain-oriented [Model Context Protocol](https://modelcontextprotocol.io/) server over stdio, so an external agent can discover and inspect Assets without the browser UI.

```sh
pnpm build
pnpm mcp
```

`pnpm dev:mcp` runs the same server from source. A host launches it as a child process and speaks MCP on its stdin/stdout; it reads `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` from the environment or `.env`, serves no network listener, and never calls Kannabi's HTTP API. Its stdout carries the protocol; diagnostics go to stderr.

Seven tools cover the discovery workflow: `search_assets` for an incomplete description, `resolve_external_identifier` for a complete GS1 identity, `get_asset` for inspection by native Asset ID, `list_groups` and `list_gs1_namespaces` for the vocabulary those take, `list_managed_class_keys` for the GTINs and GRAI asset types a namespace may issue serials under, and `list_gs1_issuances` for Kannabi's issuance ledger.
Every result carries the native Asset ID, so a candidate from any tool can be inspected unambiguously, and each identifier is returned with the components that resolve it again.
Class-level identifiers may resolve to several Assets; individual-level identifiers resolve to at most one.
Allocation provenance is read from the ledger alone: an Asset whose stored GIAI merely begins with a managed company prefix is not reported as Kannabi-issued.

The server also states, at connection time, which facts Kannabi owns and which it does not — location, events, observations and condition belong to other systems.
That boundary is what lets a client report that Kannabi does not hold something instead of inferring it from an empty result.

The server is read-only. It attaches to a database Kannabi has already opened, verifying the uniqueness constraints instead of installing them, and exposes no write, Cypher, or graph-traversal tool.
Generic graph access, EPCIS, and observation stores stay independent MCP servers rather than being proxied here; [Neo4j's own MCP server](https://github.com/neo4j/mcp) already provides schema inspection and read-only Cypher for the underlying graph.

### Whose view the server answers with

`KANNABI_MCP_AUDIENCE` chooses between two postures.

`system`, the default, reads the entire Kannabi graph, including Assets private to a Group and the Group structure itself, applying none of Kannabi's per-User readability. Whatever can reach the process can read everything the process can read, and putting an authenticated gateway in front of it does not change that: the gateway authenticates a person, while Kannabi still answers with the whole instance. Run it this way only where every reader is already entitled to every Asset the instance holds.

`principal` answers only for an authenticated User. The gateway that launched the process asserts who it authenticated, in the `_meta` of each `tools/call`, and Kannabi resolves that assertion to one of its own Users and answers under that User's ordinary Group access — the same view the web application would give them. A request carrying no principal, an assertion Kannabi cannot read, a subject that is not a person, and an identity nobody has linked are all refused.

That assertion is trusted because of where it arrives, not because of anything it carries: on stdio the only writer to this process's stdin is whatever spawned it. It is therefore worth exactly as much as the decision to launch the server from a trusted gateway, and carries no cryptographic guarantee of its own.

An external identity is keyed by its issuer and subject together, never by email: two issuers may assert the same address for different people, and an address can be reassigned. Linking one to a Kannabi User is administrative and deliberately outside every request path, so an authenticated stranger reaches nothing until someone says whose identity it is:

```sh
pnpm identity:link alex@example.com https://idp.example.com idp-subject-1
```

The server stays read-only in both postures. Group membership remains the whole of the authorization decision; a gateway's scopes describe what it let through and never widen what Kannabi permits.

## Authentication and Group access

[Better Auth](https://better-auth.com/docs/integrations/hono) handles passwords, sessions, cookies, and local authentication.
Its [listed community Neo4j adapter](https://better-auth.com/docs/adapters/community-adapters), `neo4j-better-auth`, persists authentication in the existing database.
Authentication uses the same `User` nodes as domain provenance, with a server-assigned domain key; account and session records use separate labels.
This avoids a second application database and a custom authentication adapter.
The adapter and Better Auth versions are pinned; upgrades must pass the real Neo4j integration tests.

Create an account, open Groups from the sidebar to create a Group or ask a Group controller to add your member key, then report an Asset from the Assets workspace.
The persistent header searches accessible Assets by name on Enter; ⌘K or Ctrl+K focuses search and Escape blurs it.
The account menu provides Profile and sign-out.
Profile lets signed-in Users update their display name, change their email or password after current-password confirmation, and choose System, Light, or Dark appearance.
Changing email immediately updates both password sign-in and password-recovery delivery in the current unverified email/password model.
Changing password signs out other sessions while preserving the session performing the change.
Appearance applies the selected instance theme's corresponding palette only to that User, and System follows live browser or operating-system preference changes.
Administration → Members lists registered accounts and lets system administrators edit names and administrator status.
The final administrator cannot be revoked; concurrent role changes are serialized in Neo4j.
Profile edits retain User identity and reporting provenance, and administration grants no Asset access.
The Assets workspace shows compact photo rows and loads more inventory as you scroll.
All, Mine, Group access, and Public filter readable Assets; their overlapping counts reflect the current search.
Mine means originally reported by you and never grants access.
Identifiers, ownership, and photos remain within each Asset workflow.
A Group controller (initially its creator) can add an existing User; ordinary Group members cannot add others. Group control remains after its controller leaves membership and does not itself grant Asset or namespace access. Users can leave their own Groups.
An administrator can identify Groups with no controller through `GET /api/admin/groups/uncontrolled` and assign control to an existing active User with `POST /api/admin/groups/{key}/recover` (`{ "userKey": "..." }`). This recovery does not add membership or let the administrator read private Assets; the controller can subsequently grant membership, which does grant access.
A sole Group is selected automatically, but reporting always sends an explicit Group key.
Group members can read and edit its private Assets.
An Asset can have several collaboration Groups while keeping one Asset ID and one inventory entry.
On the Asset page, **Manage collaboration** — a disclosure below the identifiers, closed until it is asked for, because changing who collaborates is an occasional act while the Groups themselves are already stated in **Details** — lets a User who belongs to and controls an existing collaboration Group grant another Group they control access.
Control of the receiving Group supplies its consent; belonging to both Groups alone is insufficient.
This bounded workflow requires one User with both control authorities; there is no invitation/acceptance workflow between separate controllers.
A controller with current Group-derived Asset access can remove the Group they control, including the Group initially selected when reporting.
They cannot remove another Group merely by controlling their own, and at least one collaboration Group must remain, even for a public Asset.
Removing your last source of private access returns you to the inventory; other memberships and public read access still apply.
Empty or uncontrolled Groups retain collaboration, and account deletion never transfers authority.
Collaboration does not grant access to another Group's identifier namespaces.
The API uses `PUT /api/assets/{id}/collaboration/{groupKey}` to grant and `DELETE` at the same path to revoke, returning `{ "changed": true }` for a change or `{ "changed": false }` for an authorized no-op.
Both operations recheck current authority; a retry after losing access returns 404, and removing the final Group returns 409.
`reportedBy` grants no access and remains unchanged after the reporter leaves the Group.
Marking an Asset public permits anyone with its Asset URI to read the full Asset representation, never to edit it.
`Asset.id` is not a secret and grants no authorization; mutations remain Group-authorized.
New Assets are private, and there are no direct User-to-Asset ACLs.

`GET /api/assets` keeps case-insensitive name-substring search through `q` and returns `assets`, `total`, `matching`, `scopes`, and `nextCursor`.
Counts include only Assets the signed-in User can read; pages default to 30 entries, with `limit` between 1 and 100.
Pass `nextCursor` as `cursor` with the same `q` and `scope` to continue; a null cursor ends the results.
`scope` accepts `all` (default), `mine`, `group`, or `public`; the response includes matching counts for every scope.
Ordering is name followed by `Asset.id` as a deterministic tiebreaker, independent of how many external identifiers an Asset carries; each request checks current access and data rather than holding an inventory snapshot.

Unsafe API requests require an Origin matching `APP_URL`.
Better Auth rate limiting uses the TCP peer address set by the Node server; forwarded client IP headers are not trusted, so clients behind one reverse proxy share its rate-limit bucket.
Authentication routes are limited to sign-up, sign-in, sign-out, session lookup, password change, and password recovery.
External identity providers remain deferred. Identifier issuance is described under GS1 identifier issuance above.

## Photos and administration

Photos may accompany reporting or be uploaded later from the Asset page.
Supported uploads are JPEG, PNG, and WebP, up to 10 MiB each.
Bytes remain in the private bucket; Neo4j stores photo metadata and Asset relationships.
Photo retrieval always passes through the API and checks current Asset access, including public visibility.
Responses are not cached, so making an Asset private blocks subsequent anonymous photo requests.
Previously downloaded copies cannot be recalled.

Administration is explicitly granted by an operator after an account signs up:

```sh
pnpm admin:grant person@example.com
```

For the containerized application, use `docker compose exec app node dist/server/grant-admin.js person@example.com`.
Reload the application and open Settings under Administration in the sidebar to see Instance settings.
Administration permits changing the photo-on-report policy, instance display timezone, built-in instance theme, and mail delivery; it grants no Asset access.
The defaults are optional photos, UTC display, and the `default` theme.
The photo requirement applies to new reports, including direct API requests, and requires a photo in the same reporting submission.
Existing Assets remain editable without a photo when the policy changes.
All stored timestamps remain absolute instants; the configured timezone only affects presentation.

### Mail delivery

System administrators can configure SMTP delivery and send a test message from Administration → Settings.
Mail configuration is stored in Neo4j on a separate admin-only configuration surface; the public instance-settings response does not include it.
SMTP passwords are encrypted with AES-256-GCM before persistence and are never returned to the browser.
TLS, required STARTTLS, and unencrypted SMTP are supported; unencrypted SMTP cannot use authentication.
Saving an enabled configuration verifies the persisted SMTP connection, TLS mode, and authentication without undoing the save when verification fails.
Kannabi stores the latest safe verification result and observation time; opening Settings does not contact the SMTP server, and successful test delivery refreshes the observation.
Mail is disabled by default.
When mail is configured, password-based accounts can request a one-hour, single-use password-reset link from the sign-in experience.
Reset requests never disclose whether an eligible account exists or whether delivery succeeded; successful resets revoke existing sessions.
Email verification, invitations, email-change verification, and other authentication email flows remain disabled.

Kannabi generates and reuses an instance master key in its platform application-data directory.
The Compose deployment stores it in the `kannabi-data` volume at `/var/lib/kannabi/master.key`.
Native Linux follows `XDG_DATA_HOME` or `~/.local/share/kannabi`; macOS uses `~/Library/Application Support/Kannabi`; Windows uses `LOCALAPPDATA/Kannabi`.
`KANNABI_DATA_DIR` may override the directory.
Deployments that externally manage keys may set `KANNABI_SECRET_KEY` to the unpadded base64url encoding of exactly 32 random bytes.

A complete secret-bearing backup requires both the Neo4j backup and instance master key.
A database backup alone does not reveal the SMTP password, while losing the key makes the encrypted credential unreadable.
When a key is missing or wrong, Kannabi keeps non-mail functionality available, fails mail closed, and asks an administrator either to restore the key or explicitly reset all encrypted credentials.
The reset disables mail, removes encrypted credentials, and rotates the managed filesystem key; deployments using `KANNABI_SECRET_KEY` must rotate that external key through their deployment system.

Uploads reserve a short-lived metadata record before storing bytes.
The Asset and photo relationship commit together only after storage succeeds.
Failure cleanup removes bytes while retaining a retry record through the ten-minute upload lease, covering delayed storage responses.
Expired or failed uploads are retried on startup and every minute; attached photos are excluded.
If storage is unavailable, cleanup waits for recovery and the pending photo is never exposed as an Asset photo.

To evaluate an empty deployment, sign up, create a Group or join through a Group controller, report an Asset, optionally attach a GS1 identifier to it, upload/view a photo, edit its name, switch public/private visibility, and find it again by name.
Enable the photo requirement, select a display timezone, and change the built-in theme from Instance settings to exercise deployment policy and appearance.

## Capability surfaces

Kannabi answers through three surfaces: the web UI, the HTTP API, and the MCP server. They are not the same size, and are not meant to be. Each absence below is a decision, not a gap waiting to be filled, and the ones that carry meaning are explained under the table. The HTTP API is mounted at `/api`, which is why one row names an address outside it.

| Capability | Web UI | HTTP API | MCP |
| --- | --- | --- | --- |
| **Assets** | | | |
| Browse and search | yes | `GET /api/assets` | `search_assets` |
| Resolve a complete identifier | yes | `GET /api/assets/lookup` | `resolve_external_identifier` |
| Inspect one Asset | yes | `GET /api/assets/{id}` | `get_asset` |
| Report an Asset | yes | `POST /api/assets`, `POST /api/reports` | no |
| Supply identifiers while reporting | no | yes | no |
| Rename, change visibility | yes | `PATCH /api/assets/{id}` | no |
| **Source attribution** | | | |
| Read what a source record stated | yes | yes | `get_asset` |
| Supply it | no | creation only | no |
| **Identifiers** | | | |
| Record an identifier assigned elsewhere | yes | `POST /api/assets/{id}/identifiers` | no |
| Detach one | yes | `DELETE /api/assets/{id}/identifiers/{key}` | no |
| Issue a GIAI, serialised GRAI or SGTIN | yes | `POST /api/assets/{id}/giai`, `/grai`, `/sgtin` | no |
| Read an Asset's own issuances | yes | in the Asset representation | `get_asset` |
| List the issuance ledger | no | no | `list_gs1_issuances` |
| **GS1 namespaces** | | | |
| Configure or deactivate a prefix namespace | yes | `POST /api/groups/{key}/gs1-namespaces`, `PATCH /api/gs1-namespaces/{key}` | no |
| List namespaces | yes | `GET /api/gs1-namespaces` | `list_gs1_namespaces` |
| Allocate or adopt a class key | yes | `POST /api/gs1-namespaces/{key}/class-keys` | no |
| List class keys | yes | `GET /api/gs1-namespaces/{key}/class-keys` | `list_managed_class_keys` |
| **GS1 Digital Link** | | | |
| Dereference a supported address | yes | document address, not an `/api` route | path returned, never dereferenced |
| **Groups** | | | |
| Create, add a member, leave | yes | `POST /api/groups`, `POST /api/groups/{key}/members`, `DELETE /api/groups/{key}/membership` | no |
| List | yes | `GET /api/groups`, `GET /api/groups/controlled` | `list_groups` |
| Grant or remove Asset collaboration | yes | `PUT`/`DELETE /api/assets/{id}/collaboration/{groupKey}` | no |
| **Photos** | | | |
| Upload, read, delete | yes | `POST`/`GET`/`DELETE /api/assets/{id}/photos` | metadata only, never bytes |
| **Account and administration** | | | |
| Profile, appearance, account deletion | yes | `/api/profile*` | no |
| API tokens | yes | `/api/api-tokens*` | no |
| Users, settings, mail, Group recovery | yes | `/api/admin/*`, `/api/settings` | no |

### What the absences mean

**MCP writes nothing.** All seven tools are read-only, and that is the posture rather than an unfinished surface: the server attaches to a database Kannabi already opened and verifies constraints instead of installing them. An agent that should change an Asset uses the HTTP API with a credential of its own.

**The web UI does not offer source attribution, and the HTTP API accepts it only at creation.** A person reporting an Asset in a browser is reporting it to Kannabi now; they are not quoting a record that already existed somewhere else. Attribution belongs to a client loading an existing corpus, which is why it is an API field and why no path revises it afterwards.

**Reporting through the browser takes no identifiers.** The form asks for a name, a Group and optionally a photo, and identifiers are added from the Asset page afterwards. An Asset exists independently of GS1, so nothing about identification belongs on the path that brings one into existence. A client loading a corpus already holds the identifiers and supplies them in one request.

**The issuance ledger is listed only over MCP.** Per-Asset issuances reach all three surfaces through the Asset representation, which is what answers "did Kannabi issue this value" — the question allocation provenance exists for. A ledger-wide listing is a different question, about a namespace rather than an Asset, and so far only an agent inspecting allocation provenance has needed it.

**A Digital Link address is a document address.** Kannabi dereferences the forms it supports by serving the Asset page at them, outside `/api`; there is no JSON endpoint that takes one. MCP reports the path an identifier corresponds to and does not resolve it, because resolving it would grant nothing a `get_asset` call does not already answer.

**MCP returns photo metadata and never photo bytes.** The keys identify the images within Kannabi; the images themselves stay behind the HTTP photo routes and their authorization.

## Tests

```sh
pnpm test
pnpm test:setup
pnpm test:integration
```

The integration runner creates a disposable Neo4j container per suite and an Alarik container for media tests with a random password and localhost port, then stops it after testing.
To run a focused suite, pass its filename, for example `pnpm test:integration asset-collaboration.integration.test.ts`.
Tests cover canonicalization, conflicting claims, transactional and concurrent duplicate rejection, persisted authentication, password-stepped credential changes and recovery, explicit Group reporting, private/public authorization, immutable provenance after membership removal, encrypted mail configuration and recovery, live local SMTP delivery, signed S3 operations, photo authorization, policy enforcement, timezone presentation, theme persistence, and upload-failure cleanup.
It never uses the application `.env` or an existing database.
`NEO4J_TEST_IMAGE` may select a locally cached Neo4j 5 image; the default matches Compose's `neo4j:5-community`.

## Name

**Kannabi** comes from 神奈備 (*kannabi*), evoking a place or domain associated with the presence of kami.
The image fits software designed to give physical things identity and context wherever they are managed, without binding the system to one server, institution, or installation.

The application began under the name **Himoroki**, inspired by 神籬 (*himorogi*), a place or structure temporarily prepared to receive a kami.
It adopted Kannabi before accumulating public compatibility constraints: a shorter, clearer name that preserves the original connection to place, identity, and meaning.
This story explains the names without defining an architectural naming scheme: components should keep clear technical names.
