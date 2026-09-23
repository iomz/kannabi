import { useEffect, useId, useRef, useState } from 'react';
import { filterTimezones } from './timezones';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function TimezonePicker({ name, value, disabled = false, onChange }: {
  name: string; value: string; disabled?: boolean; onChange?(value: string): void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(value);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = filterTimezones(query);
  const listId = `${id}-list`;
  const activeId = matches[active] ? `${id}-option-${active}` : undefined;

  useEffect(() => { setSelected(value); }, [value]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  useEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId, open]);

  function choose(zone: string) {
    setSelected(zone);
    if (zone !== selected) onChange?.(zone);
    setQuery('');
    setOpen(false);
    trigger.current?.focus();
  }
  function openPicker() {
    setQuery('');
    setActive(0);
    setOpen(true);
  }

  return <div ref={root} className="relative mb-[1.15rem] grid max-w-[30rem] gap-2"
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <Label id={`${id}-label`} htmlFor={`${id}-trigger`}>Display timezone</Label>
    <input type="hidden" name={name} value={selected} readOnly />
    <button id={`${id}-trigger`} ref={trigger} type="button" disabled={disabled}
      className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-card px-2.5 py-1 text-left text-sm shadow-xs outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
      aria-labelledby={`${id}-label ${id}-value`} aria-controls={listId} aria-expanded={open} aria-haspopup="listbox"
      onClick={() => open ? setOpen(false) : openPicker()}>
      <span id={`${id}-value`}>{selected}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div className="absolute inset-x-0 top-[calc(100%+.25rem)] z-[4] rounded-lg border border-input bg-card p-[.65rem] shadow-xl">
      <Label className="sr-only" htmlFor={`${id}-search`}>Search timezones</Label>
      <Input id={`${id}-search`} ref={search} type="search" role="combobox" value={query}
        className="mb-[.55rem]" placeholder="Search timezones…"
        autoComplete="off" aria-autocomplete="list" aria-controls={listId} aria-expanded="true" aria-activedescendant={activeId}
        onChange={(event) => { setQuery(event.currentTarget.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter' && matches[active]) {
            event.preventDefault();
            choose(matches[active]);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            trigger.current?.focus();
          }
        }} />
      <ul id={listId} role="listbox" aria-labelledby={`${id}-label`}
        className="max-h-64 overflow-y-auto text-sm font-normal [&_li[aria-selected=true]]:font-[650]">
        {matches.map((zone, index) => <li id={`${id}-option-${index}`} key={zone} role="option"
          aria-selected={zone === selected}
          className={'cursor-pointer rounded px-[.7rem] py-[.6rem]'
            + (index === active ? ' bg-selected-surface text-selected-text' : '')}
          onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(zone)}>
          {zone}
        </li>)}
      </ul>
      {!matches.length && <p role="status" className="m-2 text-[.82rem] font-normal text-muted-foreground">No matching timezones.</p>}
    </div>}
  </div>;
}
