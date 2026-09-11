# EduNext — واجهة المنصة التعليمية

منصة تعليمية (EdTech SaaS) بواجهة عربية بالكامل، من اليمين إلى اليسار.

## التشغيل

```bash
npm install
npm run dev      # خادم التطوير
npm run build    # حزمة الإنتاج
npm run preview  # معاينة حزمة الإنتاج
```

---

## Stack

| Layer   | Choice                                        |
| ------- | --------------------------------------------- |
| Build   | Vite 8                                        |
| UI      | React 19                                      |
| Styling | Tailwind CSS **3.4** + PostCSS + Autoprefixer |
| Icons   | `lucide-react`                                |
| Fonts   | Readex Pro → Cairo → sans-serif               |

## Design tokens

Defined once in `tailwind.config.js`. Do not hard-code these values in a
component — if a token is missing, add it there.

| Token             | Value                                | Used for                        |
| ----------------- | ------------------------------------ | ------------------------------- |
| `canvas`          | `#FBF9F5`                            | page background (warm beige)    |
| `surface`         | `#FFFFFF`                            | cards and panels                |
| `surface-alt`     | `#F5F0E6`                            | recessed / ivory panels         |
| `primary`         | `#6D28D9`                            | actions, active state, progress |
| `primary-hover`   | `#5B21B6`                            | hover on primary                |
| `primary-light`   | `#F3E8FF`                            | tinted icon wells, soft buttons |
| `accent-lavender` | `#DDD6FE`                            | highlights, gradient stops      |
| `accent-subtle`   | `#E8E1D5`                            | hairline borders                |
| `text-main`       | `#1E1B4B`                            | body copy (deep purple-navy)    |
| `text-muted`      | `#6B7280`                            | secondary copy                  |
| `rounded-card`    | `16px`                               | every card                      |
| `shadow-soft`     | `0 4px 20px -2px rgba(30,27,75,.04)` | every card                      |

`.card-surface` in `src/index.css` bundles the card shape (radius + hairline
border + soft shadow) so it is written once rather than copied.

## RTL rules — read before writing a component

The document is `<html lang="ar" dir="rtl">`, set in `index.html` so the **first
paint** is already correct rather than snapping once CSS arrives.

**Use logical utilities, always:**

| Use                       | Not                       |
| ------------------------- | ------------------------- |
| `ms-*` `me-*`             | `ml-*` `mr-*`             |
| `ps-*` `pe-*`             | `pl-*` `pr-*`             |
| `start-*` `end-*`         | `left-*` `right-*`        |
| `text-start` `text-end`   | `text-left` `text-right`  |
| `border-s-*` `border-e-*` | `border-l-*` `border-r-*` |

Physical utilities are not _wrong_ so much as **silently mirrored-wrong**: they
look right in an LTR preview and break the moment direction flips.

**Two more rules that are easy to miss:**

1. **Source order is visual order.** In `AppLayout` the sidebar is the _first_
   child and therefore lands on the _right_. Nothing positions it there.
2. **Forward is leftwards.** The call-to-action uses `ArrowLeft`, which is the
   "continue" arrow in RTL — not a mistake to be corrected, and not something to
   fake by mirroring `ArrowRight` with a transform.
3. **Wrap LTR fragments in `dir="ltr"`.** Hex codes, emails, URLs and code
   identifiers reorder badly inside Arabic paragraphs otherwise.

## Structure

```
src/
├── assets/                 static files
├── components/
│   ├── layout/             AppLayout, Sidebar, Header   ← Task 002 fills these
│   ├── dashboard/          dashboard widgets            ← Task 003
│   └── ui/                 Card, Button (primitives)
├── pages/                  Dashboard (currently the setup-verification page)
├── services/               apiClient — the only place that talks to the network
├── App.jsx
├── index.css               fonts, RTL, base layer, .card-surface
└── main.jsx
```

`src/components/layout/Sidebar.jsx` and `Header.jsx` are **structural shells**:
the element, the landmark role and the RTL-correct position are settled; the
content is Task 002's.

## Verified at setup

- `npm run build` — clean, 1858 modules.
- Rendered in Chromium: `dir=rtl`, `lang=ar`, body background `rgb(251,249,245)`,
  body colour `rgb(30,27,75)`, font stack `"Readex Pro", Cairo, sans-serif`.
- Every token above confirmed present in the compiled CSS.

**One known limitation of the development sandbox, not of the code:** Google
Fonts is unreachable through this environment's proxy, so the local preview
falls back to the system sans-serif. The `@import` and the family stack are
correct and will load normally anywhere with outbound access.
