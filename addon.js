const express = require("express");
const sharp = require("sharp");

const {
    addonBuilder,
    getRouter
} = require("stremio-addon-sdk");


// =========================================================
// Configuration
// =========================================================

const PORT = Number(process.env.PORT || 7000);

const PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL ||
    `http://127.0.0.1:${PORT}`;

const ARY_API =
    "https://be.aryplus.tv/api";

const ARY_IMAGES =
    "https://images.aryplus.tv";

const ARY_API_KEY =
    process.env.ARY_API_KEY ||
    "ak_37515186786306625012043079404171";

const CACHE_TIME =
    5 * 60 * 1000;


// =========================================================
// Manifest
// =========================================================

const manifest = {
    id: "com.aryplus.stremio",

    // bumped so Stremio notices the update
    version: "0.1.2",

    name: "ARY+",

    description:
        "Watch ARY+ dramas in Stremio",

    resources: [
        "catalog",
        "meta",
        "stream"
    ],

    types: [
        "series"
    ],

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


const builder =
    new addonBuilder(manifest);


// =========================================================
// Image helpers
// =========================================================

function getAryImageUrl(path) {
    if (!path) {
        return null;
    }

    if (
        path.startsWith("http://") ||
        path.startsWith("https://")
    ) {
        return path;
    }

    return (
        `${ARY_IMAGES}/` +
        path.replace(/^\/+/, "")
    );
}


/*
 * Instead of giving Stremio:
 *
 * https://images.aryplus.tv/poster/xyz.webp
 *
 * we give it:
 *
 * http://127.0.0.1:7000/image/poster/<encoded>
 *
 * Our server downloads the WebP and converts it.
 */
function proxyImage(path, kind = "poster") {
    const remote =
        getAryImageUrl(path);

    if (!remote) {
        return undefined;
    }

    const encoded =
        Buffer
            .from(remote)
            .toString("base64url");

    return (
        `${PUBLIC_BASE_URL}` +
        `/image/${kind}/${encoded}`
    );
}


function normalizeGenres(genres) {
    if (!Array.isArray(genres)) {
        return [];
    }

    return genres
        .map(genre => {
            if (
                typeof genre === "string"
            ) {
                return genre;
            }

            return genre?.title;
        })
        .filter(Boolean);
}


// =========================================================
// HLS proxy helpers
// =========================================================

function encodeUrl(url) {
    return Buffer
        .from(url)
        .toString("base64url");
}


function decodeUrl(value) {
    return Buffer
        .from(value, "base64url")
        .toString("utf8");
}


function makeHlsProxyUrl(remoteUrl) {
    return (
        `${PUBLIC_BASE_URL}/hls/` +
        encodeUrl(remoteUrl)
    );
}


function absoluteHlsUrl(value, baseUrl) {
    return new URL(
        value,
        baseUrl
    ).toString();
}


function rewriteM3u8(text, playlistUrl) {
    return text
        .split("\n")
        .map(line => {
            const trimmed =
                line.trim();

            if (!trimmed) {
                return line;
            }

            // Segment URI or nested playlist URI.
            if (!trimmed.startsWith("#")) {
                const absolute =
                    absoluteHlsUrl(
                        trimmed,
                        playlistUrl
                    );

                return makeHlsProxyUrl(
                    absolute
                );
            }

            // Rewrite URI="..." attributes used by HLS tags
            // such as EXT-X-KEY, EXT-X-MAP and EXT-X-MEDIA.
            return line.replace(
                /URI="([^"]+)"/g,
                (_, uri) => {
                    const absolute =
                        absoluteHlsUrl(
                            uri,
                            playlistUrl
                        );

                    return (
                        `URI="${makeHlsProxyUrl(absolute)}"`
                    );
                }
            );
        })
        .join("\n");
}


// =========================================================
// ARY API
// =========================================================

async function aryFetch(path) {
    const url =
        `${ARY_API}${path}`;

    const response =
        await fetch(url, {
            headers: {
                Accept:
                    "application/json",

                "x-api-key":
                    ARY_API_KEY,

                Origin:
                    "https://aryplus.tv",

                Referer:
                    "https://aryplus.tv/"
            }
        });

    if (!response.ok) {
        const body =
            await response.text();

        throw new Error(
            `ARY API ${response.status}: ${body}`
        );
    }

    return response.json();
}


// =========================================================
// Catalog API
// =========================================================

async function getCatalog(
    skip = 0,
    count = 100
) {
    const ARY_PAGE_SIZE = 20;

    const firstPage =
        Math.floor(
            skip / ARY_PAGE_SIZE
        ) + 1;

    const offset =
        skip % ARY_PAGE_SIZE;

    const results = [];

    let page =
        firstPage;

    while (
        results.length <
        count + offset
    ) {
        const data =
            await aryFetch(
                `/series/byCatID/status/pg/DRAMAS/PK` +
                `?limit=${ARY_PAGE_SIZE}` +
                `&page=${page}`
            );

        const shows =
            data.series || [];

        results.push(...shows);

        if (
            shows.length <
            ARY_PAGE_SIZE
        ) {
            break;
        }

        page++;
    }

    return results.slice(
        offset,
        offset + count
    );
}


// =========================================================
// Series
// =========================================================

async function getSeries(seriesId) {
    return aryFetch(
        `/series/` +
        encodeURIComponent(seriesId)
    );
}


// =========================================================
// Episodes
// =========================================================

async function getEpisodes(seriesId) {
    const episodes = [];

    let page = 1;

    while (true) {
        const data =
            await aryFetch(
                `/v2/cdn/pg/` +
                encodeURIComponent(seriesId) +
                `?page=${page}` +
                `&limit=100` +
                `&sort=desc`
            );

        episodes.push(
            ...(data.episode || [])
        );

        if (!data.hasNextPage) {
            break;
        }

        page++;
    }

    episodes.sort(
        (a, b) =>
            Number(
                a.videoEpNumber || 0
            ) -
            Number(
                b.videoEpNumber || 0
            )
    );

    return episodes;
}


// =========================================================
// Episode cache
// =========================================================

const episodeCache =
    new Map();


async function getCachedEpisodes(
    seriesId
) {
    const cached =
        episodeCache.get(seriesId);

    if (
        cached &&
        Date.now() -
            cached.timestamp <
            CACHE_TIME
    ) {
        return cached.episodes;
    }

    const episodes =
        await getEpisodes(seriesId);

    episodeCache.set(
        seriesId,
        {
            timestamp:
                Date.now(),

            episodes
        }
    );

    return episodes;
}


// =========================================================
// Catalog
// =========================================================

builder.defineCatalogHandler(
    async args => {
        if (
            args.type !== "series" ||
            args.id !== "ary-dramas"
        ) {
            return {
                metas: []
            };
        }

        try {
            const skip =
                Math.max(
                    0,
                    Number(
                        args.extra?.skip ||
                        0
                    )
                );

            console.log(
                `[catalog] ARY+ dramas skip=${skip}`
            );

            const shows =
                await getCatalog(
                    skip,
                    100
                );

            const metas =
                shows.map(show => ({
                    id:
                        `ary:${show._id}`,

                    type:
                        "series",

                    name:
                        show.title,

                    /*
                     * These now point to OUR
                     * JPEG conversion endpoint.
                     */
                    poster:
                        proxyImage(
                            show.imagePoster,
                            "poster"
                        ),

                    background:
                        proxyImage(
                            show.imageCoverDesktop ||
                            show.imageCoverBig ||
                            show.imageCoverExtra,

                            "background"
                        ),

                    posterShape:
                        "poster",

                    genres:
                        normalizeGenres(
                            show.genreId
                        ),

                    description:
                        show.episodeCount
                            ? `${show.episodeCount} episodes`
                            : undefined
                }));

            console.log(
                `[catalog] returned ${metas.length} shows`
            );

            return {
                metas,

                cacheMaxAge:
                    60
            };

        } catch (error) {
            console.error(
                "[catalog] error:",
                error
            );

            return {
                metas: []
            };
        }
    }
);


// =========================================================
// Metadata
// =========================================================

builder.defineMetaHandler(
    async args => {
        if (
            args.type !== "series" ||
            !args.id.startsWith("ary:")
        ) {
            return {
                meta: null
            };
        }

        try {
            const seriesId =
                args.id.substring(
                    "ary:".length
                );

            console.log(
                `[meta] ${seriesId}`
            );

            const [
                show,
                episodes
            ] =
                await Promise.all([
                    getSeries(seriesId),
                    getCachedEpisodes(
                        seriesId
                    )
                ]);

            const videos =
                episodes.map(ep => ({
                    id:
                        `aryep:${seriesId}:${ep._id}`,

                    title:
                        ep.title ||
                        `Episode ${ep.videoEpNumber}`,

                    season:
                        1,

                    episode:
                        Number(
                            ep.videoEpNumber
                        ),

                    /*
                     * Episode artwork goes through
                     * thumbnail conversion.
                     */
                    thumbnail:
                        proxyImage(
                            ep.imagePath,
                            "thumbnail"
                        ),

                    available:
                        true
                }));

            return {
                meta: {
                    id:
                        args.id,

                    type:
                        "series",

                    name:
                        show.title,

                    poster:
                        proxyImage(
                            show.imagePoster,
                            "poster"
                        ),

                    background:
                        proxyImage(
                            show.imageCoverDesktop ||
                            show.imageCoverBig ||
                            show.imageCoverExtra,

                            "background"
                        ),

                    logo:
                        proxyImage(
                            show.logo,
                            "logo"
                        ),

                    description:
                        show.description ||
                        "",

                    genres:
                        normalizeGenres(
                            show.genreId
                        ),

                    cast:
                        Array.isArray(
                            show.cast
                        )
                            ? show.cast
                            : [],

                    website:
                        `https://aryplus.tv/title/${seriesId}`,

                    videos
                },

                cacheMaxAge:
                    60
            };

        } catch (error) {
            console.error(
                "[meta] error:",
                error
            );

            return {
                meta: null
            };
        }
    }
);


// =========================================================
// Stream
// =========================================================

builder.defineStreamHandler(
    async args => {
        if (
            args.type !== "series" ||
            !args.id.startsWith(
                "aryep:"
            )
        ) {
            return {
                streams: []
            };
        }

        try {
            const parts =
                args.id.split(":");

            const seriesId =
                parts[1];

            const episodeId =
                parts[2];

            console.log(
                `[stream] series=${seriesId} episode=${episodeId}`
            );

            const episodes =
                await getCachedEpisodes(
                    seriesId
                );

            const episode =
                episodes.find(
                    ep =>
                        ep._id ===
                        episodeId
                );

            if (
                !episode ||
                !episode.videoSource
            ) {
                return {
                    streams: []
                };
            }

            console.log(
                `[stream] source: ${episode.videoSource}`
            );

            console.log(
                `[stream] proxied: ${makeHlsProxyUrl(episode.videoSource)}`
            );

            /*
             * KEEP THIS SIMPLE.
             *
             * This is the response format you
             * already confirmed Stremio displays.
             */
            return {
                streams: [
                    {
                        name:
                            "ARY+",

                        title:
                            episode.title,

                        url:
                            makeHlsProxyUrl(
                                episode.videoSource
                            ),

                        behaviorHints: {
                            notWebReady: true
                        }
                    }
                ]
            };

        } catch (error) {
            console.error(
                "[stream] error:",
                error
            );

            return {
                streams: []
            };
        }
    }
);


// =========================================================
// Express server
// =========================================================

const app =
    express();


// =========================================================
// HLS proxy
// =========================================================

app.get(
    "/hls/:encoded",

    async (req, res) => {
        try {
            const remoteUrl =
                decodeUrl(
                    req.params.encoded
                );

            const parsed =
                new URL(remoteUrl);

            /*
             * Only proxy ARY's VOD CDN.
             * This prevents the endpoint becoming
             * a generic open proxy.
             */
            if (
                parsed.protocol !== "https:" ||
                !(
                    parsed.hostname === "aryzap.com" ||
                    parsed.hostname.endsWith(".aryzap.com")
                )
            ) {
                return res
                    .status(403)
                    .send(
                        "Invalid HLS host"
                    );
            }

            console.log(
                `[hls] ${remoteUrl}`
            );

            const headers = {
                "User-Agent":
                    "Mozilla/5.0",

                Accept:
                    "*/*",

                Referer:
                    "https://aryplus.tv/"
            };

            // Preserve byte-range requests from Stremio.
            if (req.headers.range) {
                headers.Range =
                    req.headers.range;
            }

            const upstream =
                await fetch(
                    remoteUrl,
                    {
                        headers,
                        redirect: "follow"
                    }
                );

            if (!upstream.ok) {
                console.error(
                    `[hls] upstream ${upstream.status}: ${remoteUrl}`
                );

                return res
                    .status(
                        upstream.status
                    )
                    .send(
                        "ARY stream request failed"
                    );
            }

            const contentType =
                upstream.headers.get(
                    "content-type"
                ) || "";

            const pathname =
                parsed.pathname
                    .toLowerCase();

            const isPlaylist =
                pathname.endsWith(
                    ".m3u8"
                ) ||
                contentType
                    .toLowerCase()
                    .includes(
                        "mpegurl"
                    );

            // -----------------------------------------
            // Playlist
            // -----------------------------------------

            if (isPlaylist) {
                const playlist =
                    await upstream.text();

                const rewritten =
                    rewriteM3u8(
                        playlist,
                        remoteUrl
                    );

                res.status(200);

                res.set(
                    "Content-Type",
                    "application/vnd.apple.mpegurl"
                );

                res.set(
                    "Cache-Control",
                    "no-cache"
                );

                res.set(
                    "Access-Control-Allow-Origin",
                    "*"
                );

                res.set(
                    "Cross-Origin-Resource-Policy",
                    "cross-origin"
                );

                return res.send(
                    rewritten
                );
            }


            // -----------------------------------------
            // Segment / key / media resource
            // -----------------------------------------

            res.status(
                upstream.status
            );

            const passHeaders = [
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
                "cache-control"
            ];

            for (const name of passHeaders) {
                const value =
                    upstream.headers.get(
                        name
                    );

                if (value) {
                    res.set(
                        name,
                        value
                    );
                }
            }

            res.set(
                "Access-Control-Allow-Origin",
                "*"
            );

            res.set(
                "Cross-Origin-Resource-Policy",
                "cross-origin"
            );

            const data =
                Buffer.from(
                    await upstream
                        .arrayBuffer()
                );

            return res.send(
                data
            );

        } catch (error) {
            console.error(
                "[hls] proxy error:",
                error
            );

            return res
                .status(502)
                .send(
                    "HLS proxy error"
                );
        }
    }
);


// =========================================================
// Image proxy
// =========================================================

app.get(
    "/image/:kind/:encoded",

    async (req, res) => {
        try {
            const kind =
                req.params.kind;

            const remoteUrl =
                Buffer
                    .from(
                        req.params.encoded,
                        "base64url"
                    )
                    .toString("utf8");

            /*
             * Safety check: only proxy
             * ARY's image host.
             */
            const url =
                new URL(remoteUrl);

            if (
                url.hostname !==
                "images.aryplus.tv"
            ) {
                return res
                    .status(403)
                    .send(
                        "Invalid image host"
                    );
            }

            console.log(
                `[image] ${kind} ${remoteUrl}`
            );

            const response =
                await fetch(
                    remoteUrl,
                    {
                        headers: {
                            Accept:
                                "image/avif,image/webp,image/*,*/*",

                            Referer:
                                "https://aryplus.tv/",

                            "User-Agent":
                                "Mozilla/5.0"
                        }
                    }
                );

            if (!response.ok) {
                console.error(
                    `[image] upstream ${response.status}`
                );

                return res
                    .status(502)
                    .send(
                        "Image fetch failed"
                    );
            }

            const source =
                Buffer.from(
                    await response.arrayBuffer()
                );

            let image =
                sharp(source)
                    .rotate();


            // ---------------------------------------------
            // Poster
            // ---------------------------------------------

            if (kind === "poster") {
                image =
                    image.resize({
                        width: 270,
                        height: 400,

                        fit:
                            "cover",

                        withoutEnlargement:
                            true
                    });

                const output =
                    await image
                        .jpeg({
                            quality: 72,
                            mozjpeg: true
                        })
                        .toBuffer();

                res.set(
                    "Content-Type",
                    "image/jpeg"
                );

                res.set(
                    "Cache-Control",
                    "public, max-age=86400"
                );

                return res.send(
                    output
                );
            }


            // ---------------------------------------------
            // Episode thumbnail
            // ---------------------------------------------

            if (
                kind ===
                "thumbnail"
            ) {
                image =
                    image.resize({
                        width: 240,
                        height: 135,

                        fit:
                            "cover",

                        withoutEnlargement:
                            true
                    });

                const output =
                    await image
                        .jpeg({
                            quality: 50,
                            mozjpeg: true
                        })
                        .toBuffer();

                res.set(
                    "Content-Type",
                    "image/jpeg"
                );

                res.set(
                    "Cache-Control",
                    "public, max-age=86400"
                );

                return res.send(
                    output
                );
            }


            // ---------------------------------------------
            // Background
            // ---------------------------------------------

            if (
                kind ===
                "background"
            ) {
                image =
                    image.resize({
                        width: 1280,

                        withoutEnlargement:
                            true
                    });

                const output =
                    await image
                        .jpeg({
                            quality: 70,
                            mozjpeg: true
                        })
                        .toBuffer();

                res.set(
                    "Content-Type",
                    "image/jpeg"
                );

                res.set(
                    "Cache-Control",
                    "public, max-age=86400"
                );

                return res.send(
                    output
                );
            }


            // ---------------------------------------------
            // Logo
            // ---------------------------------------------

            if (kind === "logo") {
                image =
                    image.resize({
                        width: 500,
                        height: 200,

                        fit:
                            "inside",

                        withoutEnlargement:
                            true
                    });

                const output =
                    await image
                        .png({
                            compressionLevel:
                                9
                        })
                        .toBuffer();

                res.set(
                    "Content-Type",
                    "image/png"
                );

                res.set(
                    "Cache-Control",
                    "public, max-age=86400"
                );

                return res.send(
                    output
                );
            }


            return res
                .status(400)
                .send(
                    "Unknown image type"
                );

        } catch (error) {
            console.error(
                "[image] error:",
                error
            );

            return res
                .status(500)
                .send(
                    "Image proxy error"
                );
        }
    }
);


// =========================================================
// Mount Stremio addon
// =========================================================

app.use(
    getRouter(
        builder.getInterface()
    )
);


// =========================================================
// Start
// =========================================================

app.listen(
    PORT,

    "0.0.0.0",

    () => {
        console.log(
            `ARY+ Stremio addon running on port ${PORT}`
        );

        console.log(
            `Manifest: ${PUBLIC_BASE_URL}/manifest.json`
        );
    }
);