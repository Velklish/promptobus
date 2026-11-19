# Gate instruction links: compatibility inventory

Sources in the project tree at `791d9bdd7b1b28cba8bb121ea3cdf3825d70763f`:

- **Installation configuration.** `git ls-files '*promptobus.json'` listed only the root `promptobus.json`. It declares `generate` and no pipeline. `git ls-files -s` showed no tracked symbolic links.
- **Published examples.** The [install guide](../guides/install.md#the-pipeline) and the [schema example](../../schemas/v1/pipeline.schema.json) name `docs/security-review.md`. Neither example specifies that the path should be a symlink.
- **Regression fixtures.** `test/pipeline.test.mjs` creates `security.md` and `release.md` under temporary install roots. Its `../outside.md` case expects refusal. These are test inputs, not consumer configurations.

None of these sources identifies an installation that intentionally links to external gate instructions. Consumer configurations outside the checkout were unavailable for this inventory; personal installations were not inspected. The number of affected consumers is unknown. Any installation relying on an external target must move or copy the file under its install root; internal targets remain supported.
