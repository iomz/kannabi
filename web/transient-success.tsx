import { useCallback, useEffect, useRef, useState } from 'react';

export const transientSuccessDuration = 3000;
/** Long enough to read as leaving, short enough that nothing waits for it. */
export const transientExitDuration = 180;

export type TransientTone = 'success' | 'error' | 'info';

const pill = 'relative inline-flex max-w-full items-center gap-[.35rem] overflow-hidden'
  + ' text-ellipsis whitespace-nowrap rounded-full px-[.6rem] pt-[.3rem] pb-[.38rem]'
  + ' text-[.72rem] font-semibold leading-none';

const toneClass: Record<TransientTone, string> = {
  success: 'bg-success-surface text-success-text',
  error: 'bg-danger-surface text-danger-text',
  info: 'bg-muted text-muted-foreground',
};

/** A message that goes away on its own.
 *
 * Auto-dismissal is hidden temporal state: something is about to vanish and
 * nothing says when. The lifetime bar along the bottom edge is the whole of
 * the answer — it is information rather than decoration, which is why it
 * survives `prefers-reduced-motion` when the enter and exit movement does not.
 * A two-pixel rule shortening in a straight line is the least motion that can
 * carry a countdown, and removing it would hide the state again.
 *
 * Hovering or focusing the message pauses that countdown. Without it the
 * dismiss button is a three-second target, and anybody reading more slowly
 * than the timer loses the message mid-sentence.
 *
 * The timer is the authority and the bar follows it, so a browser that refuses
 * the animation still dismisses on time.
 */
export function TransientSuccess({ trigger, label, tone = 'success' }: {
  trigger: unknown;
  label: string;
  tone?: TransientTone;
}) {
  // Visible on the first render rather than after an effect, so a message
  // never appears a frame late.
  const [generation, setGeneration] = useState<number | null>(() => (trigger ? 1 : null));
  const seen = useRef(trigger);
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(transientSuccessDuration);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const dismiss = useCallback(() => {
    clear();
    setLeaving(true);
    timer.current = setTimeout(() => {
      setGeneration(null);
      setLeaving(false);
    }, transientExitDuration);
  }, [clear]);

  useEffect(() => {
    // The first render already reflects the initial trigger; only a change
    // starts a new message, so the same one is not replayed on every render.
    if (seen.current === trigger) return clear;
    seen.current = trigger;
    if (!trigger) {
      clear();
      setGeneration(null);
      setLeaving(false);
      return;
    }
    setGeneration((current) => (current ?? 0) + 1);
    setLeaving(false);
    setPaused(false);
    remaining.current = transientSuccessDuration;
    return clear;
  }, [trigger, clear]);

  useEffect(() => {
    if (generation === null || leaving || paused) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(dismiss, remaining.current);
    return () => {
      // Whatever is left when the countdown stops is what resumes, so pausing
      // holds the message rather than restarting it.
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
      clear();
    };
  }, [generation, leaving, paused, dismiss, clear]);

  if (generation === null) return null;
  const classes = [pill, toneClass[tone], 'motion-reduce:animate-none',
    leaving ? 'animate-transient-exit' : 'animate-transient-enter'].join(' ');
  return <span key={generation} className={classes} data-tone={tone} role="status" aria-live="polite"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)} onBlurCapture={() => setPaused(false)}>
    <span aria-hidden="true">{tone === 'error' ? '!' : '✓'}</span> {label}
    <button type="button" aria-label={`Dismiss: ${label}`} onClick={dismiss}
      className="-my-[.3rem] -mr-[.35rem] ml-[.1rem] rounded-full px-[.3rem] text-[.95rem] leading-none opacity-55 hover:opacity-100 focus-visible:opacity-100">×</button>
    <span data-slot="transient-lifetime" aria-hidden="true"
      className={['absolute bottom-0 left-0 h-0.5 w-full origin-left bg-current opacity-35',
        'animate-transient-lifetime', paused ? '[animation-play-state:paused]' : '',
        leaving ? 'hidden' : ''].filter(Boolean).join(' ')}
      style={{ animationDuration: `${transientSuccessDuration}ms` }} />
  </span>;
}
