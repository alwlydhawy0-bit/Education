import { Outlet, useLocation } from 'react-router-dom';
import BottomNav from './BottomNav.jsx';
import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';

/**
 * The page frame for every routed screen.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTER ARRIVED, AND THIS FILE PREDICTED WHAT WOULD HAPPEN
 * ---------------------------------------------------------------------------
 *
 * It used to hold `activeId` in a `useState` and hand `onNavigate` to both
 * navigations, with a note saying that when a router landed, "this `useState`
 * becomes `useLocation` and `onNavigate` becomes `navigate` — neither child
 * changes, because neither child knows where the value comes from."
 *
 * That is roughly what happened, with one correction worth recording: the
 * children DID change, because the right answer was better than the predicted
 * one. Rather than passing a location down, each navigation now uses `NavLink`,
 * which derives its own active state and sets `aria-current` itself. The
 * "single ancestor holds the value so the two cannot disagree" argument is
 * satisfied more strongly than before — there is no value to disagree about,
 * only the URL, which is one thing by construction.
 *
 * This component no longer takes a `user` prop either. The header reads the
 * visitor from `useAuth`, because who is looking is not a property of the
 * layout — a guest and a member get the SAME frame, and only the contents of
 * the header and the sidebar's foot differ.
 *
 * `<Outlet />` is where the routed page renders.
 */
export default function AppLayout() {
  const { pathname } = useLocation();

  /*
   * `h-[100dvh] overflow-hidden` on the shell — not `min-h-screen`.
   *
   * With `min-h-screen` the shell grows to the DOCUMENT height, so the sidebar
   * stretches past the fold and the row pinned to its foot ends up hundreds of
   * pixels below the viewport, reachable only by scrolling the whole page.
   * Caught by looking at a screenshot, not by reading the code.
   *
   * `dvh` rather than `vh` because mobile browser chrome makes `100vh` taller
   * than the visible area — the classic "the bottom bar is under the address
   * bar" bug.
   */
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-canvas">
      {/*
        Sidebar FIRST. In RTL that puts it on the right with no positioning at
        all — source order is visual order, and using it rather than fighting it
        is the difference between markup that reads correctly and markup that
        works by accident.
      */}
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header />

        {/*
          The content column is what scrolls; the sidebar and header stay put.

          `pb-28 md:pb-6` reserves room for the floating bottom bar. Without it
          the last card on every phone screen sits underneath the navigation and
          cannot be reached — the most common bug in this exact layout, and one
          that is invisible on a desktop.

          `key={pathname}` RESETS THE SCROLL POSITION BETWEEN PAGES. This column
          is the scroll container, not the window, so a router navigation leaves
          it exactly where the previous page was — open a course from halfway
          down the catalogue and the new page opens halfway down too, which
          reads as a broken page rather than as a preserved position. Remounting
          on the path is the cheapest correct fix; `window.scrollTo` would do
          nothing here, because the window never scrolled.
        */}
        <main key={pathname} className="flex-1 overflow-y-auto px-4 pb-28 pt-2 sm:px-6 md:pb-6">
          <Outlet />
        </main>
      </div>

      <BottomNav />
    </div>
  );
}
