# ARY+ Stremio Addon — Technical Documentation

**Implementation version documented:** 0.1.4  
**Last updated:** 2026-09-20  
**Runtime:** Node.js 18+  
**Primary dependencies:** `stremio-addon-sdk`, `express`, `sharp`, `ffmpeg`

---

## 1. Purpose and Scope

This project exposes ARY+ drama content inside Stremio by mapping ARY+'s public-facing backend APIs and media CDN into Stremio's addon protocol.

The addon currently provides:

- An **ARY+ Dramas catalog** in Stremio.
- Series metadata, including title, description, cast, genres, posters, backgrounds, and logos.
- Episode metadata and episode thumbnails.
- Direct discovery of ARY+ HLS episode streams.
- A **fragmented MP4 remux endpoint** used to improve compatibility with Stremio's built-in player.
- The original HLS stream as a fallback.
- An image proxy that converts ARY+ WebP images into JPEG/PNG formats.
- A generic HLS proxy capable of rewriting playlists, segments, nested playlists, HLS keys, and HLS URI attributes.

The addon does not currently implement:

- User authentication or paid-package entitlement handling.
- DRM playback.
- Search.
- Multiple ARY+ content categories beyond `DRAMAS`.
- Persistent disk caching.
- Seeking/range support for the MP4 remux endpoint.
- Robust image-proxy connection throttling.

---

# 2. ARY+ Service Architecture Discovered

ARY+ uses several separate hosts:

| Purpose | Host |
|---|---|
| Website | `https://aryplus.tv` |
| JSON backend API | `https://be.aryplus.tv` |
| Artwork CDN | `https://images.aryplus.tv` |
| Video HLS CDN | `https://vod.aryzap.com` and other `*.aryzap.com` hosts |
| Ad/VMAP resources | `https://cdn.aryzap.com` |

The browser frontend calls the backend API using an `x-api-key`. The catalog, series metadata, and episode-list endpoints tested during development did **not** require a user `Authorization` header or browser cookie.

The API key observed in the ARY+ web client during development was:

```text
ak_37515186786306625012043079404171
```

The addon allows overriding it with the environment variable:

```bash
ARY_API_KEY=...
```

This is preferable to hard-coding the key for a deployed addon because ARY+ may rotate it.

---

# 3. Required ARY+ Request Headers

The browser's original request contained many normal browser headers, but testing showed that the backend API works with a much smaller set.

The addon currently sends:

```http
Accept: application/json
x-api-key: <ARY_API_KEY>
Origin: https://aryplus.tv
Referer: https://aryplus.tv/
```

Example Node.js implementation:

```js
async function aryFetch(path) {
    const url = `${ARY_API}${path}`;

    const response = await fetch(url, {
        headers: {
            Accept: "application/json",
            "x-api-key": ARY_API_KEY,
            Origin: "https://aryplus.tv",
            Referer: "https://aryplus.tv/"
        }
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`ARY API ${response.status}: ${body}`);
    }

    return response.json();
}
```

---

# 4. ARY+ Catalog API

## Endpoint

```http
GET https://be.aryplus.tv/api/series/byCatID/status/pg/DRAMAS/PK?limit=20&page=1
```

### Meaning of parameters

- `DRAMAS` — category identifier.
- `PK` — country/region code used by the site.
- `limit` — number of records per ARY API page.
- `page` — 1-based page number.

The frontend currently requests 20 records per page.

## Example response structure

```json
{
  "series": [
    {
      "_id": "6a57868b5bf57c474cc00a50",
      "title": "Dar-E-Nijaat",
      "seiresCDN": "https://vod.aryzap.com/.../adp.10.m3u8",
      "imagePoster": "poster/280X400_1784120968010.webp",
      "imageCoverDesktop": "desktop/1920X1080_1784120969405.webp",
      "imageCoverBig": "big/1280X720-1_1784120970451.webp",
      "imageCoverExtra": "extra/1280X720-1_1784120970946.webp",
      "logo": "logo/LOGO_1784120970077.webp",
      "genreId": ["Romance", "Drama", "Family"],
      "seriesType": "show",
      "isLive": false,
      "duration": "00:00:56",
      "packageIds": [],
      "drmEnabled": false,
      "episodeCount": 15,
      "episodeSortOrder": "desc",
      "ageRating": "G"
    }
  ]
}
```

## Important field behavior

### `_id`

This is the stable ARY series identifier.

For Dar-E-Nijaat:

```text
6a57868b5bf57c474cc00a50
```

The addon maps it into Stremio as:

```text
ary:6a57868b5bf57c474cc00a50
```

### `seiresCDN`

Despite the name, this is not the episode stream. In tested series it matches the `trailer` field and is a short trailer/preview.

It must therefore **not** be used as the main show stream.

### Artwork fields

These are relative paths against:

```text
https://images.aryplus.tv/
```

For example:

```text
poster/280X400_1784120968010.webp
```

becomes:

```text
https://images.aryplus.tv/poster/280X400_1784120968010.webp
```

---

# 5. ARY+ Series Metadata API

## Endpoint

```http
GET https://be.aryplus.tv/api/series/{seriesId}
```

Example:

```http
GET https://be.aryplus.tv/api/series/6a57868b5bf57c474cc00a50
```

## Important response fields

```json
{
  "_id": "6a57868b5bf57c474cc00a50",
  "title": "Dar-E-Nijaat",
  "description": "...",
  "cast": [
    "Sheheryar Munawar",
    "Dur-E-Fishan"
  ],
  "imagePoster": "poster/280X400_1784120968010.webp",
  "imageCoverMobile": "mobile/1240X1748_1784120968732.webp",
  "imageCoverDesktop": "desktop/1920X1080_1784120969405.webp",
  "imageCoverBig": "big/1280X720-1_1784120970451.webp",
  "imageCoverExtra": "extra/1280X720-1_1784120970946.webp",
  "logo": "logo/LOGO_1784120970077.webp",
  "genreId": [
    {
      "_id": "64f373fa0b5df297f83569c1",
      "title": "Romance"
    },
    {
      "_id": "64f374825813b7bff6cbd804",
      "title": "Drama"
    }
  ],
  "drmEnabled": false,
  "episodeCount": 15,
  "episodeSortOrder": "desc"
}
```

A key difference from the catalog response is that `genreId` may contain **genre objects** instead of simple strings.

The addon therefore normalizes both formats:

```js
function normalizeGenres(genres) {
    if (!Array.isArray(genres)) return [];

    return genres
        .map(genre => {
            if (typeof genre === "string") return genre;
            return genre?.title;
        })
        .filter(Boolean);
}
```

---

# 6. ARY+ Episode API

## Endpoint

```http
GET https://be.aryplus.tv/api/v2/cdn/pg/{seriesId}?page=1&limit=10&sort=desc
```

Example:

```http
GET https://be.aryplus.tv/api/v2/cdn/pg/6a57868b5bf57c474cc00a50?page=1&limit=10&sort=desc
```

## Example episode object

```json
{
  "_id": "6aaeb19765a92de0f19da7e4",
  "seriesId": "6a57868b5bf57c474cc00a50",
  "videoEpNumber": 15,
  "videoSource": "https://vod.aryzap.com/c9b8f8d2vodtransth1313565080/3d03f3d85001834820515358135/adp.10.m3u8",
  "title": "Episode 15",
  "imagePath": "cdnv1/Screenshot_2026-09-19_201544_1789833621764.webp",
  "videoLength": "2385",
  "videoType": "episode",
  "streamAds": "6aad1103aa141565e4f35a6b",
  "introTimeStamp": 10,
  "subtitles": [],
  "drmEnabled": false,
  "tag": "https://cdn.aryzap.com/drnvmap/drn-vmap-v5.xml"
}
```

Pagination metadata looks like:

```json
{
  "currentPage": 1,
  "limit": 10,
  "totalEpisodes": 15,
  "totalPages": 2,
  "hasNextPage": true,
  "hasPreviousPage": false
}
```

## Important fields

### `_id`

Episode/content ID.

For Episode 15:

```text
6aaeb19765a92de0f19da7e4
```

### `seriesId`

Matches the parent series `_id`.

### `videoEpNumber`

The actual episode number. This is preferable to relying on array position.

### `videoSource`

This is the important field: it is the actual HLS `.m3u8` stream used for playback.

Therefore there is no need for a separate playback resolver API for non-DRM content.

### `imagePath`

Relative image path against `https://images.aryplus.tv/`.

### `drmEnabled`

The tested series returned `false`. The current addon does not attempt to play DRM-protected content.

---

# 7. Relationship Between ARY+ Web URLs and IDs

An ARY+ episode page was observed in this form:

```text
https://aryplus.tv/video/v2/3/6aaeb19765a92de0f19da7e4/6a57868b5bf57c474cc00a50
```

The final two identifiers map to:

```text
6aaeb19765a92de0f19da7e4  -> episode ID
6a57868b5bf57c474cc00a50  -> series ID
```

This matches the episode API response exactly.

---

# 8. Stremio Addon Model

The addon declares three Stremio resource types:

```js
resources: [
    "catalog",
    "meta",
    "stream"
]
```

It currently supports only:

```js
types: ["series"]
```

## ID conventions

### Series

```text
ary:{seriesId}
```

Example:

```text
ary:6a57868b5bf57c474cc00a50
```

### Episodes

```text
aryep:{seriesId}:{episodeId}
```

Example:

```text
aryep:6a57868b5bf57c474cc00a50:6aaeb19765a92de0f19da7e4
```

These IDs make the series ID available to the stream handler without another database lookup.

---

# 9. Manifest

Current manifest:

```js
const manifest = {
    id: "com.aryplus.stremio",
    version: "0.1.4",
    name: "ARY+",
    description: "Watch ARY+ dramas in Stremio",

    resources: ["catalog", "meta", "stream"],
    types: ["series"],

    idPrefixes: [
        "ary:",
        "aryep:"
    ],

    catalogs: [
        {
            type: "series",
            id: "ary-dramas",
            name: "ARY+ Dramas",
            extra: [
                {
                    name: "skip",
                    isRequired: false
                }
            ]
        }
    ]
};
```

The local manifest URL is normally:

```text
http://127.0.0.1:7000/manifest.json
```

---

# 10. Catalog Implementation

## Stremio request

Stremio requests:

```text
/catalog/series/ary-dramas.json
```

and may include `skip` for pagination.

## Pagination translation

ARY+ returns 20 titles per page, whereas the addon attempts to give Stremio up to 100 records per catalog call.

The mapping is:

```js
const ARY_PAGE_SIZE = 20;
const firstPage = Math.floor(skip / ARY_PAGE_SIZE) + 1;
const offset = skip % ARY_PAGE_SIZE;
```

The addon fetches enough ARY pages to satisfy the requested catalog chunk, then slices the combined result.

## Stremio metadata mapping

ARY:

```json
{
  "_id": "6a57868b5bf57c474cc00a50",
  "title": "Dar-E-Nijaat",
  "imagePoster": "poster/...webp",
  "episodeCount": 15
}
```

becomes approximately:

```json
{
  "id": "ary:6a57868b5bf57c474cc00a50",
  "type": "series",
  "name": "Dar-E-Nijaat",
  "poster": "http://127.0.0.1:7000/image/poster/...",
  "posterShape": "poster",
  "genres": ["Romance", "Drama", "Family"],
  "description": "15 episodes"
}
```

---

# 11. Meta Implementation

When Stremio opens a title such as:

```text
ary:6a57868b5bf57c474cc00a50
```

the addon concurrently requests:

```text
/api/series/6a57868b5bf57c474cc00a50
/api/v2/cdn/pg/6a57868b5bf57c474cc00a50?...episodes...
```

The resulting Stremio metadata contains:

- title
- poster
- background
- logo
- description
- genres
- cast
- website URL
- episode list in `videos`

Each episode becomes:

```js
{
    id: `aryep:${seriesId}:${ep._id}`,
    title: ep.title,
    season: 1,
    episode: Number(ep.videoEpNumber),
    thumbnail: proxyImage(ep.imagePath, "thumbnail"),
    available: true
}
```

All ARY dramas are currently represented as Stremio season 1 because no independent season structure has yet been observed in the tested API.

---

# 12. Episode Caching

Episode lists are cached in memory for five minutes:

```js
const CACHE_TIME = 5 * 60 * 1000;
const episodeCache = new Map();
```

This is useful because both the metadata and stream handlers need the same episode list.

Without caching, opening an episode after opening a show would immediately call ARY's episode API again.

Cache structure:

```js
{
    timestamp: Date.now(),
    episodes: [...]
}
```

This cache is process-local and disappears when Node.js restarts.

---

# 13. Direct HLS Playback Discovery

The episode API already returns:

```json
"videoSource": "https://vod.aryzap.com/.../adp.10.m3u8"
```

Testing showed that this URL plays directly in `mpv`:

```bash
mpv 'https://vod.aryzap.com/.../adp.10.m3u8'
```

However, Stremio's built-in player did not successfully play the same direct HLS stream, even though selecting **Play in MPV** from Stremio worked.

This established that:

1. ARY stream discovery was correct.
2. The stream itself was valid.
3. The compatibility problem was specific to Stremio's internal playback path.

---

# 14. HLS Proxy

An HLS proxy was added to remove possible CORS/header problems and normalize all HLS requests through the addon.

## Local URL format

```text
http://127.0.0.1:7000/hls/{base64url_encoded_remote_url}
```

The original ARY URL is encoded with:

```js
Buffer.from(url).toString("base64url")
```

## Playlist rewriting

The proxy rewrites:

- segment URLs
- nested `.m3u8` playlists
- `EXT-X-KEY URI="..."`
- `EXT-X-MAP URI="..."`
- `EXT-X-MEDIA URI="..."`
- other HLS tags containing a `URI="..."` attribute

Relative URLs are first resolved against the source playlist URL:

```js
new URL(value, playlistUrl).toString()
```

Then they are replaced with local `/hls/...` proxy URLs.

## Security restriction

The proxy only accepts HTTPS hosts matching:

```text
aryzap.com
*.aryzap.com
```

This prevents the route from becoming a general-purpose open HTTP proxy.

## Result

The HLS proxy itself worked, but Stremio still reported the video as unsupported. This showed the problem was deeper than CORS or Referer headers.

---

# 15. Fragmented MP4 Remux

The successful compatibility solution was to remux the HLS media into a fragmented MP4 stream using ffmpeg.

## Local URL format

```text
http://127.0.0.1:7000/remux/{base64url_encoded_hls_url}.mp4
```

## Why remux instead of transcode

Remuxing changes the **container**, not the encoded picture/audio.

Current ffmpeg settings use:

```text
-c:v copy
-c:a copy
```

Therefore:

- no video quality is intentionally lost
- no expensive video encoding is performed
- CPU usage should be comparatively low
- playback can begin without creating a complete file first

---

# 16. AAC ADTS to MP4 Fix

The first remux attempt failed with:

```text
Malformed AAC bitstream detected: use the audio bitstream filter
'aac_adtstoasc' to fix it
```

ARY's HLS AAC is carried using ADTS framing. MP4 expects MPEG-4 `AudioSpecificConfig` instead.

The fix was:

```text
-bsf:a aac_adtstoasc
```

This is a **bitstream format conversion**, not an audio re-encode.

Current relevant ffmpeg options:

```text
-c:v copy
-c:a copy
-bsf:a aac_adtstoasc
```

---

# 17. Fragmented MP4 Settings

The remux is streamed directly through stdout:

```text
-f mp4 pipe:1
```

The following flags make the MP4 playable before the complete output exists:

```text
-movflags frag_keyframe+empty_moov+default_base_moof
```

Additional timing options:

```text
-fflags +genpts
-avoid_negative_ts make_zero
```

Reconnect behavior:

```text
-reconnect 1
-reconnect_streamed 1
-reconnect_delay_max 2
```

ARY request headers are supplied to ffmpeg:

```text
Referer: https://aryplus.tv/
User-Agent: Mozilla/5.0
```

---

# 18. Video Quality Issue and Best-Quality Selection

An earlier remux version explicitly selected:

```text
-map 0:v:0
-map 0:a:0?
```

This produced visibly poor quality.

The reason is that `adp.10.m3u8` is an adaptive HLS source and the first discovered video stream may correspond to a low-resolution rendition.

The current implementation removes those explicit `-map` options.

Without explicit mapping, ffmpeg automatically selects its preferred video/audio streams; for video, this normally results in the highest-resolution available video stream.

Current selection section:

```text
-i <remote m3u8>
-sn
-dn
-c:v copy
-c:a copy
```

Subtitles and data streams are excluded with:

```text
-sn
-dn
```

---

# 19. Current Stream Handler

For each episode the addon currently returns two choices:

## Primary

```text
ARY+ MP4
```

URL:

```text
/remux/<encoded>.mp4
```

This is intended for Stremio's built-in player.

## Fallback

```text
ARY+ HLS
```

URL:

```text
https://vod.aryzap.com/.../adp.10.m3u8
```

with:

```js
behaviorHints: {
    notWebReady: true
}
```

The direct HLS option is particularly useful with external players such as mpv.

---

# 20. Remux Process Lifecycle

A separate ffmpeg process is spawned for each active MP4 playback request.

```js
ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"]
});
```

ffmpeg stdout is piped directly to the HTTP client:

```js
ffmpeg.stdout.pipe(res);
```

If the Stremio client disconnects, the addon kills the process:

```js
ffmpeg.kill("SIGKILL");
```

This prevents abandoned playback sessions from leaving ffmpeg processes running indefinitely.

## Current limitation: seeking

The endpoint deliberately does not advertise `Accept-Ranges`.

The remux is currently a sequential live HTTP response. Seeking within an already-playing episode may therefore be limited or unreliable.

Proper seeking would require a more advanced design, such as:

- starting ffmpeg at a requested timestamp
- handling HTTP `Range` semantics with a real cached MP4 file
- caching remuxed output to disk
- using another streaming architecture that supports random access

---

# 21. Image CDN and Image Proxy

ARY artwork is served from:

```text
https://images.aryplus.tv/
```

Examples:

```text
https://images.aryplus.tv/poster/280X400_1784120968010.webp
https://images.aryplus.tv/cdnv1/Screenshot_2026-09-19_201544_1789833621764.webp
```

Direct WebP artwork did not render reliably in the Stremio setup being tested, so the addon provides an image conversion proxy.

## Local image URL format

```text
http://127.0.0.1:7000/image/{kind}/{base64url_encoded_remote_url}
```

Supported kinds:

- `poster`
- `thumbnail`
- `background`
- `logo`

## Conversion behavior

### Poster

```text
270 x 400
JPEG quality 72
```

### Episode thumbnail

```text
240 x 135
JPEG quality 50
```

### Background

```text
1280px width maximum
JPEG quality 70
```

### Logo

```text
500 x 200 maximum
PNG
```

The proxy only accepts:

```text
images.aryplus.tv
```

so it cannot be used as an arbitrary image proxy.

---

# 22. Known Image Proxy Problem

Opening a series causes Stremio to request many assets at once:

- background
- logo
- all visible episode thumbnails

This resulted in multiple simultaneous connections to `images.aryplus.tv`, and Node's fetch/Undici reported connection timeouts such as:

```text
UND_ERR_CONNECT_TIMEOUT
```

The image proxy is therefore currently considered functional but not robust.

Possible future improvements:

1. Limit upstream image concurrency to 2-4 requests.
2. Cache converted images in RAM.
3. Cache converted images on disk.
4. Deduplicate simultaneous requests for the same source image.
5. Retry failed CDN requests with backoff.
6. Remove unnecessary backgrounds from catalog results and only request them on the meta page.

This issue has been intentionally parked because video playback is the higher-priority part of the project.

---

# 23. Express Application Layout

The project uses Express rather than only `serveHTTP()` because custom endpoints are needed alongside Stremio's built-in routes.

Routes include:

```text
/image/:kind/:encoded
/hls/:encoded
/remux/:encoded.mp4
```

The Stremio SDK router is mounted afterward:

```js
app.use(
    getRouter(
        builder.getInterface()
    )
);
```

This provides normal Stremio endpoints such as:

```text
/manifest.json
/catalog/series/ary-dramas.json
/meta/series/ary:<seriesId>.json
/stream/series/aryep:<seriesId>:<episodeId>.json
```

---

# 24. Runtime Configuration

## Port

Default:

```text
7000
```

Override:

```bash
PORT=8000 node addon.js
```

## Public base URL

Default:

```text
http://127.0.0.1:<PORT>
```

Override for LAN/server deployment:

```bash
PUBLIC_BASE_URL=https://example.com node addon.js
```

This value is critical because image, HLS, and remux URLs returned to Stremio are generated from it.

## API key

Override:

```bash
ARY_API_KEY=... node addon.js
```

---

# 25. Dependencies

Install Node dependencies:

```bash
npm install stremio-addon-sdk express sharp
```

Install ffmpeg separately.

On Manjaro/Arch:

```bash
sudo pacman -S ffmpeg
```

The addon expects the executable to be available simply as:

```text
ffmpeg
```

in the process `PATH`.

---

# 26. End-to-End Request Flow

## Catalog

```text
Stremio
  -> /catalog/series/ary-dramas.json
  -> addon getCatalog()
  -> be.aryplus.tv/api/series/byCatID/status/pg/DRAMAS/PK
  -> convert ARY objects into Stremio metas
  -> return catalog
```

## Series page

```text
Stremio
  -> /meta/series/ary:<seriesId>.json
  -> /api/series/<seriesId>
  +  /api/v2/cdn/pg/<seriesId>
  -> build series metadata + videos[]
  -> return Stremio meta
```

## Playback

```text
Stremio
  -> /stream/series/aryep:<seriesId>:<episodeId>.json
  -> cached/fetched episode list
  -> find matching episode
  -> read episode.videoSource
```

Then Stremio is offered:

```text
ARY+ MP4 -> /remux/<encoded>.mp4
ARY+ HLS -> original ARY .m3u8
```

For the MP4 option:

```text
Stremio
  -> addon /remux/...
  -> ffmpeg opens ARY HLS
  -> selects best video/audio stream
  -> copies video codec
  -> copies AAC audio + aac_adtstoasc
  -> outputs fragmented MP4 to stdout
  -> Express sends MP4 stream to Stremio
```

---

# 27. Example: Dar-E-Nijaat Episode 15

## Series

```text
Title: Dar-E-Nijaat
Series ID: 6a57868b5bf57c474cc00a50
```

## Episode

```text
Episode: 15
Episode ID: 6aaeb19765a92de0f19da7e4
```

## ARY direct source

```text
https://vod.aryzap.com/c9b8f8d2vodtransth1313565080/3d03f3d85001834820515358135/adp.10.m3u8
```

## Stremio series ID

```text
ary:6a57868b5bf57c474cc00a50
```

## Stremio episode ID

```text
aryep:6a57868b5bf57c474cc00a50:6aaeb19765a92de0f19da7e4
```

## Local remux URL form

```text
http://127.0.0.1:7000/remux/<base64url-of-videoSource>.mp4
```

---

# 28. Logging and Diagnostics

The addon emits useful logs at each stage.

## Catalog

```text
[catalog] ARY+ dramas skip=0
[catalog] returned 100 shows
```

## Metadata

```text
[meta] 6a57868b5bf57c474cc00a50
```

## Stream resolution

```text
[stream] series=... episode=...
[stream] source: https://vod.aryzap.com/...m3u8
[stream] remux: http://127.0.0.1:7000/remux/...mp4
[stream] hls fallback: https://vod.aryzap.com/...m3u8
```

## Remux

```text
[remux] https://vod.aryzap.com/...m3u8
```

ffmpeg warnings are prefixed:

```text
[ffmpeg] ...
```

On disconnect:

```text
[remux] client disconnected; stopping ffmpeg
```

## Images

```text
[image] poster https://images.aryplus.tv/...
[image] thumbnail https://images.aryplus.tv/...
```

---

# 29. Important Failure Modes Observed

## API returns 401

Cause:

```text
x-api-key missing or invalid
```

Fix:

Supply the current ARY+ web API key.

---

## Stream appears in Stremio but built-in playback fails

Observed with direct `.m3u8` streams.

External MPV playback worked.

Current solution:

Use the local fragmented-MP4 remux endpoint.

---

## ffmpeg reports malformed AAC bitstream

Error:

```text
Malformed AAC bitstream detected
```

Cause:

AAC is ADTS-framed in HLS but is being copied into MP4.

Fix:

```text
-bsf:a aac_adtstoasc
```

---

## MP4 plays but quality is poor

Cause:

Explicit mapping to:

```text
-map 0:v:0
```

selected the first, potentially low-resolution adaptive HLS rendition.

Fix:

Remove explicit video/audio maps and allow ffmpeg to select the preferred highest-resolution video stream.

---

## Artwork intermittently times out

Cause:

Burst of parallel image-proxy requests to ARY's image CDN.

Current status:

Known issue, not yet fully solved.

---

# 30. Security Considerations

Several measures are already present:

## HLS/remux host validation

Only ARY video CDN hosts are accepted:

```text
aryzap.com
*.aryzap.com
```

## Image host validation

Only:

```text
images.aryplus.tv
```

is accepted.

This prevents the addon from becoming a generic server-side request proxy.

## Remaining concerns

For public deployment, additional safeguards should be considered:

- Rate limiting.
- Maximum concurrent ffmpeg sessions.
- Request timeouts.
- Authentication or private deployment if appropriate.
- Resource limits for ffmpeg child processes.
- More restrictive accepted URI schemes and ports.
- Avoid exposing the ARY API key unnecessarily in public source if it becomes a sensitive credential.

---

# 31. Recommended Next Improvements

## High priority

### 1. Validate final quality selection

Use `ffprobe` against an ARY adaptive playlist and inspect available resolutions/bitrates. If ffmpeg automatic selection is still inconsistent, explicitly select the highest-bandwidth program/variant.

### 2. Add remux concurrency limits

A public or multi-device deployment could otherwise start many ffmpeg processes simultaneously.

### 3. Improve image caching

Cache converted images to disk or RAM and deduplicate concurrent requests.

### 4. Detect DRM

If either series or episode returns:

```json
"drmEnabled": true
```

the addon should avoid exposing a stream it cannot play and optionally label it as unsupported.

## Medium priority

### 5. Add search

Map Stremio catalog `search` extra arguments either to an ARY search endpoint or to locally filtered catalog results.

### 6. Add more categories

The catalog endpoint suggests other category IDs can potentially be substituted for `DRAMAS`.

### 7. Improve metadata

Potential additions:

- release date
- age rating
- runtime
- intro skip timestamp
- subtitle tracks
- richer episode metadata

### 8. Persist cache

A disk-backed cache would prevent repeated metadata/image work after process restarts.

---

# 32. Current Architecture Summary

```text
                         +----------------------+
                         |       Stremio        |
                         +----------+-----------+
                                    |
                 +------------------+------------------+
                 |                  |                  |
                 v                  v                  v
             Catalog              Meta               Stream
                 |                  |                  |
                 v                  v                  v
        ARY catalog API     ARY series API     cached episode list
                            + episode API               |
                 |                  |                  v
                 |                  |            episode.videoSource
                 |                  |                  |
                 |                  |        +---------+---------+
                 |                  |        |                   |
                 |                  |        v                   v
                 |                  |   MP4 remux          Direct HLS
                 |                  |   (ffmpeg)             fallback
                 |                  |        |
                 |                  |        v
                 |                  | fragmented MP4
                 |                  |
                 +---------+--------+
                           |
                           v
                     Image proxy
                           |
                           v
                   images.aryplus.tv
```

---

# 33. Current Status

At the time of this documentation:

- ARY catalog discovery works.
- Series metadata works.
- Episode discovery works.
- Direct `.m3u8` stream extraction works.
- Direct streams play correctly in MPV.
- Stremio can display the addon stream entries.
- Direct HLS playback inside Stremio's built-in player is unreliable/unsupported in the tested setup.
- Fragmented MP4 remux playback works.
- AAC-in-MP4 compatibility is fixed with `aac_adtstoasc`.
- Quality selection has been changed to avoid forcing the first HLS rendition.
- Artwork conversion works, but the image proxy can suffer upstream connection timeouts during large bursts.

The core content discovery and playback pipeline is therefore functional, with image reliability and playback ergonomics/quality tuning remaining as the main areas for refinement.

