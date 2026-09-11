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
   * The dark PALETTE is not defined yet — that is a token task, not a layout
   * one — so today no `dark:` variant is used anywhere. This is the seam that
   * lets the palette land later without touching a component.
   */
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // The page itself. Warm light beige — never pure white, which is what
        // keeps long study sessions comfortable.
        canvas: '#FBF9F5',

        // Cards and panels that sit on the canvas.
        surface: {
          DEFAULT: '#FFFFFF',
          alt: '#F5F0E6',
        },

        // Royal purple: the single accent. Actions, active state, progress.
        primary: {
          DEFAULT: '#6D28D9',
          hover: '#5B21B6',
          light: '#F3E8FF',
        },

        // Supporting tints. `subtle` is the hairline border colour, and it is a
        // warm beige rather than a grey so borders never read as cold.
        accent: {
          lavender: '#DDD6FE',
          subtle: '#E8E1D5',
        },

        // Body text. Deep purple-navy rather than black, so it belongs to the
        // same family as the accent instead of fighting it.
        text: {
          main: '#1E1B4B',
          muted: '#6B7280',
        },
      },

      borderRadius: {
        card: '16px',
      },

      boxShadow: {
        // Barely there, and tinted with the text colour rather than pure black:
        // a neutral shadow over a warm canvas looks like dirt.
        soft: '0 4px 20px -2px rgba(30, 27, 75, 0.04)',
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
