# Contributing

The bridge currently targets macOS, Node.js 22 or newer, and local sessions belonging to the same operating-system user. See [README.md](README.md) for runtime requirements and installation.

## Local checks

From a clone of this repository:

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

Tests use temporary state directories and local Unix sockets. Run them in an environment that permits those sockets. Do not point test fixtures at an existing installation or a real agent's private state.

Global installation is a separate integration step. It changes user-level plugin registrations and may configure an editor. Unit tests passing does not establish that a running Claude session loaded the Channel or that an agent acknowledged a message. Report live integration checks separately, including runtime versions and which direction was tested.

The GitHub Actions workflow runs dependency installation, type checking, tests, and build on macOS with Node.js 22 for pull requests and pushes to `main`. Runs are limited to 15 minutes, and a newer run on the same ref cancels the previous one. A reviewed workflow file is not evidence that GitHub has executed it successfully; link the actual run when reporting CI results.

## Changes and review

Keep changes focused, use descriptive identifiers, and preserve existing user configuration. Add tests for changed behavior, especially cancellation, concurrent updates, session replacement, and uncertain delivery outcomes. Use conventional commit messages without generated attribution trailers.

In a pull request, describe the observed problem, resulting behavior, checks performed, and remaining verification limits. Changes to message fields, commands, tools, or configuration must update the relevant README and skill instructions. Changes to a reviewed commit need another review.

Do not commit local agent memory, environment files, credentials, generated builds, or transcripts. Example configuration must contain placeholders. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Distribution and licensing

The repository distributes through a source checkout under the [MIT License](LICENSE); its packages remain private to prevent accidental npm publication. Contributions must be compatible with this license. Preserve applicable copyright and license notices when including third-party code.
