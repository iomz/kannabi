import { useEffect, useRef, useState } from 'react';
import { Form, useLocation, useNavigate } from 'react-router';
import { Icon } from './icon';
import { isApplePlatform, platformHint, searchKeyShortcuts, searchShortcutHint } from './platform';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';

/** The head of the workspace: searching, and on a narrow screen, the way in.
 *
 * On a wide screen the navigation's own rail toggles it, so nothing about the
 * navigation appears here — a control for the sidebar sitting in the
 * workspace reads as belonging to the workspace.
 *
 * A narrow screen has no rail: the navigation is a sheet that is not on the
 * page until it is asked for, so the only possible place to ask is here.
 */
export function WorkspaceHeader({ enabled, search }: {
  enabled: boolean;
  search: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const field = useRef<HTMLInputElement>(null);
  // Starts at the Apple form so the first paint matches the prerendered shell,
  // then corrects itself once there is a platform to read.
  const [applePlatform, setApplePlatform] = useState(true);
  useEffect(() => setApplePlatform(isApplePlatform(platformHint())), []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && enabled) {
        event.preventDefault(); field.current?.focus(); field.current?.select();
      }
      if (event.key === 'Escape' && document.activeElement === field.current) field.current?.blur();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [enabled]);
  const params = new URLSearchParams(location.search);
  const q = params.get('q') ?? '';
  const scope = location.pathname === '/' ? params.get('scope') ?? 'all' : 'all';

  /** Clearing the search clears the results, not only the field.
   *
   * Navigating to the state an empty submission produces, rather than emptying
   * the input or synthesising a keypress: the query lives in the URL, so that
   * is the thing to change, and the field follows from it. The scope the form
   * carries is preserved, because clearing a query is not leaving the tab the
   * reader is on.
   */
  const clear = () => {
    navigate({ pathname: '/', search: new URLSearchParams({ scope }).toString() });
    field.current?.focus();
  };

  // With neither a search field nor a sheet to open there is nothing to put
  // in a bar, and an empty one is just a rule across the top of the page.
  if (!search && !isMobile) return null;

  return <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-card px-3 sm:px-5">
    {isMobile && <>
      <SidebarTrigger size="icon-lg" />
      <Separator orientation="vertical" className="mr-1 h-5" />
    </>}
    {search ? <Form action="/" method="get" role="search" className="relative flex min-w-0 flex-1 items-center">
      <input type="hidden" name="scope" value={scope} />
      <label className="sr-only" htmlFor="asset-search">Search Assets by name or source description</label>
      <span className="pointer-events-none absolute left-3 text-muted-foreground"><Icon name="search" /></span>
      {/* The native `type="search"` clear button is suppressed. It clears the
          field and nothing else, which left the results standing and the input
          disagreeing with them, and browsers place it at the field's own edge
          rather than beside the shortcut hint. Clearing is a change of state,
          so it is a control of ours that navigates. */}
      <Input ref={field} key={q} id="asset-search" name="q" type="search" maxLength={200}
        placeholder="Search by name or source description…" defaultValue={q} disabled={!enabled}
        className={'bg-muted ps-9 [&::-webkit-search-cancel-button]:hidden '
          + (q ? 'pe-[5.25rem]' : 'pe-16')} />
      {/* One group at the end of the field, so the two controls read together
          instead of the clear drifting away toward the text. */}
      <span className="absolute end-1.5 flex items-center gap-1">
        {q ? <button type="button" disabled={!enabled} onClick={clear}
          aria-label="Clear Asset search"
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 [&_.icon]:size-4">
          <Icon name="clear" />
        </button> : null}
        <button type="button" disabled={!enabled} onClick={() => { field.current?.focus(); field.current?.select(); }}
          aria-label="Focus Asset search" aria-keyshortcuts={searchKeyShortcuts}
          className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground disabled:opacity-50">
          <kbd>{searchShortcutHint(applePlatform)}</kbd>
        </button>
      </span>
    </Form> : null}
  </header>;
}
