# Contributing to TrueOwn

Thanks for helping people see who really owns their neighborhood businesses. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Ways to help

- **Report a data error or ownership change** using the *Data correction* issue template. Every claim needs a public source.
- **Report a bug** or **suggest a feature** with the matching issue template.
- **Send a pull request** for code, tests or docs.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Ownership data rules

Data integrity is the core of this project. A change to a brand's tier or parent must include:

1. A **public source link**: SEC filing, official press release, PitchBook/Crunchbase/Mergr record, or a reputable news report. Tier 3 claims can cite the NYS Division of Corporations, Eater NY or documented local consensus.
2. The **date you verified it**.
3. Neutral wording. State what the source says; do not editorialize.

Claims without a source will be declined. Never include private information about individuals.

## Development setup

Requires Node 20+ and Docker.

```bash
git clone <your-fork-url> && cd trueown
npm install
cp .env.example .env.local
docker compose up -d db
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trueown
npm run db:import:boundaries
npm run dev
```

See the [README](README.md) for configuration and [DEPLOYMENT.md](DEPLOYMENT.md) for hosting.

## Before opening a pull request

```bash
npm run typecheck
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trueown npm test
```

Use `npm test` (not bare `jest`); it runs suites serially because several share a database. CI runs the same checks.

## Code conventions

- **TypeScript, strict.** No `any`; validate all external input.
- **Naming:** `snake_case` for functions, variables and database objects; `PascalCase` for types and components.
- **Fail closed.** Reject unknown or malformed input with an explicit error; never default to permissive behavior.
- **SQL:** always parameterized. Never build queries from user strings.
- **Migrations:** add a new file in `supabase/migrations/` (never edit an applied one). Enable RLS and add explicit `GRANT`s for every new table in the same migration. Mount new migrations in `docker-compose.yml`.
- **Tests:** add or update tests for behavior changes, including failure cases.
- **Secrets:** never commit `.env.local`, keys or passwords.
- Keep changes focused; unrelated refactors belong in separate pull requests.

## Pull request process

1. Fork and create a branch (`fix/...`, `feat/...`, `docs/...`).
2. Make your change with tests and updated docs.
3. Use clear commit messages, preferably [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`).
4. Open a pull request and complete the template. CI must pass.

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
