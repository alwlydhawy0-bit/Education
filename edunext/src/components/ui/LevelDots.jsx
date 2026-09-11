import { LEVELS } from '../../data/courses.js';

/**
 * Difficulty, as three dots of which one, two or three are filled.
 *
 * THE TEXT IS NOT DECORATION. A row of dots is meaningless to a screen reader
 * and to anyone who cannot distinguish the filled state by colour alone, so the
 * Arabic label ships alongside it rather than instead of it. The dots are
 * `aria-hidden`; the word carries the meaning.
 *
 * This is also why difficulty is stored as a key (`beginner`) rather than as
 * the string "مبتدئ": the same record then drives the label, the dot count and
 * any future filter without three places agreeing by hand.
 */
export default function LevelDots({ level, className = '' }) {
  const { label, dots } = LEVELS[level] ?? LEVELS.beginner;

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            className={`h-1.5 w-1.5 rounded-full ${step <= dots ? 'bg-primary' : 'bg-accent-subtle'}`}
          />
        ))}
      </span>
      <span className="text-xs text-text-muted">{label}</span>
    </span>
  );
}
