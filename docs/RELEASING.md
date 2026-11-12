# CI and GitHub releases

Pull requests run Python contracts on Python 3.11 and the latest stable Python,
Node 22 contracts, focused Ruff error checks and sandboxed Chrome smoke checks.
These independent jobs have five-minute limits and superseded PR runs are
cancelled. The browser smoke command normally takes seconds; dependency setup
and runner queue time add to hosted feedback latency.

Pushes to `main`, manual workflow runs and version tags additionally build the
source archive and a wheel from that archive. CI checks package assets and
metadata, installs the exact wheel in a fresh environment, runs the full
browser/Robot suite against installed Python and JavaScript, and exercises all
three exported walkthroughs. Browser prerequisites are required in CI. Chrome
comes from the Ubuntu 24.04 runner image and runs with its sandbox enabled;
no browser binary is included in Treadway. The optional RPA Vault integration
and experimental backend comparison are outside these default checks.

Release publishing uses GitHub only. No package index token is needed. All jobs
have read-only repository access except the tag-only publication job. Actions
are pinned to commit IDs. The published wheel and source archive are the same
files tested by CI, accompanied by `SHA256SUMS`.

To release a version:

1. Update `pyproject.toml`, `src/treadway/__init__.py`, both `package.json` files
   and their lockfiles. Run `python .github/scripts/check_version.py`.
2. Merge to `main` and wait for CI to pass.
3. Tag that commit with the exact version, for example:

   ```sh
   git tag -a v0.2.0 -m 'Treadway 0.2.0'
   git push origin v0.2.0
   ```

The tag run repeats the release checks and publishes a GitHub Release with
generated notes after they all pass. A version mismatch or failed check prevents
publication. Tags use three numeric components; `0.x` denotes development before
the stable API. A manual workflow run validates artifacts without publishing.
Published versions must not be overwritten; fix a failed publication and rerun
the failed job, or release a new patch version when the package changes.

Download the wheel from [GitHub Releases](https://github.com/craigbalding/treadway/releases)
and follow [wheel installation](INSTALLING.md#from-a-github-release), including the
locked Node dependency installation. PyPI publishing will be added separately.
