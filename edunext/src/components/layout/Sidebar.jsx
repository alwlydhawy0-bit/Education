/**
 * Sidebar — STRUCTURAL SHELL ONLY.
 *
 * Task 002 builds the real navigation. What is fixed here is the thing Task 002
 * should not have to re-decide: in an RTL layout the sidebar is the FIRST child
 * in source order, and it lands on the RIGHT of the screen with no positioning
 * work at all. Placing it second and pushing it across with `order-` or
 * `right-0` would fight the direction rather than use it.
 */
export default function Sidebar() {
  return (
    <aside
      aria-label="التنقّل الرئيسي"
      className="hidden w-60 shrink-0 border-s border-accent-subtle bg-surface lg:block"
    >
      <div className="flex h-full flex-col p-4">
        {/* Task 002: شعار المنصة + روابط التنقّل + إعدادات في الأسفل */}
      </div>
    </aside>
  );
}
