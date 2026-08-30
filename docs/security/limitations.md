# Known Limitations & Unverified Claims

Brief §3 and §4: never claim the system is secure, and never claim something
exists or passed when it did not. This document is the counterweight to the rest
of the documentation — it states what was **not** done.

## The headline

**This system is not proven secure, and no such claim is made anywhere in this
repository.** 208 automated tests passed against a real PostgreSQL database.
That establishes that specific, enumerated properties held at a point in time. It
does not establish the absence of vulnerabilities.

## What was actually verified

- 208 tests executed and passing: 112 unit, 16 architecture, 45 integration,
  35 security.
- Migrations applied cleanly from empty to full schema, repeatedly.
- RLS enforced against a real non-superuser role — verified by attack, not by
  reading the policy.
- The application authorization layer verified _independently_ of RLS, using a
  role with `BYPASSRLS`.
- Secret scan and dependency audit executed; the audit found two real advisories
  (vite high, vitest critical), which were fixed by upgrading, not exempted.
- The CI database-provisioning script executed locally, with the full suite
  passing against the database it creates.

## What was NOT verified

- **The GitHub Actions workflows have never run.** They are syntactically valid
  and the provisioning script they call was executed locally, but no hosted run
  has occurred. CodeQL has never analysed this code.
- **No DAST.** No running instance was scanned by an external tool.
- **No penetration test.** No human adversary has attempted to break this.
- **No load, stress, or soak testing.** Zero performance data exists. Every
  performance-related statement in the docs is reasoning, not measurement.
- **No production deployment.** No TLS termination, WAF, secrets manager, backup,
  or restore has been configured or tested.
- **The web frontend was never run in a browser.** It typechecks, lints, and its
  pure i18n logic is unit-tested. No component render test, no E2E test, no
  visual RTL verification. `npm run build` for the web app was not executed.
- **No accessibility testing.** Nothing was checked against WCAG, and no screen
  reader was used. Accessibility ranks above performance in the brief's priority
  order and currently has no coverage at all.
- **Argon2 parameters were not benchmarked** on target hardware. They match the
  OWASP baseline but were not tuned or timed.
- **The timing-equalization defence was not measured.** The dummy-hash mechanism
  is implemented and reasoned about; no statistical timing analysis was run, so
  it is unproven that the remaining difference is undetectable.
- **Rate limiting was verified in-process only**, single instance. Behaviour
  across replicas is untested and, by design, currently incorrect.

## Structural limitations

- **`Guarded<T>` cannot protect code that never wraps a record.** The fitness
  test asserts the notebook repository's return type; it cannot enforce this for
  domains that do not exist.
- **RLS does not apply to superusers.** This is a PostgreSQL property that cannot
  be switched off. The mitigation is operational: the application never connects
  as one, and the test harness refuses to run if it detects one.
- **Redaction cannot catch a secret in free text** — a password pasted into a
  note body would be logged if note bodies were ever logged. The mitigation is
  not logging user content.
- **The secret scanner is homegrown** and pattern-based. It will miss novel
  formats and high-entropy strings without a recognizable shape. It should be
  replaced by gitleaks or trufflehog.
- **The audit writer is best-effort.** A write failure does not fail the request.
  Deliberate for auth events; wrong for future grade mutations.
- **`notes.organization_id` is denormalized** and there is no flow keeping it
  correct across an organization transfer, because no transfer flow exists.
- **Only three domains exist.** The architecture is designed for ~30. That the
  patterns generalize is a reasoned expectation, not a demonstrated fact.

## Explicitly not built

Courses, lessons, curriculum, learning paths, activities, experiments and
simulations, assessments, mastery, projects, portfolios, research tools, the AI
Tutor, the AI Assistant, the AI Gateway, the knowledge base, RAG, file uploads,
malware scanning, community, moderation, notifications, analytics, admin
surfaces, feature flags, email, MFA, password reset, and account recovery.

Several of these are _described_ in this documentation. None of them exist.

## Compliance

No compliance assessment was performed. Saudi PDPL, and any obligations arising
from processing minors' data, have not been analysed. Data residency, retention
schedules, deletion rights and consent flows are unaddressed. This needs
qualified legal input, not an engineering opinion.
