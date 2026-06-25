# Matt Training Log — PWA (Phase 1)

A phone-friendly web app that **reads** today's prescription (`docs/today.json`,
emitted by `engine/render_today.py`) and **writes** a filled LOG block to
`inbox/session-<n>-<date>.md` in the training repo. It does **no** progression
math — `log_session.py` / `analyze.py` still run on the PC.

## How the loop works
1. App reads `docs/today.json` from the repo via the GitHub Contents API.
2. You pick the gym once, adjust the pre-filled loads/reps/RPE, fill sleep &
   soreness, tap **Submit**. The app commits `inbox/session-<n>-<date>.md`.
3. On the PC (on `master`):
   ```
   git pull
   python engine/log_session.py --log inbox/session-<n>-<date>.md
   git push
   ```
   `log_session.py` appends the session, rebuilds `today.md` + `today.json`,
   deletes the consumed inbox file, and commits.
4. Reopen the app → next session's plan.

## One-time setup
1. **Private repo:** push this repo to a private GitHub repo and set `git_remote`
   in `config.yaml`.
2. **Token:** create a **fine-grained personal access token** scoped to *only*
   that repo, **Contents: Read and write**, with an expiry. (Settings → Developer
   settings → Fine-grained tokens.)
3. **Host the app:** this `app/` folder is static. Easiest is to move it to its own
   **public** repo and enable **GitHub Pages** (HTTPS is required for install +
   service worker). No secrets live in the code — the token is entered at runtime
   and stored only in your phone's browser.
4. On the phone, open the Pages URL → **⋮ → Add to Home screen**. Open Settings in
   the app, paste the token + owner/repo, **Save & test**.

## Notes
- The token lives in `localStorage` on the device only. Revoke it from GitHub if
  the phone is lost; the blast radius is this one repo.
- Offline: the app shell is cached by the service worker and the last good plan is
  kept locally, so you can fill the form at the gym and submit when back online
  (drafts are saved per session).
- Icons are SVG; swap in PNGs (192/512) if you want maximal Android polish.
