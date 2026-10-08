# Contributing to Shoal

Thanks for helping. Shoal is licensed under the [Apache License 2.0](LICENSE), and contributions
come in under the same license (section 5 of the license).

## Sign off every commit (DCO)

Each commit must certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the change, or otherwise have the right to submit it under the project's license.
You certify it by adding a `Signed-off-by` line that matches the commit's author:

```sh
git commit -s -m "fix: ..."
# adds: Signed-off-by: Your Name <you@example.com>
```

CI rejects a pull request with an unsigned commit. To sign off commits you already made:

```sh
git rebase --signoff origin/main
git push --force-with-lease
```

**Code written for an employer may belong to the employer.** Sign off only work you have the
right to contribute, for example work done on your own time and equipment, or with your
employer's written permission.

## Keep real data out

The repository is public. Tests, fixtures, examples and docs use invented data only (`DEMO`,
`ACME`, `alice`). Never paste task titles, names, IDs, tokens or exports from a real workspace,
including anything from your employer or a customer.

## Before opening a pull request

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm test:e2e      # when the web board changes
```
