/** Derived from the GS1 Barcode Syntax Dictionary. Mechanical content only.
 *
 * Source:  https://github.com/gs1/gs1-syntax-dictionary
 * Release: 2026-01-27 (the `Release:` line of that release's dictionary file)
 *
 * Everything in this file is transcribed from the dictionary entries quoted in
 * `entries`. Kannabi-specific meaning — scheme naming, individual/class
 * derivation, and the General Specifications assertion — lives in `gs1.ts`.
 *
 * To update: pin a newer dictionary release, re-transcribe the entries for the
 * supported AIs, and raise the policy version in `gs1.ts`.
 */

export const syntaxDictionaryRelease = '2026-01-27';

/** GS1 CSET 82, the "X" component type. */
export const cset82 = /^[A-Za-z0-9!"%&'()*+,\-./:;<=>?_]+$/;

export type ComponentSpec = Readonly<{
  type: 'N' | 'X';
  length?: number;
  maxLength?: number;
  linters: readonly string[];
  optional?: true;
}>;

export type AiEntry = Readonly<{
  title: string;
  /** The specification field of the dictionary entry, verbatim. */
  spec: string;
  components: readonly ComponentSpec[];
  /** `req=` groups: at least one group must be fully present. */
  requires?: readonly (readonly string[])[];
  /** `ex=`: AIs that must not appear alongside this one. */
  excludes?: readonly string[];
  /** `dlpkey`: this AI may serve as a GS1 Digital Link primary key. */
  digitalLinkPrimaryKey?: true;
  /** `dlpkey=`: the alternative ordered sequences of key qualifier AIs this
   * primary key accepts, `|` separating the alternatives.
   *
   * Qualifiers are optional but their order is fixed, so a conformant URI uses
   * an ordered subsequence of one group — `(01)` with `(21)` alone is valid
   * because it skips `(22)` and `(10)` without reordering them. Transcribed in
   * full, including qualifiers Kannabi does not model, so the standard's data
   * stays complete and Kannabi's coverage stays a separate statement.
   */
  digitalLinkQualifiers?: readonly (readonly string[])[];
}>;

/** The supported subset. `dlpkey` is transcribed in full for every AI below,
 * including qualifier AIs Kannabi does not itself accept as identifier input:
 * which AIs are Digital Link primary keys, and which qualifiers each takes in
 * which order, is the dictionary's statement rather than Kannabi's.
 *
 * Transcribed lines from release 2026-01-27:
 *
 *   01         *?  N14,csum,gcppos2                  ex=255,37 dlpkey=22,10,21|235   # GTIN
 *   21             X..20                             req=01,03,8006 ex=235          # SERIAL
 *   8003        ?  N1,zero N13,csum,gcppos1 [X..16]  dlpkey                         # GRAI
 *   8004        ?  X..30,gcppos1                     dlpkey=7040                    # GIAI
 */
export const entries: Readonly<Record<string, AiEntry>> = {
  '01': {
    title: 'GTIN',
    spec: 'N14,csum,gcppos2',
    components: [{ type: 'N', length: 14, linters: ['csum', 'gcppos2'] }],
    excludes: ['255', '37'],
    digitalLinkPrimaryKey: true,
    digitalLinkQualifiers: [['22', '10', '21'], ['235']],
  },
  '21': {
    title: 'SERIAL',
    spec: 'X..20',
    components: [{ type: 'X', maxLength: 20, linters: [] }],
    requires: [['01'], ['03'], ['8006']],
    excludes: ['235'],
  },
  '8003': {
    title: 'GRAI',
    spec: 'N1,zero N13,csum,gcppos1 [X..16]',
    components: [
      { type: 'N', length: 1, linters: ['zero'] },
      { type: 'N', length: 13, linters: ['csum', 'gcppos1'] },
      { type: 'X', maxLength: 16, linters: [], optional: true },
    ],
    digitalLinkPrimaryKey: true,
  },
  '8004': {
    title: 'GIAI',
    spec: 'X..30,gcppos1',
    components: [{ type: 'X', maxLength: 30, linters: ['gcppos1'] }],
    digitalLinkPrimaryKey: true,
    digitalLinkQualifiers: [['7040']],
  },
};

/** Linter procedures Kannabi evaluates. */
export const enforcedLinters = ['csum', 'zero'] as const;

/** Linters Kannabi deliberately does not evaluate, and why. Recording this
 * keeps Kannabi from implying a check it never performed. */
export const unenforcedLinters: Readonly<Record<string, string>> = {
  gcppos1: 'Locating the GS1 Company Prefix requires the GS1 GCP Length Table, which is not openly available. Kannabi validates syntax only and makes no claim about prefix ownership or boundary.',
  gcppos2: 'As gcppos1.',
};

/** The GS1 standard modulo-10 check digit for a numeric body, which is the
 * value without its check digit. Weights alternate 3 and 1 from the rightmost
 * body digit, so a leading zero is weight-neutral and padding a value to a
 * longer fixed-length representation never changes its check digit. */
export function checkDigit(body: string): string {
  let sum = 0;
  for (let i = body.length - 1, weight = 3; i >= 0; i--, weight = 4 - weight) {
    sum += Number(body[i]) * weight;
  }
  return String((10 - sum % 10) % 10);
}

/** The `csum` linter: a numeric component whose final digit is the check digit
 * computed over everything before it. */
export function csum(value: string): boolean {
  return checkDigit(value.slice(0, -1)) === value.at(-1);
}

/** The `zero` linter: the component consists entirely of zeros. */
export function zero(value: string): boolean {
  return /^0+$/.test(value);
}
