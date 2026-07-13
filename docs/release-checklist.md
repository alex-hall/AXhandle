# Release checklist

This repository remains private until a maintainer makes the decisions in the
publish gate below. Running these checks prepares a release; it never publishes
or pushes anything.

## Verify the candidate

- Run `npm run typecheck`, `npm test`, and `npm run build`.
- Run `npm pack --dry-run` and confirm the tarball contains only `dist`, the
  README, changelog, and package metadata. Sample apps, fixtures, captures,
  tests, and local artifacts must remain excluded.
- On the validated environment, run the opt-in SwiftUI and React Native e2e
  flows from the README. Record compatibility changes in
  `docs/compatibility.md` before supporting a new AXe version.
- Review `Agent.MD` and every candidate diff for public-information safety.

## Publish gate — maintainer decisions required

- Confirm npm organization/owner and whether `axe-typescript` is the final
  public package name.
- Set the initial semantic version, repository URL, issue tracker, and package
  metadata once those public destinations exist.
- Choose release authority and automation (for example, protected tags plus a
  CI publish workflow). Do not add registry credentials to the repository.

## Publish

Only an authorized maintainer should run the final registry publish command.
Afterward, record the released version and date in `CHANGELOG.md`.
