/** What each part of an Asset representation is, stated once for every client.
 *
 * Kannabi already keeps apart what it observed, what it currently holds and
 * what a source record told it: `reportedAt` is Kannabi's own chronology,
 * `sourceRecord` is quoted, provenance describes the latest change. Those
 * distinctions live in the shape of the data, but a shape does not say what it
 * means. A client reading `reportedAt` beside `sourceRecord.recordedAt` sees two
 * instants and nothing that says which, if either, is when the thing was
 * acquired. Until now only the MCP server said so, in prose an HTTP client
 * never received, so each kind of client had to be told separately and could
 * be told differently.
 *
 * This is the one statement. The HTTP API serves it and points every Asset
 * response at it; the MCP server serves it as a tool and renders its connection
 * instructions' knowledge boundary from it. It is data, not behaviour: nothing
 * here is read to decide what Kannabi does, so it cannot change an answer, only
 * describe one.
 *
 * It describes fields Kannabi has and facts Kannabi lacks, and adds neither. A
 * fact listed under `unheld` is absent from Kannabi by decision, and a source's
 * mention of one stays inside the quoted description.
 */

/** How a part of the representation came to be true. */
export const standings = {
  identity: 'Kannabi\'s own identity for the Asset. Assigned once and never changed; it states nothing about the thing beyond which one it is.',
  record: 'An immutable record of something that happened in Kannabi: who did it and when, by Kannabi\'s own clock. It describes the Kannabi write, never an event in the physical world.',
  state: 'What Kannabi currently holds, as last set by somebody with access. Editable, with no history and no temporal qualification: it is the current value only, asserted by whoever last wrote it, and Kannabi does not verify it against the world.',
  quoted: 'What a pre-existing source record states, kept exactly as accepted. Kannabi asserts only that the source says so, never that it is true, current, or Kannabi\'s own account.',
  derived: 'Computed from other fields on every read and never stored. It adds no knowledge of its own.',
} as const;
export type Standing = keyof typeof standings;

/** Whose clock an instant was read from. */
export const clocks = {
  kannabi: 'Taken by Kannabi when the write it describes happened. Exact for that write, and the time of nothing else.',
  source: 'Stated by a source record about itself. Kannabi did not observe it and cannot confirm it.',
} as const;
export type Clock = keyof typeof clocks;

export type FieldSemantics = Readonly<{
  /** Where the field sits in each surface's Asset object, `[]` marking a list
   * element. Null where that surface does not carry it. */
  paths: Readonly<{ http: string | null; mcp: string | null }>;
  standing: Standing;
  means: string;
  /** Present exactly on instants: whose clock, and the time of what. */
  time?: Readonly<{ clock: Clock; instantOf: string }>;
  /** What null or an empty list means here. */
  absent?: string;
  /** Readings of this field a client must not make. */
  never?: readonly string[];
}>;

export type UnheldFact = Readonly<{ fact: string; statement: string }>;

export type AssetSemantics = Readonly<{
  /** Increments when any meaning stated here changes. */
  version: number;
  /** The only instant that orders or dates Assets. */
  chronology: 'reportedAt';
  absence: string;
  standings: typeof standings;
  clocks: typeof clocks;
  fields: readonly FieldSemantics[];
  unheld: readonly UnheldFact[];
  quotedMentions: string;
}>;

const physicalEvent = 'the time of any physical or business event: acquisition, manufacture, receipt, loan, transfer or disposal';

const fields: readonly FieldSemantics[] = [
  { paths: { http: 'id', mcp: 'assetId' }, standing: 'identity',
    means: 'The native Kannabi Asset ID. Stable, and meaningful only inside Kannabi.',
    never: ['a date: its embedded UUIDv7 timestamp has no domain meaning',
      'the Asset\'s primary domain identity, which identifiers carry with their own schemes'] },
  { paths: { http: 'name', mcp: 'name' }, standing: 'state',
    means: 'The name somebody gave the Asset in Kannabi.' },
  { paths: { http: 'owner', mcp: 'owner' }, standing: 'state',
    means: 'The Owner party of record Kannabi currently holds for the Asset.',
    absent: 'Kannabi holds no Owner for this Asset. Never that the Asset is unowned, or that its owner is unknown to everybody.',
    never: ['who owned it before, or since when', 'who holds or has borrowed it', 'an access grant'] },
  { paths: { http: 'groups', mcp: 'groups' }, standing: 'state',
    means: 'The Groups that currently collaborate on the Asset in Kannabi, and through which access is derived.',
    never: ['ownership, custody or location'] },
  { paths: { http: 'isPublic', mcp: 'isPublic' }, standing: 'state',
    means: 'Whether the Asset is readable without signing in.',
    never: ['a location, condition or availability'] },
  { paths: { http: 'identifiers', mcp: 'identifiers' }, standing: 'state',
    means: 'The external identifiers currently attached to the Asset. Each was accepted onto it, which is not a verification that it is correct.',
    absent: 'No identifier is attached. An ordinary state, not missing data.' },
  { paths: { http: 'identifiers[].level', mcp: 'identifiers[].level' }, standing: 'derived',
    means: 'Whether the identifier identifies this one Asset or describes a class of things, derived from its scheme.' },
  { paths: { http: 'identifiers[].components', mcp: 'identifiers[].components' }, standing: 'derived',
    means: 'The identifier\'s parts, parsed from its canonical form.' },
  { paths: { http: null, mcp: 'identifiers[].digitalLink' }, standing: 'derived',
    means: 'The GS1 Digital Link path Kannabi dereferences to this Asset for an individual-level identifier.' },
  { paths: { http: 'identifiers[].policyVersion', mcp: 'identifiers[].gs1PolicyVersion' }, standing: 'record',
    means: 'The Kannabi GS1 policy version that accepted the value. Never revalidated.' },
  { paths: { http: 'identifiers[].attachment', mcp: 'identifiers[].attachment' }, standing: 'record',
    means: 'Who accepted this identifier onto this Asset in Kannabi, through which credential, and the basis reference the request named.',
    absent: 'The association was recorded before Kannabi kept this. Unknown, never accepted by nobody.',
    never: ['a verification of the identifier', 'who issued it'] },
  { paths: { http: 'identifiers[].attachment.acceptedAt', mcp: 'identifiers[].attachment.acceptedAt' },
    standing: 'record', means: 'When the identifier was accepted onto the Asset.',
    time: { clock: 'kannabi', instantOf: 'Kannabi accepting this identifier onto this Asset' },
    never: [physicalEvent, 'when the identifier was assigned or printed'] },
  { paths: { http: 'issuances', mcp: 'issuances' }, standing: 'record',
    means: 'The identifiers Kannabi itself issued for this Asset, from its issuance ledger.',
    absent: 'Kannabi issued nothing for this Asset, whatever identifiers it carries.' },
  { paths: { http: 'issuances[].allocatedAt', mcp: 'issuances[].allocatedAt' }, standing: 'record',
    means: 'When Kannabi issued the value.',
    time: { clock: 'kannabi', instantOf: 'Kannabi issuing this value' }, never: [physicalEvent] },
  { paths: { http: null, mcp: 'kannabiIssued' }, standing: 'derived',
    means: 'The scheme and value of each issuance, repeated so a search result carries them.' },
  { paths: { http: 'reportedAt', mcp: 'reportedAt' }, standing: 'record',
    means: 'When Kannabi learned of the Asset. For an Asset loaded from another system, this is when it was loaded. The only Asset chronology.',
    time: { clock: 'kannabi', instantOf: 'Kannabi recording this Asset: its report, or its import from another system' },
    never: [physicalEvent, 'when a source system first recorded it, which only sourceRecord.recordedAt states'] },
  { paths: { http: 'reportedBy', mcp: 'reportedBy' }, standing: 'record',
    means: 'The Kannabi User who reported the Asset, or whose credential loaded it. Immutable provenance.',
    never: ['the person a source record names as its recorder', 'an owner, custodian or supplier', 'an access grant'] },
  { paths: { http: 'provenance', mcp: 'provenance' }, standing: 'record',
    means: 'Who made the latest change to the Asset true in Kannabi, through which credential, and the basis reference that change named. Latest change only, never a history.',
    absent: 'The Asset was last written before Kannabi recorded this. Never that it has not changed.' },
  { paths: { http: 'provenance.acceptedAt', mcp: 'provenance.acceptedAt' }, standing: 'record',
    means: 'When the latest change was accepted.',
    time: { clock: 'kannabi', instantOf: 'Kannabi accepting the latest change to this Asset' },
    never: [physicalEvent] },
  { paths: { http: 'provenance.basis', mcp: 'provenance.basis' }, standing: 'record',
    means: 'An opaque reference the asserting client gave for the latest change. Kannabi never resolves or interprets it.',
    never: ['evidence in itself', 'where the Asset came from, which sourceRecord.reference states and which never moves'] },
  { paths: { http: 'sourceRecord', mcp: 'sourceRecord' }, standing: 'quoted',
    means: 'The pre-existing record the Asset was created from, as that record describes itself. Fixed at creation.',
    absent: 'No source record was attributed when the Asset was created. Never that it has no history elsewhere.' },
  { paths: { http: 'sourceRecord.reference', mcp: 'sourceRecord.reference' }, standing: 'quoted',
    means: 'An opaque reference to the source record, owned by whoever supplied it. How to ask the source for more than Kannabi holds.' },
  { paths: { http: 'sourceRecord.recordedAt', mcp: 'sourceRecord.recordedAt' }, standing: 'quoted',
    means: 'The instant the source record states it recorded the Asset.',
    time: { clock: 'source', instantOf: 'the source system registering its record of this Asset, as the source states' },
    absent: 'The source stated no time. Never that it was recorded now.',
    never: [physicalEvent, 'when Kannabi learned of the Asset', 'a sort key or filter'] },
  { paths: { http: 'sourceRecord.recordedBy', mcp: 'sourceRecord.recordedBy' }, standing: 'quoted',
    means: 'The name the source record states recorded the Asset. Display text that resolves to nobody.',
    absent: 'The source stated no name.',
    never: ['a Kannabi User or who reported it', 'an owner, custodian or supplier'] },
  { paths: { http: 'sourceRecord.description', mcp: 'sourceRecord.description' }, standing: 'quoted',
    means: 'The source record\'s own description of the Asset, exactly as accepted. Every statement inside it is the source\'s, carrying whatever date the text itself gives, or none.',
    absent: 'No description is recorded in Kannabi. Never that the source had none.',
    never: ['Kannabi\'s description of the Asset', 'current state: a place, holder, owner or status it mentions is what the source said, at a time the text may not give'] },
  { paths: { http: 'photos', mcp: 'photos' }, standing: 'state',
    means: 'The photos currently attached to the Asset.' },
  { paths: { http: 'photos[].createdAt', mcp: 'photos[].createdAt' }, standing: 'record',
    means: 'When Kannabi received the photo.',
    time: { clock: 'kannabi', instantOf: 'Kannabi receiving this photo upload' },
    absent: 'Kannabi did not record when it received the photo.',
    never: ['when the photo was taken', physicalEvent] },
  { paths: { http: null, mcp: 'photoCount' }, standing: 'derived', means: 'How many photos are attached.' },
  { paths: { http: null, mcp: 'surfacedPath' }, standing: 'derived',
    means: 'The address Kannabi presents for the Asset. Presentation only; the Asset ID is its identity.' },
];

/** Facts no Asset representation holds, each answered by "Kannabi does not
 * know" rather than by anything inferred from the fields above. The MCP
 * connection instructions list these verbatim. */
const unheld: readonly UnheldFact[] = [
  { fact: 'acquisition',
    statement: 'when, how or from whom an Asset was acquired — a purchase, donation or transfer in — or what it cost' },
  { fact: 'location', statement: 'where an Asset is now or where it has been' },
  { fact: 'custody', statement: 'who holds an Asset, or who has borrowed or lent it, now or at any earlier time' },
  { fact: 'ownership-history',
    statement: 'who owned an Asset before, or since when; owner is only the party of record Kannabi currently holds' },
  { fact: 'events',
    statement: 'business-process or supply-chain events involving it, such as commissioning, transfer, maintenance or disposal, which an EPCIS repository owns' },
  { fact: 'observations', statement: 'sensor readings, telemetry, or any other observation' },
  { fact: 'condition',
    statement: 'an Asset\'s condition, availability, bookings, maintenance history, or whether it is still in service' },
  { fact: 'unknown-identifiers', statement: 'anything about an identifier Kannabi was never told' },
];

export const assetSemantics: AssetSemantics = Object.freeze({
  version: 1,
  chronology: 'reportedAt',
  absence: 'An Asset representation is what Kannabi holds, not everything that is true. A fact absent here is one Kannabi was not told, never evidence that it is false.',
  standings,
  clocks,
  fields,
  unheld,
  quotedMentions: 'A source record\'s description may mention any of the facts Kannabi does not hold. Such a mention stays the source\'s statement: Kannabi derives no field, date or current state from it.',
});
