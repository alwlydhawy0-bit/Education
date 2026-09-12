/** @type {import('tailwindcss').Config} */

/**
 * EduNext — design tokens.
 *
 * Every value below is taken from the reference design, not invented. The
 * palette is warm-beige canvas + ivory surfaces + royal purple accents, which
 * is what gives the product its calm, non-clinical feel; a stock Tailwind
 * `gray`/`indigo` pairing would look like a different product entirely.
 *
 * RTL NOTE FOR EVERY COMPONENT BUILT ON TOP OF THIS:
 * The app renders right-to-left. Use Tailwind's LOGICAL utilities so that
 * spacing and alignment follow the writing direction automatically:
 *
 *   ms-* / me-*    instead of  ml-* / mr-*
 *   ps-* / pe-*    instead of  pl-* / pr-*
 *   start-* / end-*  instead of  left-* / right-*
 *   text-start / text-end  instead of  text-left / text-right
 *   border-s-* / border-e-*  instead of  border-l-* / border-r-*
 *
 * Physical utilities (ml-, pr-, left-) are not wrong so much as they are
 * silently mirrored-wrong: they look correct in an LTR preview and break the
 * moment the layout flips. The `rtl:` / `ltr:` variants are available for the
 * rare case where a value must genuinely differ (icon rotation, for example).
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],

  /**
   * Class-based, not media-based: the header's theme toggle sets `dark` on
   * <html>, so a deliberate choice beats the operating system's. The toggle
   * reads `prefers-color-scheme` only for the first visit, before a choice
   * exists.
   *
   * THE DARK PALETTE IS NOW DEFINED, and it needs no `dark:` variants at all.
   * Every colour below resolves through a CSS variable that `index.css`
   * redefines under `.dark`, so a component written once is correct in both
   * themes. The seam that was promised turned out to be cheaper than expected:
   * the components did not have to change, only the values behind their names.
   */
  darkMode: 'class',
  theme: {
    extend: {
      /*
       * EVERY COLOUR IS A CSS VARIABLE, AND THAT IS WHAT MAKES DARK MODE WORK.
       *
       * The values live in `index.css` under `:root` and `.dark`; this file only
       * names them. The alternative — a literal here plus a `dark:` variant on
       * every element that uses it — would have meant editing well over a
       * hundred class lists, and missing one leaves a white card sitting in a
       * dark page with nothing to catch it. With variables, `bg-canvas` is
       * already correct in both themes wherever it appears.
       *
       * `<alpha-value>` is the part that is easy to get wrong. Tailwind
       * substitutes the opacity from modifiers like `bg-surface-alt/40` and
       * `ring-primary/40` into that placeholder — but only if the variable holds
       * SPACE-SEPARATED RGB CHANNELS ("251 249 245") rather than a colour
       * string. Store `#FBF9F5` in the variable and every opacity modifier in
       * the app silently stops working.
       */
      colors: {
        // The page itself. Warm light beige in the day, deep purple-navy at
        // night — never pure white and never pure black, which is what keeps a
        // long study session comfortable in either theme.
        canvas: 'rgb(var(--color-canvas) / <alpha-value>)',

        // Cards and panels that sit on the canvas.
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          alt: 'rgb(var(--color-surface-alt) / <alpha-value>)',
        },

        // The single accent. Actions, active state, progress.
        primary: {
          DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)',
          hover: 'rgb(var(--color-primary-hover) / <alpha-value>)',
          light: 'rgb(var(--color-primary-light) / <alpha-value>)',
        },

        /*
         * WHAT GOES ON TOP OF `primary`, AS ITS OWN TOKEN.
         *
         * This did not exist before dark mode and could not be avoided once it
         * did. `primary` has to satisfy two jobs at once: a FILL that carries a
         * label, and TEXT on a dark surface. In the light theme one deep violet
         * does both — white reads on it at 7.1:1. In the dark theme it cannot:
         * a violet light enough to read as text on a near-black page (6.8:1) is
         * far too light to carry white text (2.1:1, unreadable).
         *
         * So the pairing is named rather than assumed. `text-white` on a purple
         * button was a hidden assumption that the button is always dark; every
         * one of those is now `text-on-primary`, which is white by day and the
         * deep canvas colour by night.
         */
        'on-primary': 'rgb(var(--color-on-primary) / <alpha-value>)',

        // Supporting tints. `subtle` is the hairline border colour — a warm
        // beige by day so borders never read as cold, a muted violet by night.
        accent: {
          lavender: 'rgb(var(--color-accent-lavender) / <alpha-value>)',
          subtle: 'rgb(var(--color-accent-subtle) / <alpha-value>)',
        },

        // Body text. Never pure black or pure white: both belong to the same
        // purple family as the accent rather than fighting it.
        text: {
          main: 'rgb(var(--color-text-main) / <alpha-value>)',
          muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
        },

        // Error state. `danger` is the text/icon colour and clears 4.5:1 on
        // both grounds; `danger-border` is the hairline, which only has to
        // clear the 3:1 non-text threshold and so stays light in both themes.
        danger: {
          DEFAULT: 'rgb(var(--color-danger) / <alpha-value>)',
          border: 'rgb(var(--color-danger-border) / <alpha-value>)',
        },

        // Highlighter inks for the document annotator. Backgrounds only —
        // `text-main` is what sits on them, in both themes.
        mark: {
          amber: 'rgb(var(--color-mark-amber) / <alpha-value>)',
          green: 'rgb(var(--color-mark-green) / <alpha-value>)',
          sky: 'rgb(var(--color-mark-sky) / <alpha-value>)',
          rose: 'rgb(var(--color-mark-rose) / <alpha-value>)',
        },
      },

      borderRadius: {
        card: '16px',
      },

      boxShadow: {
        /*
         * Barely there, and tinted with the text colour rather than pure black:
         * a neutral shadow over a warm canvas looks like dirt.
         *
         * It is a variable for the same reason the colours are. A 4%-opacity
         * shadow is invisible against a dark page — the card edge simply
         * disappears — so the dark theme raises the opacity and darkens the
         * tint, which is the only way a raised surface still reads as raised.
         */
        soft: 'var(--shadow-soft)',

        /*
         * The hover/raised state. It was written inline as
         * `shadow-[0_8px_28px_-4px_rgba(30,27,75,0.08)]` in four places — an
         * arbitrary value repeated, which is a token that has not been named
         * yet. Naming it is what let the dark theme give it a different value;
         * an 8%-opacity purple shadow simply does not exist on a dark page, so
         * a card that lifted on hover in the light theme did nothing at all in
         * the dark one.
         */
        lift: 'var(--shadow-lift)',
      },

      /*
       * The step transition on the authentication screen.
       *
       * Y ONLY, DELIBERATELY. A translate on X would have to know which way
       * "forward" points, and that answer flips with the writing direction — so
       * it would need an `rtl:` variant and would be wrong in one direction the
       * day someone forgot it. Vertical motion means the same thing in every
       * language.
       *
       * `both` holds the opening frame before the animation starts, which is
       * what stops a flash of the finished state on the first paint.
       *
       * Always reach for this through `motion-safe:`. A user who has asked their
       * operating system for reduced motion has asked for it here too.
       */
      keyframes: {
        'step-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },

      animation: {
        'step-in': 'step-in 280ms cubic-bezier(0.22, 1, 0.36, 1) both',
      },

      fontFamily: {
        // Readex Pro carries Arabic and Latin in one family with matching
        // proportions, so mixed strings ("28 ساعة") stay on one baseline.
        // Cairo is the fallback for the same reason, not as decoration.
        sans: ['Readex Pro', 'Cairo', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
