# Security Policy

## Supported versions

Only the latest published release line receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately: open a GitHub Security Advisory
(Repo -> Security -> Advisories -> Report) or email the maintainer via the
profile on this repository. Do **not** open a public issue for suspected
vulnerabilities.

Please include reproduction steps and the versions involved. Expect an
acknowledgment within a few days.

## Scope notes

- This project runs an agent harness on your machine; commands the model
  issues execute under dsh's own sandbox and approval stack. Bypasses of
  that stack belong upstream (dsh), but reports are still welcome here.
- HTTP transports (`serve`, web-mounted) are intended for localhost or
  trusted networks unless a `token` is configured - treat an untokenized
  listener like an open shell on your machine.
