import { useState } from 'react';
import BottomNav from './BottomNav.jsx';
import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';

/**
 * The page frame, and the one place that knows which destination is active.
 *
 * WHY THE ACTIVE ID LIVES HERE. Two navigations render it — the sidebar on a
 * desktop, the bottom bar on a phone — and they must never disagree. Holding
 * the value in the single ancestor they share makes disagreement
 * unrepresentable rather than merely unlikely.
 *
 * It is deliberately NOT a router yet. `react-router` earns its place when
 * there is a second page to route to; adding it now would be a dependency
 * chosen on speculation. When it arrives, this `useState` becomes `useLocation`
 * and `onNavigate` becomes `navigate` — neither child changes, because neither
 * child knows where the value comes from.
 */
const DEMO_USER = {
  name: 'ريهام',
  role: 'طالبة',
  unreadCount: 1,
  avatarUrl: null,
};

export default function AppLayout({ children, user = DEMO_USER }) {
  const [activeId, setActiveId] = useState('dashboard');

  /*
   * `h-[100dvh] overflow-hidden` on the shell — not `min-h-screen`.
   *
   * With `min-h-screen` the shell grows to the DOCUMENT height, so the sidebar
   * stretches past the fold and the settings row pinned to its foot ends up
   * hundreds of pixels below the viewport, reachable only by scrolling the whole
   * page. Caught by looking at a screenshot, not by reading the code.
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
      <Sidebar activeId={activeId} onNavigate={setActiveId} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header user={user} onNavigate={setActiveId} />

        {/*
          The content column is what scrolls; the sidebar and header stay put.

          `pb-28 md:pb-6` reserves room for the floating bottom bar. Without it
          the last card on every phone screen sits underneath the navigation and
          cannot be reached — the most common bug in this exact layout, and one
          that is invisible on a desktop.
        */}
        <main className="flex-1 overflow-y-auto px-4 pb-28 pt-2 sm:px-6 md:pb-6">{children}</main>
      </div>

      <BottomNav activeId={activeId} onNavigate={setActiveId} />
    </div>
  );
}
