# Repository instructions

- Implement only the authorized phase. Phases 1/2 remove Frigate application integration and consolidate the Uniview client. Phase 3 adds verified historical image-reference resolution and additive metadata schema offline. Production migrations, live resolution, deployment, AI enablement and publishing require separate approval; existing services and historical records remain untouched. Both Uniview cameras are verified.
- Uniview NVR owns detection identity and native lifecycle. One canonical SecurityEvent per stable installation UUID/channel/alarm type/RelatedID, enforced by PostgreSQL. Never merge RelatedIDs by proximity or create canonical events from processing retries.
- Uniview is the authoritative detection source. Preserve historical integration records and migration files; no downstream interpretation may overwrite NVR facts or manufacture an authoritative end.
- Do not access or modify running PostgreSQL, Docker services, NVR, Frigate, Home Assistant or Node-RED without explicit approval. Live destructive SQL needs read-only target/dependency/consumer preflight and review of exact SQL before execution.
- Never drop unrelated data, the entire public schema, PostgreSQL volumes or containers. Migrations are explicit operator operations, never application startup side effects.
- Use strict TypeScript, Zod boundaries, dependency injection, separate executable entry points and structured logs. Credentials stay in environment variables, never source or logs. Do not publish PostgreSQL ports.
- Store selected source metadata and media references in PostgreSQL. JPEGs remain in bounded receiver RAM only. Never persist image bytes/Base64 in files, PostgreSQL, temporary directories or queues. Commit canonical metadata independently of optional sampling. Never substitute later live snapshots for original event images.
- Preserve source timestamps/counts and image timestamp uncertainty. Unknown counts are not zero. NotificationType is not a verified end enum. No recognition, frontend, recordings or grouping.
- Logs use UTC/service/environment and validated UUID context. Never log raw bodies, media, prompts, AI descriptions, personal details or credentials. Redaction is a second layer.
- Metrics are off by default, authenticated when enabled, with bounded code-defined labels; no camera/source/request/event identifiers as labels.
- Use database/client doubles and synthetic in-memory media in tests; never live infrastructure. Run focused tests during development, then affected integration suite, lint, typecheck, Prisma validation and build.
- Keep README, architecture, implementation plan and release documentation consistent with code. No legacy import or compatibility machinery for disposable test data.
- Do not delegate unless explicitly requested by the user.
