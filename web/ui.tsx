import type { ComponentProps, ReactNode } from 'react';
import { cn } from 'cn';

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
    <div className="min-w-0">
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

/** Somewhere for a transient message to appear without moving the row. */
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
