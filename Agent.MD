# Open-source project rules

This repository is a public, open-source project. Treat every file, commit,
test fixture, log, screenshot, recording, issue, and generated artifact as if
it may be published.

## Information safety

- Do not copy, reference, infer, or disclose any private application source,
  product behavior, test flow, architecture, customer data, credentials,
  identifiers, service URLs, certificates, keys, tokens, or internal tooling.
- Do not add screenshots, accessibility-tree captures, videos, logs, or other
  fixtures captured from a private application. Use the repository's own
  purpose-built sample app or wholly synthetic fixtures only.
- Do not use private repositories, local workspaces, accounts, or services as
  dependencies or test targets.
- Use generic names and fictional data in documentation and tests (for
  example, "Example App", "Alice", and "Bob").

## Project boundaries

- Keep the public API portable and app-agnostic. Application-specific setup,
  cleanup, identity, networking, and simulator provisioning belong in consumer
  code or optional integrations, not in this core project.
- Prefer documented, versioned interfaces. Keep the AXe CLI isolated behind a
  typed adapter so upstream changes are contained.
- Tests must run without a simulator by default, using synthetic or
  purpose-built JSON fixtures. Simulator-backed end-to-end tests must be
  explicitly opt-in.

## Before contributing

- Review new files and generated artifacts for accidental private information.
- Do not publish, push, or send anything externally unless explicitly asked.
- If there is any doubt about whether material is public, treat it as private
  and ask before adding it.
