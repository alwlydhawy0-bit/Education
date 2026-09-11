import { describe, expect, it } from 'vitest';
import {
  MAX_SLUG_LENGTH,
  type PortfolioSourceRow,
  type ProjectSourceRow,
  isValidShareToken,
  isValidSlug,
  publicUrlOrNull,
  slugCandidates,
  slugFromTitle,
  toPublicPortfolio,
} from '../../apps/api/src/modules/portfolio/public-view.ts';

/**
 * The public boundary, exhaustively.
 *
 * TASK 013 section 3 makes one demand of this layer above all others: the
 * public resolver "MUST use a dedicated sanitized DTO to prevent leaking
 * internal database IDs, student emails, or private system metadata". That is a
 * property about what is ABSENT from the output, and a property about absence
 * cannot be tested by listing the fields you expected — the field you forgot is
 * exactly the one that leaks.
 *
 * So the central test here does not check fields. It serializes the whole
 * output and searches it for every secret that was present in the input. If a
 * future edit copies a row wholesale instead of constructing a view, the secret
 * appears in the JSON and the test fails, whatever the field is called.
 */

const SECRETS = {
  portfolioId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  itemId: '33333333-3333-4333-8333-333333333333',
  studentId: '44444444-4444-4444-8444-444444444444',
  organizationId: '55555555-5555-4555-8555-555555555555',
  classId: '66666666-6666-4666-8666-666666666666',
  featuredBy: '77777777-7777-4777-8777-777777777777',
  email: 'noor.alwaleed@example.edu',
  shareToken: 'a'.repeat(64),
} as const;

const portfolio: PortfolioSourceRow = {
  title: 'Noor Al-Waleed — Physics',
  bio: 'Year 10. I build things that fall over.',
};

const project = (overrides: Partial<ProjectSourceRow> = {}): ProjectSourceRow => ({
  displayOrder: 1,
  title: 'Pendulum period vs. length',
  descriptionMarkdown: 'A write-up of twenty trials.',
  repositoryUrl: 'https://github.com/noor/pendulum',
  liveDemoUrl: null,
  status: 'submitted',
  artifacts: [],
  ...overrides,
});

describe('toPublicPortfolio — no identifier leaves the boundary', () => {
  it('emits no database id, email, token or organization present in the input', () => {
    /**
     * The source rows here deliberately carry every secret as an EXTRA
     * property. TypeScript would reject them on a fresh object literal, so they
     * are widened — which is the honest simulation of the real hazard: a
     * repository selecting `*`, or a `SELECT` list that grows a column, hands
     * this function more than its interface promised. The view must ignore it.
     */
    const dirtyPortfolio = {
      ...portfolio,
      id: SECRETS.portfolioId,
      studentId: SECRETS.studentId,
      student_id: SECRETS.studentId,
      organizationId: SECRETS.organizationId,
      shareToken: SECRETS.shareToken,
      share_token: SECRETS.shareToken,
      authorEmail: SECRETS.email,
      authorDisplayName: 'Noor Al-Waleed',
      isPublished: true,
    } as PortfolioSourceRow;

    const dirtyProject = {
      ...project(),
      id: SECRETS.projectId,
      itemId: SECRETS.itemId,
      studentId: SECRETS.studentId,
      ownerId: SECRETS.studentId,
      organizationId: SECRETS.organizationId,
      classId: SECRETS.classId,
      courseId: SECRETS.classId,
      featuredBy: SECRETS.featuredBy,
      featuredAt: '2026-05-01T09:00:00Z',
      visibility: 'public',
      createdAt: '2026-04-01T09:00:00Z',
      artifacts: [
        {
          id: SECRETS.itemId,
          projectId: SECRETS.projectId,
          ownerId: SECRETS.studentId,
          artifactType: 'report_pdf',
          filePathOrUrl: 'https://cdn.example.org/report.pdf',
          byteSize: 4096,
          metadata: { uploaderEmail: SECRETS.email },
        },
      ],
    } as unknown as ProjectSourceRow;

    const view = toPublicPortfolio(dirtyPortfolio, [dirtyProject]);
    const serialized = JSON.stringify(view);

    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(serialized, `${name} leaked into the public view`).not.toContain(secret);
    }
  });

  it('never carries an author display name, even when handed one', () => {
    const view = toPublicPortfolio(
      { ...portfolio, authorDisplayName: 'Registered Legal Name' } as PortfolioSourceRow,
      [],
    );
    expect(JSON.stringify(view)).not.toContain('Registered Legal Name');
  });

  it('carries exactly the named fields and no others', () => {
    /**
     * The complement of the leak test. That one proves nothing SECRET escapes;
     * this one pins the shape, so adding a field is a deliberate act that
     * requires editing a test — the moment a reviewer gets to object.
     */
    const view = toPublicPortfolio(portfolio, [
      project({
        artifacts: [
          { artifactType: 'code_file', filePathOrUrl: 'https://x.test/a.zip', byteSize: 12 },
        ],
      }),
    ]);

    // No author name. See `PublicPortfolioView`: an account display name is
    // registration data a child gave their school, not something they composed
    // for a page served to anybody with a link. This assertion is what keeps it
    // from drifting back in.
    expect(Object.keys(view).sort()).toEqual(['bio', 'projects', 'title']);
    expect(Object.keys(view.projects[0]!).sort()).toEqual([
      'artifacts',
      'description',
      'featured',
      'liveDemoUrl',
      'position',
      'repositoryUrl',
      'title',
    ]);
    expect(Object.keys(view.projects[0]!.artifacts[0]!).sort()).toEqual([
      'byteSize',
      'kind',
      'url',
    ]);
  });

  it('renumbers position from 1 so deletion gaps disclose nothing', () => {
    // Stored orders 2, 7, 40 — the learner removed items 1 and 3..6. A stranger
    // must not be able to infer that anything was ever there.
    const view = toPublicPortfolio(portfolio, [
      project({ displayOrder: 40, title: 'C' }),
      project({ displayOrder: 2, title: 'A' }),
      project({ displayOrder: 7, title: 'B' }),
    ]);

    expect(view.projects.map((p) => p.position)).toEqual([1, 2, 3]);
    expect(view.projects.map((p) => p.title)).toEqual(['A', 'B', 'C']);
  });

  it('does not mutate or reorder the caller’s array', () => {
    const projects = [
      project({ displayOrder: 3, title: 'C' }),
      project({ displayOrder: 1, title: 'A' }),
    ];
    toPublicPortfolio(portfolio, projects);
    expect(projects.map((p) => p.title)).toEqual(['C', 'A']);
  });

  it('reports featured status as a boolean, never who or when', () => {
    const view = toPublicPortfolio(portfolio, [
      project({ displayOrder: 1, status: 'featured' }),
      project({ displayOrder: 2, status: 'submitted' }),
      project({ displayOrder: 3, status: 'draft' }),
    ]);
    expect(view.projects.map((p) => p.featured)).toEqual([true, false, false]);
    expect(JSON.stringify(view)).not.toContain('featured_by');
  });

  it('drops artifact:// references rather than rendering them', () => {
    // A stranger has no session. An internal reference would be a broken link
    // at best and a hint about storage layout at worst.
    const view = toPublicPortfolio(portfolio, [
      project({
        artifacts: [
          {
            artifactType: 'report_pdf',
            filePathOrUrl: `artifact://${SECRETS.itemId}`,
            byteSize: 10,
          },
          {
            artifactType: 'media_asset',
            filePathOrUrl: 'https://cdn.example.org/clip.mp4',
            byteSize: 20,
          },
        ],
      }),
    ]);

    expect(view.projects[0]!.artifacts).toHaveLength(1);
    expect(view.projects[0]!.artifacts[0]!.url).toBe('https://cdn.example.org/clip.mp4');
    expect(JSON.stringify(view)).not.toContain('artifact://');
  });

  it('drops an artifact whose type is not one of the three public kinds', () => {
    const view = toPublicPortfolio(portfolio, [
      project({
        artifacts: [
          { artifactType: 'internal_audit_log', filePathOrUrl: 'https://x.test/a', byteSize: 1 },
          { artifactType: 'code_file', filePathOrUrl: 'https://x.test/b', byteSize: 1 },
        ],
      }),
    ]);
    expect(view.projects[0]!.artifacts.map((a) => a.kind)).toEqual(['code_file']);
  });

  it('nulls a non-https repository or demo url', () => {
    const view = toPublicPortfolio(portfolio, [
      project({
        repositoryUrl: 'javascript:alert(document.cookie)',
        liveDemoUrl: 'http://insecure.test/demo',
      }),
    ]);
    expect(view.projects[0]!.repositoryUrl).toBeNull();
    expect(view.projects[0]!.liveDemoUrl).toBeNull();
  });

  it('produces an empty project list for a portfolio with nothing public', () => {
    const view = toPublicPortfolio(portfolio, []);
    expect(view.projects).toEqual([]);
    // An empty portfolio and a portfolio whose items are all private are the
    // same page. The resolver must not be able to tell a stranger apart.
    expect(Object.keys(view).sort()).toEqual(['bio', 'projects', 'title']);
  });
});

describe('publicUrlOrNull', () => {
  it('accepts an https url and trims surrounding whitespace', () => {
    expect(publicUrlOrNull('  https://github.com/noor/x  ')).toBe('https://github.com/noor/x');
  });

  it('passes null through', () => {
    expect(publicUrlOrNull(null)).toBeNull();
  });

  it.each([
    ['http://x.test', 'plain http'],
    ['javascript:alert(1)', 'script scheme'],
    ['JAVASCRIPT:alert(1)', 'uppercased script scheme'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'data uri'],
    ['file:///etc/passwd', 'file scheme'],
    ['artifact://11111111-1111-4111-8111-111111111111', 'internal scheme'],
    ['//evil.test/x', 'protocol-relative'],
    ['/relative/path', 'relative path'],
    ['ftp://x.test', 'ftp'],
    ['', 'empty string'],
    ['https', 'the scheme name alone'],
    [' https://x.test/a b', 'embedded space'],
    ['https://x.test/\nSet-Cookie: a=b', 'header injection via newline'],
    ['https://x.test/\ta', 'embedded tab'],
  ])('rejects %s (%s)', (url) => {
    expect(publicUrlOrNull(url)).toBeNull();
  });

  it('rejects a url longer than 2000 characters', () => {
    expect(publicUrlOrNull(`https://x.test/${'a'.repeat(2000)}`)).toBeNull();
  });

  it('accepts a url of exactly 2000 characters', () => {
    const url = `https://x.test/${'a'.repeat(2000 - 'https://x.test/'.length)}`;
    expect(url).toHaveLength(2000);
    expect(publicUrlOrNull(url)).toBe(url);
  });
});

describe('slugFromTitle', () => {
  it('lowercases, collapses punctuation to hyphens, and trims the ends', () => {
    expect(slugFromTitle('  My Physics Portfolio!! ')).toBe('my-physics-portfolio');
  });

  it('collapses a run of separators into a single hyphen', () => {
    expect(slugFromTitle('a --- b___c   d')).toBe('a-b-c-d');
  });

  it('strips combining marks so accents survive as their base letters', () => {
    expect(slugFromTitle('Café Chemistry')).toBe('cafe-chemistry');
    expect(slugFromTitle('El Niño study')).toBe('el-nino-study');
  });

  it('returns null for an Arabic title rather than inventing a name', () => {
    /**
     * DELIBERATE. This platform teaches in Arabic, and a title in Arabic has no
     * honest ASCII slug — transliteration would produce something the learner
     * cannot read and did not choose. Null means "ask them"; it does not mean
     * "Arabic portfolios cannot be published", because a share token works
     * without any slug at all.
     */
    expect(slugFromTitle('مشروع الفيزياء')).toBeNull();
  });

  it('returns null when nothing usable survives', () => {
    expect(slugFromTitle('')).toBeNull();
    expect(slugFromTitle('   ')).toBeNull();
    expect(slugFromTitle('!!!')).toBeNull();
    expect(slugFromTitle('\u{1f680}\u{1f680}')).toBeNull();
  });

  it('returns null for a title that reduces to fewer than three characters', () => {
    // The database CHECK needs one character, then one or more, then one.
    expect(slugFromTitle('a')).toBeNull();
    expect(slugFromTitle('ab')).toBeNull();
    expect(slugFromTitle('abc')).toBe('abc');
  });

  it('truncates to the database maximum without leaving a trailing hyphen', () => {
    const slug = slugFromTitle(`${'a'.repeat(MAX_SLUG_LENGTH)} tail`);
    expect(slug).toHaveLength(MAX_SLUG_LENGTH);
    expect(slug!.endsWith('-')).toBe(false);
  });

  it('never produces a slug the database would refuse', () => {
    const titles = [
      'My Physics Portfolio!!',
      'a --- b',
      '  Leading and trailing  ',
      `${'word '.repeat(40)}`,
      'Café',
      '2026 results',
      'x'.repeat(300),
      '---abc---',
      'A.B.C',
      'noor@example.edu',
    ];
    for (const title of titles) {
      const slug = slugFromTitle(title);
      if (slug !== null) {
        expect(isValidSlug(slug), `${JSON.stringify(title)} -> ${slug}`).toBe(true);
      }
    }
  });
});

describe('slugCandidates', () => {
  it('offers the base first, then numbered suffixes', () => {
    expect(slugCandidates('alex-chen', 4)).toEqual([
      'alex-chen',
      'alex-chen-2',
      'alex-chen-3',
      'alex-chen-4',
    ]);
  });

  it('is finite so an exhausted caller asks the learner instead of looping', () => {
    expect(slugCandidates('x-y')).toHaveLength(10);
  });

  it('keeps every candidate within the database length limit', () => {
    const base = 'a'.repeat(MAX_SLUG_LENGTH);
    for (const candidate of slugCandidates(base, 10)) {
      expect(candidate.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
      expect(isValidSlug(candidate), candidate).toBe(true);
    }
  });

  it('does not leave a doubled hyphen when the truncation lands on one', () => {
    const base = `${'a'.repeat(MAX_SLUG_LENGTH - 3)}-bc`;
    for (const candidate of slugCandidates(base, 10)) {
      expect(candidate).not.toContain('--');
      expect(isValidSlug(candidate), candidate).toBe(true);
    }
  });

  it('produces no duplicates', () => {
    const candidates = slugCandidates('physics', 10);
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe('isValidSlug', () => {
  it.each(['abc', 'a-b', 'alex-chen-2', '2026-results', `a${'b'.repeat(62)}c`])(
    'accepts %s',
    (slug) => {
      expect(isValidSlug(slug)).toBe(true);
    },
  );

  it.each([
    ['ab', 'two characters'],
    ['-abc', 'leading hyphen'],
    ['abc-', 'trailing hyphen'],
    ['ABC', 'uppercase'],
    ['a b', 'space'],
    ['a_b', 'underscore'],
    ['a.b', 'dot'],
    ['مشروع', 'non-ascii'],
    [`a${'b'.repeat(63)}c`, 'one character too long'],
    ['abc\ndef', 'embedded newline'],
  ])('rejects %s (%s)', (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });

  it('rejects a newline-terminated slug, which a naive $ anchor would accept', () => {
    // JavaScript's `$` matches before a trailing newline unless `m` is unset AND
    // the author remembered. A slug of "abc\n" reaching a URL would split a log
    // line, so this case is pinned rather than assumed.
    expect(isValidSlug('abc\n')).toBe(false);
  });
});

describe('isValidShareToken', () => {
  it('accepts a 64-character lowercase hex token', () => {
    expect(isValidShareToken('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(63), 'too short'],
    ['a'.repeat(65), 'too long'],
    ['A'.repeat(64), 'uppercase hex'],
    [`${'a'.repeat(63)}g`, 'non-hex character'],
    [`${'a'.repeat(64)}\n`, 'trailing newline'],
    ["' OR 1=1 --".padEnd(64, 'a'), 'sql-shaped'],
    ['../'.repeat(21).slice(0, 64), 'traversal-shaped'],
  ])('rejects %s (%s)', (token) => {
    expect(isValidShareToken(token)).toBe(false);
  });
});
