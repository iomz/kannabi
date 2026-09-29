import { useState } from 'react';
import { schemeDescriptions, schemeLabels, schemeReference } from '../../server/gs1.js';
import { AssetName } from '../asset-name';
import { AssetVisibility } from '../asset-visibility';
import { Icon } from '../icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalRef, HelpTip, IconButton, Panel, Section, SubHeading } from '../ui';

/** A bench for the Asset-detail questions that only a human eye can settle.
 *
 * Several of these went round the loop — ship a guess, look at it, adjust the
 * guess — because a visual question cannot be answered by reasoning about it.
 * Putting the candidates side by side makes the comparison cost one look
 * instead of one release cycle.
 *
 * It is a review aid, not a feature: reachable only by typing the address, out
 * of the navigation, and deliberately not a second implementation of the Asset
 * page. Everything here is the real component or the real classes, because a
 * comparison between approximations decides nothing. Delete it when the
 * questions are closed.
 */

const names = {
  short: 'Rig 7',
  normal: 'Audio recorder · Bench 005',
  long: 'Portable multi-channel field audio recorder with preamp and timecode · Bench 005 · Returned 2026',
};

function Variant({ label, note, children }: {
  label: string; note?: string; children: React.ReactNode;
}) {
  return <div className="border-t py-5 first:border-t-0">
    <p className="mt-0 mb-3 text-[.7rem] font-[650] tracking-[.12em] uppercase text-muted-foreground">
      {label}{note && <span className="ml-2 font-normal normal-case tracking-normal opacity-70">{note}</span>}
    </p>
    {children}
  </div>;
}

/** The heading's own type scale, so a title variant is judged at its real size. */
function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="m-0 text-[clamp(1.7rem,3vw,2.2rem)] font-[650] tracking-[-.04em] [overflow-wrap:anywhere]">
    {children}
  </h3>;
}

/** Candidate treatments for the field a title becomes. Only the classes differ;
 * the interaction is the shipped one and is not what is being compared. */
const editTreatments = [
  { label: 'A · boxed input', note: 'the first shipped treatment',
    className: 'rounded-md border bg-card px-2 py-0.5' },
  { label: 'B · underline only', note: 'currently shipped, HAT preference',
    className: 'border-0 border-b-2 border-control-border bg-transparent px-0 pb-[.05em] focus:border-focus' },
  { label: 'C · underline, brand on focus', note: 'louder live state',
    className: 'border-0 border-b-2 border-border bg-transparent px-0 pb-[.05em] focus:border-brand' },
  { label: 'D · tinted field, no border', note: 'live by fill rather than by line',
    className: 'rounded-md border-0 bg-muted px-2 py-0.5' },
  { label: 'E · underline plus faint fill', note: 'both cues at low strength',
    className: 'rounded-t-md border-0 border-b-2 border-control-border bg-muted/40 px-2 pb-[.05em] focus:border-focus' },
];

function TitleField({ value, className }: { value: string; className: string }) {
  return <Heading>
    <span className="inline-flex max-w-full items-baseline gap-1">
      <input defaultValue={value} size={Math.min(Math.max(value.length + 6, 18), 52)}
        aria-label="Asset name variant"
        className={'min-w-0 max-w-full font-[inherit] text-[inherit] leading-[inherit] tracking-[inherit] outline-none ' + className} />
      <IconButton label="Save name" className="translate-y-[-.1em] hover:bg-brand/10 hover:text-brand-text">
        <Icon name="check" /></IconButton>
    </span>
  </Heading>;
}

/** Candidate glyphs for Kannabi's own contextual help. All are drawn at the
 * shipped geometry — glyph-sized box, hit area grown past it — so the question
 * is the mark, not the spacing. */
const helpGlyphs = [
  { label: 'A · circled i', note: 'currently shipped', path: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18 M12 11v6 M12 8h.01' },
  { label: 'B · circled question', note: 'reads as "explain this"', path: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18 M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7 M12 17h.01' },
  { label: 'C · bare i, no circle', note: 'quietest; may read as text', path: 'M12 10v7 M12 6.5h.01' },
  { label: 'D · bare question', note: 'quiet but unmistakably a question', path: 'M9 8.5a3 3 0 1 1 4.2 2.8c-.7.4-1.2 1-1.2 2 M12 17.5h.01' },
];

function GlyphSample({ path }: { path: string }) {
  return <span className="relative inline-flex size-[1.15rem] shrink-0 items-center justify-center rounded-[.3rem] align-[-.15em] text-muted-foreground transition-colors before:absolute before:-inset-[.4rem] before:content-[''] hover:bg-muted hover:text-foreground">
    <svg className="size-[1.15rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  </span>;
}

export default function AssetDetailLab() {
  const [visible, setVisible] = useState(false);
  return <main className="mx-auto max-w-4xl px-4 py-10">
    <div className="mb-8">
      <p className="mb-2 text-[.65rem] font-[650] tracking-[.15em] uppercase text-muted-foreground">
        Design lab</p>
      <h1>Asset detail</h1>
      <p className="max-w-prose text-[.9rem] text-muted-foreground">
        Candidates for the open visual questions on the Asset page, in the real components. Not a
        product surface: nothing here mutates anything, and it is reachable only by address.
      </p>
    </div>

    <Panel>
      <h2>1 · Title, at rest and while editing</h2>
      <p className="mt-0 text-[.85rem] text-muted-foreground">
        The interaction is settled: pencil opens, checkmark and Enter save, Escape and leaving
        cancel, and a changed value asks before discarding. What is open is how heavy the live
        field should look. The row below is the real component, so it behaves; the variants under
        it are presentation only.
      </p>
      <Variant label="At rest" note="real component — try the pencil">
        <Heading><AssetName name={names.normal} canEdit busy={false} error={null}
          onSave={() => {}} /></Heading>
      </Variant>
      {editTreatments.map((treatment) => <Variant key={treatment.label}
        label={treatment.label} note={treatment.note}>
        <TitleField value={names.normal} className={treatment.className} />
      </Variant>)}
      <SubHeading>Width behaviour, in the preferred treatment</SubHeading>
      {(['short', 'normal', 'long'] as const).map((size) => <Variant key={size}
        label={size} note={`${names[size].length} characters`}>
        <TitleField value={names[size]} className={editTreatments[1].className} />
      </Variant>)}
    </Panel>

    <Panel>
      <h2>2 · Contextual help</h2>
      <p className="mt-0 text-[.85rem] text-muted-foreground">
        Kannabi’s own explanations. The glyph sits at the end of the label it modifies, at its own
        size, with the hit area grown past it — so judge the mark rather than the gap. The first
        row is the real one and opens.
      </p>
      <Variant label="Real component" note="click or focus it">
        <p className="m-0 flex items-center gap-[.15rem] text-[.875rem]">Visibility
          <HelpTip label="About visibility">Public Assets can be read by anyone with their
            address. Editing still requires Group access.</HelpTip>
        </p>
      </Variant>
      {helpGlyphs.map((glyph) => <Variant key={glyph.label} label={glyph.label} note={glyph.note}>
        <div className="grid gap-2">
          <p className="m-0 flex items-center gap-[.15rem] text-[.875rem]">Visibility
            <GlyphSample path={glyph.path} /></p>
          <p className="m-0 flex items-center gap-[.15rem] text-[.8rem] font-[650] tracking-[.08em] uppercase text-muted-foreground">
            GS1 Digital Link<GlyphSample path={glyph.path} /></p>
        </div>
      </Variant>)}
    </Panel>

    <Panel>
      <h2>3 · GS1 scheme references</h2>
      <p className="mt-0 text-[.85rem] text-muted-foreground">
        A GS1 key definition is not Kannabi’s to explain, so a scheme name links to GS1 instead of
        carrying Kannabi’s help glyph. Open here is whether the outbound mark earns its place.
      </p>
      <Variant label="A · name links, with outbound mark" note="currently shipped">
        <div className="grid gap-2 text-[.9rem]">
          {(['gtin', 'sgtin', 'grai', 'giai'] as const).map((scheme) => <span key={scheme}
            className="inline-flex flex-wrap items-baseline gap-x-2">
            <ExternalRef href={schemeReference[scheme]} className="font-semibold"
              label={schemeLabels[scheme] + ' — GS1 reference (opens in a new tab)'}>
              {schemeLabels[scheme]}</ExternalRef>
            <span className="text-[.8rem] text-muted-foreground">{schemeDescriptions[scheme]}</span>
          </span>)}
        </div>
      </Variant>
      <Variant label="B · name links, no mark" note="quieter; behaviour less announced">
        <div className="grid gap-2 text-[.9rem]">
          {(['gtin', 'sgtin', 'grai', 'giai'] as const).map((scheme) => <span key={scheme}
            className="inline-flex flex-wrap items-baseline gap-x-2">
            <a href={schemeReference[scheme]} target="_blank" rel="noreferrer noopener"
              className="font-semibold no-underline hover:underline">{schemeLabels[scheme]}</a>
            <span className="text-[.8rem] text-muted-foreground">{schemeDescriptions[scheme]}</span>
          </span>)}
        </div>
      </Variant>
      <Variant label="C · name plain, mark carries the link" note="name stays text, reference is separate">
        <div className="grid gap-2 text-[.9rem]">
          {(['gtin', 'sgtin', 'grai', 'giai'] as const).map((scheme) => <span key={scheme}
            className="inline-flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{schemeLabels[scheme]}</span>
            <ExternalRef href={schemeReference[scheme]} label={schemeLabels[scheme] + ' — GS1 reference'}>
              <span className="sr-only">GS1 reference</span></ExternalRef>
            <span className="text-[.8rem] text-muted-foreground">{schemeDescriptions[scheme]}</span>
          </span>)}
        </div>
      </Variant>
    </Panel>

    <Panel>
      <h2>4 · Visibility</h2>
      <p className="mt-0 text-[.85rem] text-muted-foreground">
        Publishing changes who may read an Asset, so the state is a word and the change is a named,
        confirmed act rather than a toggle. The first row is the real component and opens its
        confirmation.
      </p>
      <Variant label="Real component" note={`currently ${visible ? 'public' : 'private'} — try Change visibility`}>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-[.45rem] text-[.875rem] [&_dd]:m-0 [&_dt]:text-muted-foreground">
          <AssetVisibility isPublic={visible} canEdit busy={false} error={null}
            onChange={setVisible} />
        </dl>
      </Variant>
      <Variant label="A · word plus outline action" note="currently shipped">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 text-[.875rem] [&_dd]:m-0 [&_dt]:text-muted-foreground">
          <dt>Visibility</dt>
          <dd className="flex items-center gap-3"><span className="font-[550]">Private</span>
            <Button type="button" variant="outline" size="xs">Change visibility</Button></dd>
        </dl>
      </Variant>
      <Variant label="B · badge plus quiet action" note="state reads as status">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 text-[.875rem] [&_dd]:m-0 [&_dt]:text-muted-foreground">
          <dt>Visibility</dt>
          <dd className="flex items-center gap-3"><Badge variant="secondary">Private</Badge>
            <Button type="button" variant="ghost" size="xs">Change</Button></dd>
        </dl>
      </Variant>
      <Variant label="C · word plus link action" note="lightest chrome">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 text-[.875rem] [&_dd]:m-0 [&_dt]:text-muted-foreground">
          <dt>Visibility</dt>
          <dd className="flex items-center gap-3"><span className="font-[550]">Private</span>
            <Button type="button" variant="link" size="xs" className="px-0">Change visibility</Button></dd>
        </dl>
      </Variant>
    </Panel>

    <Panel>
      <h2>5 · Section headings, for reference</h2>
      <p className="mt-0 text-[.85rem] text-muted-foreground">
        The fold treatment is settled and is here only so the variants above are judged against the
        page they sit in.
      </p>
      <Section title="Identifiers" defaultOpen>
        <p className="m-0 text-[.875rem] text-muted-foreground">Open on arrival.</p>
      </Section>
      <Section title="Details">
        <p className="m-0 text-[.875rem] text-muted-foreground">Folded on arrival.</p>
      </Section>
    </Panel>
  </main>;
}
