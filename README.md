# ARY+ Stremio Addon

An unofficial Stremio addon that exposes ARY+ dramas as a Stremio series
catalog. It retrieves catalog and episode data from ARY+, converts artwork into
formats that work reliably in Stremio, and provides two different playback
implementations.

This project is not affiliated with or endorsed by ARY Digital, ARY+, or
Stremio. Use it only where you are permitted to access the underlying content.

## Features

- ARY+ dramas catalog with Stremio pagination support
- Series descriptions, genres, cast, posters, backgrounds, and logos
- Episode lists, numbering, and thumbnails
- Five-minute in-memory caching for episode metadata
- WebP artwork conversion to JPEG or PNG through `sharp`
- Restricted media and image proxies that only accept ARY hosts
- Direct HLS proxy mode or ffmpeg-backed MP4 remux mode

## Implementations

The repository currently contains two standalone versions of the addon. Run
only one of them on a given port.

| File | Playback method | Dependencies | Best suited for |
|---|---|---|---|
| `addon.js` | Proxies the episode's HLS master playlist and rewrites nested playlists, segments, keys, maps, and media URLs | Node.js | Lightweight hosting and external players with HLS support |
| `addon_remux.js` | Splits the HLS master playlist into quality choices, remuxes the selected video/audio into MP4, and caches the result | Node.js and ffmpeg | Stremio's built-in player, seeking, resume, and repeat playback |

### Original HLS version

`addon.js` returns one proxied HLS stream for each episode. The proxy supplies
the headers expected by ARY's CDN and rewrites every media URL back through the
addon. This avoids exposing an unrestricted proxy: only HTTPS URLs on
`aryzap.com` and its subdomains are accepted.

This version uses less local storage and does not require ffmpeg. Direct HLS
playback has been unreliable in the tested Stremio built-in player, although
the same streams work in external players such as mpv.

### MP4 remux and cache version

`addon_remux.js` parses the HLS master playlist and presents one Stremio stream
per available resolution. When a stream is opened, it:

1. Starts an ffmpeg process for that video and optional separate audio track.
2. Copies the existing video and audio codecs without re-encoding.
3. Writes a growing fragmented MP4 so initial playback can start before the
   episode has finished downloading.
4. Keeps the job running if the first client disconnects.
5. Finalizes the completed file as a fast-start MP4 for reliable HTTP range
   requests, seeking, and resume.
6. Reuses the completed MP4 for later requests.

Concurrent requests for the same source share one in-process remux job. Cache
files are named with a SHA-256 hash of the selected video and audio URLs.

The remux is a container conversion, not a transcode. It uses codec copying and
the `aac_adtstoasc` bitstream filter, so it should require substantially less
CPU than video encoding and should not reduce video quality.

## Requirements

- Node.js 18 or newer, because the addon uses the built-in `fetch` API
- npm
- ffmpeg available as `ffmpeg` in `PATH` when running `addon_remux.js`

## Installation

```bash
git clone https://github.com/Sadeeed/aryplus-stremio-plugin.git
cd aryplus-stremio-plugin
npm install
```

For the remux version, install ffmpeg using your operating system's package
manager. For example:

```bash
# Debian or Ubuntu
sudo apt install ffmpeg

# Arch Linux or Manjaro
sudo pacman -S ffmpeg

# macOS with Homebrew
brew install ffmpeg
```

Confirm the required tools are available:

```bash
node --version
ffmpeg -version
```

## Running Locally

Run the original HLS proxy:

```bash
node addon.js
```

Or run the MP4 remux and cache version:

```bash
node addon_remux.js
```

Both versions listen on port `7000` by default and print the manifest URL at
startup:

```text
http://127.0.0.1:7000/manifest.json
```

Open Stremio, go to the addon installation screen, and install that manifest
URL. The local server must remain running while the addon is in use.

## Configuration

Environment variables can be supplied before the start command:

```bash
PORT=8000 \
PUBLIC_BASE_URL=http://192.168.1.20:8000 \
ARY_API_KEY=your_api_key \
node addon.js
```

### Shared variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | HTTP port on which Express listens |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:<PORT>` | Externally reachable origin used to construct image and stream URLs; omit a trailing slash |
| `ARY_API_KEY` | Key currently embedded in the source | Overrides the API key sent to the ARY+ backend |

`PUBLIC_BASE_URL` is especially important for LAN or hosted deployments. It
must be reachable by the device running Stremio and should be an HTTPS URL when
the addon is hosted publicly.

### Remux-only variables

| Variable | Default | Description |
|---|---|---|
| `REMUX_CACHE_DIR` | `<working-directory>/aryplus-remux-cache` | Directory containing growing, finalizing, and completed MP4 files |
| `REMUX_START_BUFFER_BYTES` | `262144` | Preferred number of bytes to buffer before progressive playback begins |
| `REMUX_START_BUFFER_WAIT_MS` | `5000` | Maximum initial wait for the preferred buffer size |
| `REMUX_RANGE_WAIT_MS` | `15000` | Time to wait for a requested range to appear in a growing file |
| `REMUX_POLL_MS` | `200` | Poll interval used while waiting for the growing cache file |

The cache has no size limit, expiration policy, or automatic eviction. Monitor
disk usage and remove old `.mp4` files when necessary. Stop the addon before
manually clearing active `.stream.mp4` or `.finalizing.mp4` files.

## Stremio Resources

The addon implements these Stremio resources:

| Resource | Purpose |
|---|---|
| `catalog` | Lists ARY+ dramas in the `ary-dramas` catalog |
| `meta` | Returns series details and the complete episode list |
| `stream` | Resolves an episode to its HLS proxy or per-quality MP4 streams |

IDs use the following forms:

```text
Series:  ary:<seriesId>
Episode: aryep:<seriesId>:<episodeId>
```

All episodes are currently represented as season 1 because the consumed ARY+
API does not expose a separate season structure.

## Deployment

A hosted addon needs a public HTTPS origin. Set `PUBLIC_BASE_URL` to that exact
origin, then install `https://<your-host>/manifest.json` in Stremio.

Free hosting policies change frequently. Check the linked provider pages before
deploying, and verify that proxying video is permitted by both the provider and
the content service. Video traffic can exhaust free bandwidth much faster than
a typical JSON API.

### Hosting compatibility

| Provider | Free option | Recommended version | Relevant limitations |
|---|---|---|---|
| [Render](https://render.com/docs/free) | Free web service | `addon.js` | Sleeps after 15 idle minutes, uses an ephemeral filesystem, and can suspend unusually high outbound traffic |
| [Northflank](https://northflank.com/pricing) | Sandbox with two free services | `addon.js` | Free resources are limited; verify current compute and network allowances |
| [Oracle Cloud](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) | Always Free compute | `addon_remux.js` | More administration is required, signup normally requires payment-card verification, and free capacity can be unavailable |
| [Google Cloud Run](https://cloud.google.com/run/pricing) | Monthly compute/request allowance | `addon.js` or remux testing | The filesystem is ephemeral and in-memory, free egress is small, and requests have a maximum 60-minute timeout |
| [Railway](https://railway.com/pricing) | Small monthly usage credit | Short-lived testing | ffmpeg, persistent volume, and video egress can consume the credit quickly |

GitHub Pages, Netlify, and other static hosts cannot run this addon. Function
platforms with short request limits are also unsuitable because HLS proxy and
MP4 responses remain open while media is being delivered.

### Render

Render is a straightforward option for the original HLS implementation:

1. Push this repository to GitHub or another Render-supported Git provider.
2. Create a new **Web Service** and select the repository.
3. Choose the Node runtime and free instance type.
4. Use `npm install` as the build command.
5. Use `node addon.js` as the start command.
6. Add `PUBLIC_BASE_URL=https://<service-name>.onrender.com`.
7. Optionally add `ARY_API_KEY` as a secret environment variable.
8. Deploy and verify `https://<service-name>.onrender.com/manifest.json`.

Render assigns `PORT`, which the addon already reads. A free service may take
about a minute to wake after inactivity. Its filesystem is erased when it
restarts, spins down, or redeploys, so it is not appropriate for preserving the
remux cache.

### Northflank

Northflank's free sandbox can run the original implementation as a Node
service:

1. Create a project and a combined service from this Git repository.
2. Use a Node buildpack with `npm install`, or supply an equivalent container.
3. Set the run command to `node addon.js`.
4. Expose the service's HTTP port and generate a public TLS domain.
5. Set `PUBLIC_BASE_URL` to the generated `https://...code.run` URL.
6. Deploy and install the resulting `/manifest.json` URL in Stremio.

Northflank supports Docker builds, which can also package ffmpeg for the remux
version. The repository does not currently include a Dockerfile, and persistent
cache availability depends on the selected plan and volume configuration.

### VM deployment for remuxing

A small Linux VM is the most predictable deployment target for
`addon_remux.js` because it provides control over ffmpeg, disk capacity, request
duration, and cache cleanup. Oracle Cloud's Always Free compute is one possible
option; an existing home server or another VPS works as well.

A typical VM deployment consists of:

1. Install Node.js, npm, ffmpeg, and a reverse proxy such as Caddy or nginx.
2. Clone the repository and run `npm install`.
3. Create a persistent cache directory with enough free space.
4. Run `node addon_remux.js` under systemd or another process supervisor.
5. Reverse proxy a public HTTPS domain to the addon's local port.
6. Set `PUBLIC_BASE_URL` to the HTTPS origin and `REMUX_CACHE_DIR` to the persistent directory.
7. Add disk monitoring and a scheduled cache-retention policy.

Do not expose a production deployment without considering rate limits, maximum
concurrent ffmpeg jobs, bandwidth quotas, disk quotas, and process resource
limits. The current code does not enforce those limits itself.

### Cloud Run caveat

Cloud Run can package the addon and ffmpeg in a container, but it is a poor fit
for persistent remux caching. Its writable filesystem consumes instance memory
and disappears when the instance stops. Requests default to a five-minute
timeout and can be configured up to 60 minutes, which may still interrupt long
episodes. Multiple instances also do not share local cache files.

## Request Flow

```text
Stremio catalog request
  -> addon
  -> ARY+ catalog API
  -> Stremio series metadata

Stremio series request
  -> addon
  -> ARY+ series API + paginated episode API
  -> Stremio metadata and videos

Stremio playback request
  -> episode videoSource
  -> HLS proxy (addon.js)
     or
  -> quality selection -> ffmpeg remux -> progressive/cached MP4
     (addon_remux.js)
```

Artwork follows a separate route through the addon. Only
`images.aryplus.tv` URLs are accepted, then `sharp` converts and resizes the
source for Stremio.

## Known Limitations

- Only the ARY+ `DRAMAS` category for region `PK` is exposed.
- Search is not implemented.
- User authentication and paid-package entitlement checks are not implemented.
- DRM-protected episodes are not supported.
- Subtitles returned by ARY+ are not exposed to Stremio.
- Direct HLS may not play in Stremio's built-in player.
- The image proxy has no request deduplication or persistent image cache.
- In-memory metadata caches are lost whenever the process restarts.
- The remux cache grows until it is cleaned manually.
- The remux implementation has no concurrency or disk-space guardrails.

## Troubleshooting

### The catalog is empty or the server logs an API error

ARY+ may have changed or rotated its web API key. Set `ARY_API_KEY` to the
current value and restart the addon. Also confirm that the server can reach
`be.aryplus.tv` and `images.aryplus.tv`.

### Artwork or streams point to localhost after deployment

Set `PUBLIC_BASE_URL` to the deployment's public HTTPS origin. The addon embeds
this value into every proxied image and media URL returned to Stremio.

### The remux endpoint returns `Remux failed`

Confirm that `ffmpeg -version` works for the same user that runs Node.js, that
the cache directory is writable, and that sufficient disk space is available.

### The first remux playback starts slowly

The first request must fetch media from ARY and build the MP4. Later requests
use the completed cache. `REMUX_START_BUFFER_BYTES` and
`REMUX_START_BUFFER_WAIT_MS` control the initial buffering behavior.

### Seeking does not work during the first playback

Only bytes already written to the growing MP4 can be served during the first
remux. Full byte-range seeking becomes available after the final MP4 has been
created.

## Technical Notes

More detailed notes about the ARY+ endpoints and earlier development findings
are available in [`Doc.md`](Doc.md). That document describes an older iteration
of the remux pipeline; the source files and this README represent the current
behavior.
