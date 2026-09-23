import { useEffect, useRef, useState } from 'react';
import { Form, useLocation } from 'react-router';
import { Icon } from './icon';
import { isApplePlatform, platformHint, searchKeyShortcuts, searchShortcutHint } from './platform';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';

/** The head of the workspace: how wide the navigation is, and how to search.
 *
 * The control that narrows the navigation sits here, at the boundary it moves,
 * rather than inside the brand block where it competed with the tagline for a
 * row. It keeps a full-size target: this is the one control on the page whose
 * job is to be hit without looking.
 */
export function WorkspaceHeader({ enabled, search }: {
  enabled: boolean;
  search: boolean;
}) {
  const location = useLocation();
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

  return <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-card px-3 sm:px-5">
    <SidebarTrigger size="icon-lg" />
    <Separator orientation="vertical" className="mr-1 h-5" />
    {search ? <Form action="/" method="get" role="search" className="relative flex min-w-0 flex-1 items-center sm:max-w-md">
      <input type="hidden" name="scope" value={scope} />
      <label className="sr-only" htmlFor="asset-search">Search Assets by name</label>
      <span className="pointer-events-none absolute left-3 text-muted-foreground"><Icon name="search" /></span>
      <Input ref={field} key={q} id="asset-search" name="q" type="search" maxLength={200}
        placeholder="Search assets by name…" defaultValue={q} disabled={!enabled}
        className="bg-muted ps-9 pe-16" />
      <button type="button" disabled={!enabled} onClick={() => { field.current?.focus(); field.current?.select(); }}
        aria-label="Focus Asset search" aria-keyshortcuts={searchKeyShortcuts}
        className="absolute end-1.5 rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground disabled:opacity-50">
        <kbd>{searchShortcutHint(applePlatform)}</kbd>
      </button>
    </Form> : null}
  </header>;
}
