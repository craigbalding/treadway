# Run CI and publish a release

Releases publish tested wheels and source archives to
[GitHub Releases](https://github.com/craigbalding/treadway/releases), with
`SHA256SUMS`. PyPI publishing is not configured.

## Publish a version

1. Choose a new version. Update `pyproject.toml`, `src/treadway/__init__.py`,
   both `package.json` files and their lockfiles.
2. Run `python .github/scripts/check_version.py`, merge to `main` and wait for CI.
3. Tag that exact commit and push the tag. Replace the example version below
   with the version you updated in step 1:

```sh
git tag -a v0.2.1 -m 'Treadway 0.2.1'
git push origin v0.2.1
```

The tag run repeats all checks, uploads the tested archives and publishes the
GitHub release. A mismatch or failed check prevents publication. Resume a failed
publication by rerunning its failed job; a published version must not be overwritten.
Use a new version for package changes. Tags have three numeric components;
`0.x` denotes development before the stable API.

## What CI runs

| Trigger | Checks |
| --- | --- |
| Pull request | Python contracts on 3.11 and latest stable Python, Node 22 contracts, Ruff, sandboxed Chrome smoke and synthetic Entra checks |
| `main`, manual run, version tag | The above, plus source/wheel build, package assets/metadata, fresh-wheel runtime tests and exported walkthroughs |
| Version tag only | Publish the exact tested distributions and checksums |

Contract and fast-browser jobs have five-minute limits. The distribution job has
a ten-minute limit. Superseded PR runs are cancelled. Chrome comes from the Ubuntu
24.04 runner image and uses its sandbox; no browser binary is bundled.

The optional RPA integration and experimental backend comparison have separate
checks. CI uses read-only repository permissions except the tag publication job;
actions are pinned to commit IDs. No package-index token is required.

For local checks, use [fast feedback](FAST-FEEDBACK.md). Downloaded wheels require
[the locked Node dependency step](INSTALLING.md#from-a-github-release).
