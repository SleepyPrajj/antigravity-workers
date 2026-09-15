# Contributing

Open an issue with the expected behavior, actual behavior, operating system, Node.js version, and a minimal reproduction. Remove private project details, account identifiers, credentials, and provider responses from reports.

For a pull request:

1. Keep the change focused and explain the user-visible behavior.
2. Add a meaningful regression test when changing scheduling, isolation, protocol handling, or patch application.
3. Run `npm test`. These tests use a mock CLI and do not call a provider.
4. Preserve approval boundaries and inspect generated patches before integration.

Do not include local state, media from private projects, or generated run logs. Live provider tests are optional and must be explicitly opted into by the person running them.

By contributing, you agree that your contribution is licensed under the repository's MIT license.
