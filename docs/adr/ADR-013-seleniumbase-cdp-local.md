# ADR-013 — SeleniumBase/CDP local experiment

Status: Accepted for local testing at the user's request, 2026-09-22.
Supersedes ADR-012's exclusion of a Python browser launcher only. No new service,
database schema, external solver, remote browser provider or production rollout.

## Decision and plan

1. Add `CAPTURE_BROWSER_ENGINE=seleniumbase` alongside default `playwright`.
2. A Python child inside Capture Worker starts SeleniumBase CDP Mode on blank,
   through the existing SafeProxy. Node Playwright attaches over loopback CDP.
3. Keep WebLens's isolated `newContext` settings (service workers/downloads
   blocked) instead of using the launcher's default profile as the README does.
   Interactive login and clone rendering continue to share that protected context.
4. Do not stack playwright-extra patches onto SeleniumBase. No automatic CAPTCHA
   solving or extra validation gate before ZIP export.
5. Pin SeleniumBase, build Python into the local Docker image, put launcher
   profiles in a dedicated tmpfs, and bound startup/shutdown. Do not pass worker
   DB/storage credentials to the child. No CDP/X11 ports are published.
6. Verify attach, route/resource capture, session cookies, owner-context isolation,
   private network rejection and browser/process/profile cleanup before activation.

## Security and deviations from upstream examples

SeleniumBase defaults can disable site isolation, download protections and TLS
checks when proxying. Filter those arguments in a pinned Config subclass; disable
expert mode. Proxy is set before any navigation; no external URL is handed to
Python. Keep Chromium's implicit loopback proxy bypass disabled. No use of
`sb.goto` before Playwright guards or the README's `solve_captcha` method.

Chromium sandbox remains disabled as in the existing Playwright deployment;
this experiment does not claim that container isolation equals browser sandboxing.
Enabling OS sandboxing requires a separate deployment hardening check. Browser
profiles in this mode require Linux tmpfs: fail closed outside the supported local
container, and do not silently fall back to disk or to another browser engine.

## Consequences

Python/SeleniumBase adds substantial transitive dependencies. Reuse the Chromium
already present in the image rather than download a second system Chrome. This is
the README's launch/attach pattern adapted to Node, not an exact Python example.
CDP compatibility must be tested; headed/CDP does not guarantee Cloudflare access.
Go discovery still has no browser cookies. Restart loses interactive sessions.

Rollback: set `CAPTURE_BROWSER_ENGINE=playwright`, recreate Capture Worker.
VPS Windows-native remains on Playwright unless separately designed and deployed.

Source: https://github.com/seleniumbase/SeleniumBase/blob/master/examples/cdp_mode/playwright/ReadMe.md
