VideoRTC v1.6.0, based on go2rtc v1.9.14:
https://github.com/AlexxIT/go2rtc/blob/v1.9.14/www/video-rtc.js
MIT license in LICENSE. Downloaded 20 October 2026.
Original upstream SHA-256: `d48ce627baf7c341a92c0f5844a3c546431f9db873ff21489671aba2ecfe64fb`.

The dashboard wrapper restricts this transport to MSE/video/H.264. Its own
initialization, visibility handling, bounded reconnect and immediate teardown
replace the upstream UI lifecycle; no upstream WebRTC/STUN modes are enabled.
Local lifecycle patch: MSE source/listener ownership is invalidated before video
teardown or replacement. Queued updateend/binary callbacks check that their source
buffer remains attached, avoiding Chromium InvalidStateError during navigation,
hidden-tab disposal, logout and reconnect. No protocol or codec changes.
Focused synthetic lifecycle coverage is in `src/lib/live-player-mse.test.ts`.
The vendored JavaScript retains upstream style and is excluded from project ESLint;
the wrapper, declarations and tests use the project's strict TypeScript checks.
