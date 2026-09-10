import Sidebar from './Sidebar.jsx';
import Header from './Header.jsx';

/**
 * The page frame: sidebar on the right, header on top of the content column.
 *
 * `min-h-screen` plus `overflow-y-auto` on the main region — rather than
 * scrolling the whole document — is what lets the sidebar stay put while the
 * dashboard scrolls, which is how the reference behaves.
 */
export default function AppLayout({ children }) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
