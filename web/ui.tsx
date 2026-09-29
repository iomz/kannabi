import type { ComponentProps, ReactNode } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Icon } from './icon';

/** The few compositions that repeat across every screen.
 *
 * These are components rather than a second stylesheet on purpose. The
 * hand-written stylesheet this replaces had grown a vocabulary — `panel`,
 * `hint`, `eyebrow` — that nothing enforced and nothing typed: a screen could
 * use half of a composition, or misspell it, and only a careful reading would
 * notice. Expressed as components, the same vocabulary is checked, and the
 * styling of each one lives in exactly one place.
 */

/** A bounded region of a page, with its own surface. */
export function Panel({ className, form, ...props }: ComponentProps<'section'> & {
  /** Narrower, because a form that is easy to read is not a full-width one. */
  form?: boolean;
}) {
  return <section {...props}
    className={cn('my-6 rounded-xl border bg-card p-6', form && 'max-w-3xl', className)} />;
}

/** Help that sits under the thing it explains. */
export function Hint({ className, ...props }: ComponentProps<'p'>) {
  return <p {...props} className={cn('text-[.8rem] text-muted-foreground [overflow-wrap:anywhere]', className)} />;
}

/** A Panel whose body folds away, with its heading as the control.
 *
 * The Asset page grows a section per capability, and a reader who came for one
 * of them should not have to scroll past the rest. Which sections start open is
 * a judgement about what a page is usually for, so each caller states it.
 *
 * `<details>` rather than a scripted disclosure: the browser already gives the
 * summary a role, keyboard operation and an expanded state, and nothing here
 * needs behaviour it does not have. The open state is presentation and lives
 * only in the DOM — it is deliberately not persisted, because a fold is not a
 * preference a reader set.
 */
export function Section({ title, defaultOpen, children, className }: {
  title: ReactNode;
  /** Open on arrival. Omitted means folded. */
  defaultOpen?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return <Panel className={className}>
    <details open={defaultOpen} className="[&>summary]:cursor-pointer [&[open]>summary]:mb-4">
      <summary><h2 className="mb-0 inline text-[1.05rem]">{title}</h2></summary>
      {children}
    </details>
  </Panel>;
}

/** Explanation, on request.
 *
 * A page that states a rule beside every fact reads as documentation with
 * controls embedded in it. The fact or the control is the normal state; the
 * sentence explaining it waits behind this.
 *
 * A popover rather than a tooltip. A tooltip opens on hover and focus and
 * closes again on click, so somebody who clicks or taps the affordance — which
 * is what people do with a question mark — watches the answer vanish. This
 * opens on activation, stays until dismissed by Escape, by clicking away or by
 * pressing the trigger again, and takes focus with it. The content is an
 * ordinary block, so prose sets in a column rather than being laid out as flex
 * items around whatever inline code it contains.
 */
export function HelpTip({ label, children, className }: {
  /** Names what is being explained, e.g. "About GS1 Digital Link". */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return <Popover>
    <PopoverTrigger
      render={<button type="button" aria-label={label} />}
      // The gap was never the margin, it was the padding: a 1.75rem box round
      // a 1rem glyph leaves .375rem of air on each side before any gap is
      // added, so the glyph read as a control standing apart from its label.
      // The visible box is now the glyph's own size and the target is grown
      // back past it with an inset pseudo-element, which keeps roughly 2rem of
      // hit area without any of it being visible.
      className={cn('relative inline-flex size-[1.15rem] shrink-0 items-center justify-center',
        'rounded-[.3rem] align-[-.15em] text-muted-foreground transition-colors',
        'before:absolute before:-inset-[.4rem] before:content-[""]',
        'hover:bg-muted hover:text-foreground',
        'aria-expanded:bg-muted aria-expanded:text-foreground [&_.icon]:size-[1.15rem]', className)}>
      <Icon name="info" />
    </PopoverTrigger>
    <PopoverContent>{children}</PopoverContent>
  </Popover>;
}

/** A pointer at somebody else's definition.
 *
 * Kannabi explains Kannabi through `HelpTip`. What a GS1 key *is* belongs to
 * GS1, and the two must not wear the same affordance: one opens a sentence
 * Kannabi wrote, the other leaves for a standard Kannabi does not own. A link
 * says that by being a link.
 */
export function ExternalRef({ href, children, label, className }: {
  href: string;
  children: ReactNode;
  /** What the destination is, for a reader who cannot see the glyph. */
  label: string;
  className?: string;
}) {
  return <a href={href} target="_blank" rel="noreferrer noopener" aria-label={label}
    className={cn('inline-flex items-center gap-[.15rem] no-underline hover:underline', className)}>
    {children}
    {/* Small, and outside the text's own weight: it says "this leaves" rather
        than decorating the name. */}
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className="size-[.7em] shrink-0 opacity-60">
      <path d="M13 5h6v6 M19 5l-9 9 M17 14v5H5V7h5" />
    </svg>
  </a>;
}

/** An action carried by its glyph alone.
 *
 * Reading is the page's normal state, and a bordered button beside every fact
 * competes with the fact. The chrome arrives on hover and focus instead, so
 * the control stays discoverable without being loud. The hit target does not
 * shrink with the border: the visible box goes, the clickable one stays.
 *
 * `label` is required rather than optional — an icon with no accessible name
 * is a button nobody can read.
 */
export function IconButton({ label, tone, className, ...props }: ComponentProps<typeof Button> & {
  label: string;
  /** `destructive` keeps its warning for hover and focus rather than wearing
   * it while somebody is only reading. */
  tone?: 'destructive';
}) {
  return <Button type="button" variant="ghost" size="icon-sm" aria-label={label}
    className={cn('text-muted-foreground [&_.icon]:size-[1.05rem]',
      tone === 'destructive' && 'hover:bg-destructive/10 hover:text-destructive', className)}
    {...props} />;
}

/** A heading inside a Section, for a group that is part of one subject rather
 * than a subject of its own. */
export function SubHeading({ className, children, ...props }: ComponentProps<'h3'>) {
  return <h3 {...props}
    className={cn('mt-6 mb-3 flex items-center gap-1 text-[.8rem] font-[650] tracking-[.08em] uppercase text-muted-foreground first:mt-0', className)}>
    {children}
  </h3>;
}

/** A small caps label naming what kind of thing this page is about. */
export function Eyebrow({ className, ...props }: ComponentProps<'p'>) {
  return <p {...props} className={cn('mb-2 text-[.65rem] font-[650] tracking-[.15em] uppercase text-muted-foreground', className)} />;
}

/** The title of a page, and whatever belongs beside it. */
export function PageHeading({ eyebrow, title, description, children, className }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** A sentence under the title, saying what this page is for. */
  description?: ReactNode;
  /** Actions or status that belong on the title's own line. */
  children?: ReactNode;
  className?: string;
}) {
  return <div className={cn('mb-8 flex items-center justify-between gap-6', className)}>
    {/* The title column takes the width that is going spare, so a title which
        becomes an editable field fills the line it already occupied rather
        than shrinking to its content. */}
    <div className="min-w-0 flex-1">
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h1>{title}</h1>
      {description ? <p className="mt-[.65rem] mb-0 text-[.9rem] text-muted-foreground">{description}</p> : null}
    </div>
    {children}
  </div>;
}

/** A heading that shares its line, with a rule under both. */
export function SectionHeading({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props}
    className={cn('flex items-center justify-between gap-4 border-b pb-[1.1rem] [&_h2]:mb-0', className)} />;
}

/** Actions, and the feedback that belongs beside them. */
export function ActionRow({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('flex flex-wrap items-center gap-3', className)} />;
}

/** A stable place for action-specific errors or state to appear beside a row. */
export function ActionStatus({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} role="status" aria-live="polite" aria-atomic="true"
    className={cn('flex min-h-9 items-center', className)} />;
}

/** What a list says when it has nothing in it yet. */
export function EmptyState({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props}
    className={cn('px-4 py-14 text-center [&_p]:mx-auto [&_p]:mb-5 [&_p]:max-w-lg [&_p]:text-sm [&_p]:text-muted-foreground', className)} />;
}

/** A labelled control.
 *
 * The label wraps the control rather than pointing at it, which is what the
 * hand-written stylesheet did through a bare `label` element rule. Naming the
 * composition keeps that behaviour — clicking the words reaches the control,
 * with no id to keep in sync — without a global rule reaching every label in
 * the application.
 */
export function Field({ label, hint, className, children }: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return <label className={cn('mb-[1.15rem] grid gap-2 text-sm font-[550]', className)}>
    <span>{label}</span>
    {children}
    {hint ? <Hint className="font-normal">{hint}</Hint> : null}
  </label>;
}

/** A short, settled piece of feedback beside the control that produced it.
 *
 * Shared with the message that dismisses itself, so a result that stays and a
 * result that fades are the same object in two states rather than two designs.
 */
export const statusPillClass = 'relative inline-flex max-w-full items-center gap-[.35rem]'
  + ' overflow-hidden text-ellipsis rounded-full px-[.6rem] py-[.3rem] text-[.72rem]'
  + ' font-semibold leading-none';

export const statusPillTone = {
  success: 'bg-success-surface text-success-text',
  error: 'bg-danger-surface text-danger-text',
  info: 'bg-muted text-muted-foreground',
} as const;

export function StatusPill({ tone = 'info', className, ...props }: ComponentProps<'span'> & {
  tone?: keyof typeof statusPillTone;
}) {
  return <span {...props} className={cn(statusPillClass, statusPillTone[tone], className)} />;
}

/** The browser's own select, styled to match the shared input.
 *
 * Kannabi's choice lists are short and static, inside forms that are read and
 * submitted natively. A scripted listbox would add a popup — and, inside the
 * filter panel, a popup within a popup — for nothing the native control does
 * not already do better on a phone.
 */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select {...props} className={cn('h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50', className)} />;
}

/** A table that becomes a list of cards where a table would not fit.
 *
 * Five columns of an account do not survive a phone, and a horizontal scroll
 * hides the columns it pushes off screen. Each row becomes its own card
 * instead, with every cell labelled by the heading it sat under — which is
 * what `data-label` on a cell is for.
 */
export const stackedTableFrame = 'overflow-x-auto rounded-lg border bg-card'
  + ' max-sm:overflow-visible max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent';

export const stackedTable = [
  'max-sm:block',
  'max-sm:[&_thead]:sr-only',
  'max-sm:[&_tbody]:block',
  'max-sm:[&_tbody_tr]:mb-3 max-sm:[&_tbody_tr]:grid max-sm:[&_tbody_tr]:grid-cols-[minmax(0,1fr)_auto]',
  'max-sm:[&_tbody_tr]:gap-x-4 max-sm:[&_tbody_tr]:gap-y-2 max-sm:[&_tbody_tr]:rounded-lg',
  'max-sm:[&_tbody_tr]:border max-sm:[&_tbody_tr]:bg-card max-sm:[&_tbody_tr]:p-4',
  'max-sm:[&_td]:col-span-full max-sm:[&_td]:grid max-sm:[&_td]:grid-cols-[4.25rem_minmax(0,1fr)]',
  'max-sm:[&_td]:gap-3 max-sm:[&_td]:border-0 max-sm:[&_td]:p-0 max-sm:[&_td]:text-[.82rem]',
  "max-sm:[&_td]:before:content-[attr(data-label)] max-sm:[&_td]:before:text-[.72rem]",
  'max-sm:[&_td]:before:font-semibold max-sm:[&_td]:before:text-muted-foreground',
].join(' ');
