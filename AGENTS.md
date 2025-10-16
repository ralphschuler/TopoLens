# Agent Guidelines

- Always run the existing automated test suites (`npm test` in both `api/` and `web/`) before making any code changes. Use their output to understand the current state and plan your implementation.
- Implement changes test-first whenever practical: add or update failing tests before adjusting the production code.
- Never commit code that fails `npm test`, `npm run lint`, or `npm run format` in either package.
- When adding tooling or scripts, update the documentation or configuration necessary so that other agents can follow these conventions without extra setup.
