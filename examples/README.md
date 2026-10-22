# Examples

Runnable, self-contained demonstrations of what `tsagent` can do. Each
file shows one capability and prints human-readable output so you can
see exactly what happened.

These are **not** tests. For the verification suite, see
`scripts/verify_*.ts` and `npm run verify:all`.

## Prerequisites

```bash
cp .env.example .env
# edit .env — set GEMINI_API_KEY (or GOOGLE_API_KEY)
npm install