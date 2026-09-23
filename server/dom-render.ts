import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

/** Put a component into a real document and read it back the way a person
 * would: by role, by accessible name, by what is actually on screen.
 *
 * Anything anchored in a portal — a dialog, a menu, a toast — does not exist
 * until it is opened, so static rendering returns nothing for it. These are
 * the same behaviours that used to be asserted against markup strings, which
 * pinned class names rather than what the UI does.
 */
export function mount(element: ReactElement) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => { root.render(element); });

  const named = (name: string | RegExp, nodes: Element[]) => nodes.find((node) => {
    const label = node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  }) ?? null;

  return {
    text: () => document.body.textContent ?? '',
    html: () => document.body.innerHTML,
    button: (name: string | RegExp) =>
      named(name, [...document.querySelectorAll('button')]) as HTMLButtonElement | null,
    field: (selector: string) => document.querySelector<HTMLInputElement>(selector),
    dialog: () => document.querySelector('[role="dialog"], [role="alertdialog"]'),
    /** The accessible name of the open dialog, resolved through its own ids. */
    dialogName: () => {
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      return document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent ?? null;
    },
    click: (node: Element | null) => { act(() => { (node as HTMLElement | null)?.click(); }); },
    stop: () => { act(() => root.unmount()); host.remove(); },
  };
}

export const show = (component: Parameters<typeof createElement>[0], props: object) =>
  mount(createElement(component, props));
