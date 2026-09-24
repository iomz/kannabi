const paths = {
  members: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3 M19 4a3 3 0 0 1 0 6 M22 20v-3a5 5 0 0 0-3-4',
  assets: 'M4 7h16v14H4z M8 7V3h8v4 M9 11v6 M15 11v6',
  groups: 'M4 9h16v12H4z M8 9V5h8v4 M9 5V2h6v3 M8 13h2v3H8z M14 13h2v3h-2z',
  settings: 'm9 3 1-2h4l1 2 2 1 2-1 2 3-1 2v3l1 2-2 3-2-1-2 1-1 3h-4l-1-3-2-1-2 1-2-3 1-2V8L2 6l2-3 2 1z M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  search: 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  plus: 'M12 4v16 M4 12h16',
  lock: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-5 5-5 13 0 18 5-5 5-13 0-18 M5 7h14 M5 17h14',
  photo: 'M3 4h18v16H3z M3 16l6-6 5 5 3-3 4 4 M17 8h.01',
  copy: 'M8 8h11v11H8z M5 16H4V5h11v1',
  check: 'm5 12 4 4L19 6',
  trash: 'M4 7h16 M9 7V4h6v3 M7 7l1 14h8l1-14 M10 11v6 M14 11v6',
  user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
  key: 'M15 7a4 4 0 1 1-3.5 5.9L4 20l-2-2 1.5-1.5L5 18l1.5-1.5L5 15l6.1-6.1A4 4 0 0 1 15 7 M16.5 10.5h.01',
  sidebar: 'M4 5h16v14H4z M10 5v14',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18 M12 11v6 M12 8h.01',
};
export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  // `icon` is the hook the surrounding composition sizes and colours it by.
  return <svg className="icon size-[1.15rem] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
