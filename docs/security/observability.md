# Observability & Audit

## Two streams, on purpose

**Application logs** — structured JSON, one object per line, for operators.
**Security events** — a closed enum written to an append-only `audit_log` table
_and_ to the log stream, for security review and detection.

They are separate because they have different consumers, different retention
needs, and different integrity requirements. A detection rule must not break
because somebody reworded a log message, which is why `SecurityEventType` is a
closed enum rather than free-form strings.

## Redaction is mandatory and has no bypass

Every context object passes through `redact` before reaching the sink —
including bindings inherited via `child()`. There is no "raw" logger method. A
developer cannot opt out by accident, and a reviewer does not have to check every
call site.

Two mechanisms:

1. **Deny-list by normalized key name.** `apiKey`, `api_key`, `API-KEY` and
   `x-api-key` all collapse to the same check, so a naming convention change
   cannot open a hole.
2. **Value-shape detection**, for secrets that appear under an innocent key:
   bearer tokens, PEM blocks, and base64url strings long enough to be one of our
   own session tokens.

Also handled: cycles (`[CIRCULAR]` rather than hanging — a trivially triggerable
DoS if a request-scoped object were ever logged), depth limits, and `Error`
objects reduced to name and message so stacks never reach the log.

**Limitation:** redaction cannot catch a secret embedded in free text — a
password pasted into a note body. The mitigation is not logging user content at
all, not better regexes. 25 tests cover the above, including one asserting Arabic
content survives untouched.

## The audit log is append-only

`edu_app` is granted `INSERT` on `audit_log` and **nothing else**. It cannot read
entries back, amend one, or delete one. An attacker who achieves arbitrary query
execution through the application role therefore cannot erase their trail, and
cannot mine the log for other users' activity. RLS adds a second layer: there is
no `SELECT` policy at all, so even a mistaken grant would return nothing.

Reading the log is an operator action requiring a separate role that **does not
exist yet**.

## Event taxonomy

`auth.login.succeeded` · `auth.login.failed` · `auth.logout` ·
`auth.session.rejected` · `auth.registered` · `authz.denied` ·
`ratelimit.exceeded` · `validation.rejected` · `payload.too_large`

`authz.denied` is the important one. It fires on every authorization denial —
**including** denials where RLS hid the row before the policy engine ran (see
VULN-002). Without that, id enumeration blocked by RLS would produce no signal at
all. It carries the action, resource kind, resource id and rule name; never
content.

## What is never logged

Passwords, password hashes, session tokens, API keys, cookies, authorization
headers, private keys, OTP/MFA codes, and student note content. The login-failure
event deliberately does **not** record the attempted email, so the audit log does
not accumulate addresses people typed by mistake — including ones belonging to
non-users. Tests assert both the password and the email are absent.

## Known weakness: audit writes are best-effort

A failed audit write is logged at error level but does **not** fail the request.

Deliberate, for _this_ class of event: a database hiccup logging an entire school
out is worse than a gap in the authentication trail. It is the **wrong** policy
for future grade or financial mutations, which need a separate writer with
fail-closed semantics. Recorded as RISK-AUDIT-01.

## Not built

Metrics (no counters, histograms, or `/metrics` endpoint). Distributed tracing —
`correlationId` is generated per request and threaded through logs and audit
entries, which is the groundwork, but there are no spans and no propagation. Log
shipping, retention policy, alerting rules, dashboards, and anomaly detection on
`authz.denied` bursts: none exist.
