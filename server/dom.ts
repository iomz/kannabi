import { GlobalRegistrator } from '@happy-dom/global-registrator';

/** A document for the tests that need one.
 *
 * Most of Kannabi's UI can be read as static markup, and those tests stay as
 * they are. Anything anchored in a portal — a dialog, a menu, a toast — does
 * not exist until it is opened, so there is nothing for static rendering to
 * return. Those behaviours are real and worth holding on to, which is what
 * this is for: the test opens the thing and looks for it by role and name.
 *
 * It is registered per test file rather than globally, so a file that does not
 * need a document does not pay for one, and it is kept out of the server build
 * along with `dom-render.tsx`: neither belongs in what ships.
 */
GlobalRegistrator.register({ url: 'https://kannabi.test/' });
// React 19 checks this before using `act`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
