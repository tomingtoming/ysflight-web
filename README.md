# ysflight-web

YSFLIGHT web is a WebAssembly port of Soji Yamakawa (CaptainYS)'s
[YS FLIGHT SIMULATOR](https://ysflight.org), runnable in any modern browser
with WebGL — no installation required.

**▶ Play: https://ysflight-web.toming.app**

> 日本語: [YS FLIGHT SIMULATOR](https://ysflight.org)（CaptainYS 氏作）を
> Web ブラウザで遊べるようにした WebAssembly (Emscripten) 移植です。
> インストール不要、上のリンクからそのまま遊べます。設計ドキュメント
> （`docs/`）は日本語で書かれています。

## Architecture

```
upstream/YSFLIGHT   emscripten branch of tomingtoming/YSFLIGHT (fork of captainys/YSFLIGHT)
upstream/public     emscripten branch of tomingtoming/public   (fork of captainys/public)
src/port/           platform layer written for this repository
  fssimplewindow/     Emscripten backend (WebGL context, DOM input events, timers)
  fslazywindow/       emscripten_set_main_loop driver
web/                index.html shell (loading UI, IDBFS persistence, language setting)
worker/             WebRTC signaling (Cloudflare Worker + Durable Object)
scripts/            build.sh / smoke-test.sh / serve.mjs
docs/               design documents (multiplayer.md and others; written in Japanese)
```

Changes to the upstream engine are managed as **ordinary, theme-scoped commits**
on the forks' `emscripten` branches (the old `patches/*.patch` scheme is gone).
The delta against upstream is listable with

```sh
git -C upstream/YSFLIGHT log --oneline master..emscripten
git -C upstream/public   log --oneline master..emscripten
```

and when upstream moves, we follow with `git fetch upstream && git rebase
upstream/master`. Pure bug fixes that could be PRed upstream (e.g. the ysgl
sampler-uniform bug) are kept as separate commits so they can be cherry-picked
and proposed as-is.

Technical highlights:

- Rendering uses YSFLIGHT's existing **OpenGL ES 2.0 backend**
  (`graphics/gl2.0`, originally for the Android port) directly on WebGL 1.0
  (`-sFULL_ES2`)
- The main loop connects `fslazywindow`'s callback structure to
  `requestAnimationFrame`
- Game data (`runtime/`, ~25MB) is packaged into a `.data` file with
  `--preload-file`
- User settings (`/home/web_user/Documents`) persist via **IndexedDB (IDBFS)**
- **The simulation runs single-threaded** — with `-pthread` (and without
  `-sPROXY_TO_PTHREAD`), `main()` and the main loop run on the browser's main
  thread, and `YsThreadPool` blocks it on a `condition_variable` waiting for
  workers; a delayed or stalled worker then freezes the whole page (rAF stops).
  So the web build runs single-threaded, which also means no
  SharedArrayBuffer / COOP+COEP requirement (re-enabling threads would need
  `-sPROXY_TO_PTHREAD` + OffscreenCanvas)
- **PWA**: Service Worker gives offline play and instant startup after the
  first visit. Assets are served under content-hashed file names, so updates
  never fight the cache (`_headers` marks them immutable)
- **Background-tab support**: while the tab is hidden the simulation keeps
  running driven by a Web Worker (prevents disconnects during multiplayer;
  rendering is skipped)

## Build

Prerequisites: [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), CMake 3.20+, Node.js

```sh
git clone --recursive git@github.com:tomingtoming/ysflight-web.git
cd ysflight-web
scripts/build.sh           # emcmake configure -> build -> staged into dist/
node scripts/serve.mjs     # serve dist/ locally (plain static serving; no COOP/COEP needed)
```

Drop the contents of `dist/` (`index.html` + `ysflight32_gl2.{js,wasm,data}`)
onto any static hosting and it runs. Nothing in the runtime depends on this
project's infrastructure, so anyone can re-host their own instance.

### Smoke test

```sh
scripts/smoke-test.sh            # default (software GPU) + strict (real GPU / Mesa GL)
```

`strict` launches the system Chrome **headed** on native Mesa GL
(`--use-angle=gl`) and verifies boot. Real drivers lower mediump to fp16, so
this catches shader precision-mismatch link errors that software rasterizers
silently tolerate (needs a display + google-chrome). CI runs `default` only.
**Always run this before pushing renderer changes.**

## Deploy

The production URL is **https://ysflight-web.toming.app** (a Cloudflare
Workers custom domain).

Production runs on **Cloudflare Workers** (configured in `wrangler.jsonc`).
The Worker itself is `worker/signal.js` (WebRTC signaling at `/signal`, a
Durable Object `SignalHub`), and the game (`dist/`) is served from the same
Worker as **Workers Static Assets** (`assets.directory: ./dist`). It is
**not Pages** (migrated off the old Pages setup).

Connect the repository with **Workers Builds** (the Worker's Git integration)
and set the build settings to:

- Build command: `scripts/build.sh`
- Deploy command (production branch): `npx wrangler deploy`
- Deploy command (non-production branches = previews): `npx wrangler versions upload`

Cloudflare's build image does not ship Emscripten, so `scripts/build.sh`
auto-installs `emsdk` into `$HOME/opt/emsdk` when `emcmake` is missing (CMake
is fetched the same way). Pin with the `EMSDK_VERSION` environment variable
(default: `6.0.0`). The build fully compiles YSFLIGHT to wasm, so it takes a
few minutes.

> **CI and deploy are separate pipelines.** GitHub Actions
> ([`.github/workflows/build.yml`](.github/workflows/build.yml)) runs
> `scripts/build.sh` → unit + signaling/browser smokes on push / PR — it
> builds and tests but never deploys. Production updates happen via the
> **Cloudflare Workers Builds hook on pushes to main** (there is no
> `wrangler deploy` step on the GitHub side). Manual deploys:
> `npx wrangler deploy` with the connected account's credentials. In
> `wrangler deployments list` the Author is the connected Cloudflare
> account's email address (it differs from the repository committer
> `tomingtoming`; that is not a misconfiguration) and the Source shows as
> `Unknown (deployment)`.

### PR preview URLs

Builds of non-production branches (PRs) create **preview versions** via
`wrangler versions upload`, and each version gets a preview URL of the form:

```
https://<version-prefix>-ysflight-web.<subdomain>.workers.dev
```

(`<version-prefix>` is the first 8 characters of the version ID.
**Precondition**: the Worker's Preview URLs are enabled — dashboard →
Workers & Pages → `ysflight-web` → Settings → Domains & Routes (under
Triggers in some UI versions) → **Preview URLs**, with the `*.workers.dev`
subdomain also enabled.)

**Finding the URL** — unlike Pages, **Workers Builds does not comment the
URL on the PR**. Check either:

- the `Version Preview URL:` line at the end of the build log (linked from
  the Workers Builds check)
- the dashboard's **Deployments tab** → the preview URL link on each version

The only thing attached to the GitHub PR is the single pass/fail
"Workers Builds" check.

> Note: preview URLs are only assigned to versions uploaded **after Preview
> URLs were enabled**. Preview URLs of earlier builds 404 (rebuild and it
> gets one).

### Verifying a live deploy

After a push to main, Workers Builds runs the full wasm build, so it takes a
few minutes to land. To confirm what is actually live (the Message column of
`deployments list` is always `-` — the git SHA is not recorded — so
**comparing content is the reliable way** to know which commit is live):

- `npx wrangler deployments status` … the active version and its creation time
- `npx wrangler deployments list` … history (Author = connected account, Message `-`)
- **Static assets**: fetch `curl -s https://ysflight-web.toming.app/pack-net.js`
  and `diff` it against your local `web/pack-net.js` (`dist/<file>` is a copy
  of it) — byte-identical means deployed
- **The Worker (`/signal`)**: updated **atomically together with the assets**
  by the same `wrangler deploy` (one commit = `worker/signal.js` + `dist/` in
  one shot). To probe behavior, send `{t:'host',room,manifest}` to
  `wss://ysflight-web.toming.app/signal` and look for the `host-ok` response
  (rooms are in-memory and vanish on disconnect)

Disable GitHub Pages in the repository settings.

## Controls

Same keyboard controls as desktop YSFLIGHT (arrow keys: stick, Q/A:
throttle, Z/X: rudder, G: gear, Space: guns, etc.). Start a flight from the
menu via Simulation → Create Flight. As on desktop, with no joystick
connected **the mouse acts as the stick** (screen center is neutral).

**Gamepad / joystick support** (Gamepad API): connect a pad and press any
button — the browser then exposes it and the game can use it (that is how
the Gamepad API works). Axis/button assignments can be changed under
Option → Config Key/Mouse/Joystick Assignment. The standard-mapping D-pad is
treated as a POV hat.

## Multiplayer

Browser-to-browser **WebRTC P2P**. One player clicks "Start server" to host
(an 8-digit `Room: 12345678` code appears at the top right of the screen);
others either open the invite link (`?join=12345678`) and enter a name to
join automatically, or type the 8 digits into the "Room ID" field under
Network → Client. Game data flows directly over a P2P WebRTC DataChannel;
NAT traversal uses Cloudflare Realtime TURN (STUN + a TURN relay for pairs
that cannot connect directly), with credentials served by the Worker's
`/turn`. The host's browser is the server authority (the web build has no
chat or port settings — P2P/Room ID only).

Signaling (SDP/ICE exchange only; no game data passes through it) is handled
by the site's own `/signal` endpoint — a **Cloudflare Worker + Durable
Object** (`worker/signal.js`). Because it is `wss://` on the same origin as
the site, there is no separate signaling server to run and no TLS
certificate or mixed-content juggling. Override with `?signal=wss://...`,
pin a room code with `?room=`, or specify a join target with `?join=`.

Details: [docs/multiplayer.md](docs/multiplayer.md) (Japanese).

> **NAT traversal / connectivity**: most residential connections connect
> directly with STUN alone. When both sides are mobile / CGNAT / symmetric
> NAT (e.g. Starlink IPv4) and cannot connect directly, the connection goes
> through the **Cloudflare Realtime TURN** relay (the Worker's `/turn` issues
> short-lived credentials; without configuration it falls back to plain
> STUN). The connectivity badge in the menu shows in advance whether your
> side can connect directly. Two IPv6 peers can usually connect directly.
> Setup and cost: [docs/multiplayer.md](docs/multiplayer.md).

## Usage counting

The deployed site counts how much it is actually played: one event when a page
is opened, and one at each end of a flight (its length, and whether it was
flown solo, hosted, joined, or in VR). No account, no cookie, no personal data;
a random id in `localStorage` is what separates ten visits by one person from
ten people.

The signaling hub separately counts *rooms* -- opened, joined, closed -- so the
project can tell "nobody joined" from "the counter stopped at the browser". A
room key is stored only as a hash, never as itself: the key is what an invite
link hands out, and a three-month store should not hold live invite codes.

Opt out for good on this browser with **`?metrics=off`**. (Room counting has no
visitor id at all -- it counts rooms, not people -- so it is unaffected.)

Where it goes and how it is read: [docs/metrics.md](docs/metrics.md) (Japanese).

## Known limitations

- Sound is implemented via OpenAL (Web Audio). ATC voice is not implemented
- Japanese UI is supported (system-font rendering via Canvas 2D). The
  language is auto-selected from the browser locale; force with `?lang=ja` /
  `?lang=en`
- No clipboard / IME support
- The simulation runs single-threaded (to avoid blocking the web main
  thread). No native-style parallel simulation

## License

- Upstream YSFLIGHT source code and runtime data: 3-clause BSD
  (`upstream/YSFLIGHT/LICENSE`)
- Upstream `public` libraries: 2-clause BSD as stated in each source file
  header
- Code added by this repository (`src/port`, `web`, `worker`, `scripts`,
  `test`): 2-clause BSD as well

YS FLIGHT SIMULATOR is (c) Soji Yamakawa (CaptainYS, http://www.ysflight.com).
This is an unofficial community port.
