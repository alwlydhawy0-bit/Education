# File Security Architecture

> **STATUS: DESIGNED. NOT IMPLEMENTED.**
>
> There is no upload endpoint, no storage adapter, and **no malware scanning** in
> this repository. Nothing in this document describes a control that currently
> exists. It is recorded now so that the pipeline is designed before the first
> upload route is written, rather than retrofitted after.

## Threat premise

An uploaded file is hostile input authored by an attacker who chose every byte.
It may be a polyglot (valid PDF _and_ valid HTML), an archive bomb, a crafted
image targeting a parser CVE, a document carrying an active payload, or a PDF
containing text designed to hijack a downstream LLM.

## Pipeline

```
upload → quarantine → validate → scan → promote to safe store → parse → index
```

Each stage may only receive input from the previous one. **Nothing is served
from quarantine.** A file becomes reachable only after scanning succeeds.

### 1. Upload

Size limits enforced before the body is read. Per-user and per-IP upload rate
limits. An allow-list of accepted types — never a deny-list.

### 2. Quarantine

A separate bucket with no public access, no CDN, and no application read path.
Object keys are random and unrelated to the filename.

### 3. Validate

- **Type is determined by magic bytes**, never by extension, filename, or the
  client's `Content-Type`. All three are attacker-controlled.
- The sniffed type must match the declared type _and_ be on the allow-list.
- Filenames are never used as storage paths (path traversal) and are stored as
  metadata only, sanitized for display.
- Structural validation per type: page/dimension caps, decompression ratio caps
  for anything archive-like.

### 4. Scan

Malware scanning in an isolated worker with no network egress and no credentials.
Scan failure or timeout ⇒ the file stays quarantined. **Fail closed.**

### 5. Safe storage

- Files are served from an **origin distinct from the application**, so a stored
  HTML/SVG payload cannot reach same-origin session cookies.
- `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, a
  restrictive CSP, and a `Content-Type` taken from the _sniffed_ type.
- Access via short-lived signed URLs issued **after** an object-level
  authorization decision — the same policy-engine pattern as every other
  protected resource. A signed URL is a capability, so its lifetime must be
  short and it must never be logged.
- Files are never executed. Ever.

### 6. Parse and index

Parsing runs in a sandboxed worker: no network, no filesystem beyond a temp dir,
CPU and memory caps, hard timeout. A crash affects one job.

Extracted text carries the uploader's access scope into the index. It is treated
as **data, never as instructions** when it later reaches an LLM.

## Non-negotiables

1. Never trust the extension, the MIME type, the filename, or client-side
   validation.
2. Never execute an uploaded file.
3. Never serve unscanned content.
4. Never serve user files from the application origin.
5. Authorize before issuing a signed URL, not after.
6. Fail closed at every stage.

## What Task 010 built against this design, and what it deliberately did not

`student_artifacts` (migration 0025) is a **metadata registry**, not a file
store. It exists so the accounting and the naming are settled before the first
byte arrives:

- **No upload route and no download route.** Non-negotiable 3 — never serve
  unscanned content — with no scanner means there is nothing safe to serve, so
  nothing is offered. `student_artifact:download` is not in the action
  vocabulary either; adding it is the visible diff that says the pipeline exists.
- **Object keys are random and unrelated to the filename**, as stage 2 requires:
  the key is `org/<organization>/user/<owner>/<artifact id>`, derived by a
  database trigger. The API has no field through which a caller could supply
  one, so non-negotiable 1 — never trust the filename — is structural here
  rather than validated.
- **An allow-list of accepted types**, per artifact type, as stage 1 requires.
  `image/svg+xml` is excluded: a document that can carry script is not a picture.
- **Size limits before the body is read**, as stage 1 requires: 25 MiB per
  artifact and 256 MiB per learner, the latter enforced in a `BEFORE INSERT`
  trigger because an application-level check races concurrent registrations.
- **Per-user upload rate limits**, as stage 1 requires: `workspace.artifact`.

Still absent, and still required before any byte is accepted: quarantine,
magic-byte sniffing, malware scanning, a separate serving origin, and signed
URLs issued after an authorization decision.

## Verification plan (when built)

Upload of a polyglot; extension/content mismatch; oversized file; archive bomb;
cross-user access to another student's file by exact id; access to a quarantined
file; expired signed URL; a stored-XSS payload proven non-executable in the
browser; scanner-unavailable ⇒ request refused.
