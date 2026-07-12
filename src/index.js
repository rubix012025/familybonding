export default {
  async fetch(request, env, ctx) {
    // Enable CORS for frontend requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Range, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const videoId = url.searchParams.get("id");

    if (!videoId || videoId.length !== 11) {
      return new Response("Invalid or missing YouTube Video ID", { status: 400 });
    }

    const cacheKey = `audio-${videoId}`;

    try {
      // 1. Check R2 Storage Cache first
      const rangeHeader = request.headers.get("Range");
      const r2Options = {};
      if (rangeHeader) {
        r2Options.range = parseRangeHeader(rangeHeader);
      }

      const cachedObject = await env.AUDIO_BUCKET.get(cacheKey, r2Options);

      if (cachedObject) {
        const headers = new Headers({
          "Access-Control-Allow-Origin": "*",
          "Content-Type": cachedObject.httpMetadata?.contentType || "audio/webm",
          "Cache-Control": "public, max-age=31536000",
          "Accept-Ranges": "bytes",
        });

        // Handle partial content header responses if a Range query was sent
        let status = 200;
        if (rangeHeader && cachedObject.range) {
          status = 206;
          headers.set(
            "Content-Range",
            `bytes ${cachedObject.range.offset}-${cachedObject.range.offset + cachedObject.range.length - 1}/${cachedObject.size}`
          );
          headers.set("Content-Length", cachedObject.range.length.toString());
        } else {
          headers.set("Content-Length", cachedObject.size.toString());
        }

        return new Response(cachedObject.body, { status, headers });
      }

      // 2. Cache Miss: Resolve stream URL via YouTube inner Client API
      const directAudioStreamUrl = await fetchYouTubeAudioStream(videoId);

      // Fetch the raw stream from the resolved URL
      const youtubeResponse = await fetch(directAudioStreamUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Range": rangeHeader || "bytes=0-",
        },
      });

      if (!youtubeResponse.ok && youtubeResponse.status !== 206) {
        throw new Error(`YouTube stream request failed with status: ${youtubeResponse.status}`);
      }

      const contentType = youtubeResponse.headers.get("content-type") || "audio/webm";

      // 3. Process Caching and Streaming Simultaneously
      if (!rangeHeader) {
        // If the client requested the full stream, clone it and cache it to R2 in the background
        const [clientStream, cacheStream] = youtubeResponse.body.tee();

        ctx.waitUntil(
          env.AUDIO_BUCKET.put(cacheKey, cacheStream, {
            httpMetadata: { contentType: contentType },
          })
        );

        return new Response(clientStream, {
          status: youtubeResponse.status,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000",
            "Accept-Ranges": "bytes",
          },
        });
      }

      // If client requested a partial Range stream, return it directly without full caching
      return new Response(youtubeResponse.body, {
        status: youtubeResponse.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Content-Range": youtubeResponse.headers.get("content-range") || "",
          "Content-Length": youtubeResponse.headers.get("content-length") || "",
        },
      });

    } catch (err) {
      console.error(`[Error Processing ID ${videoId}]:`, err.message);
      return new Response(JSON.stringify({ error: "Failed to stream audio", details: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};

/**
 * Native, lightweight YouTube API Client scraper.
 * Uses the inner ANDROID client context to retrieve direct audio URLs without signature decipher problems.
 */
async function fetchYouTubeAudioStream(videoId) {
  const payload = {
    videoId: videoId,
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "19.30.34",
        hl: "en",
        gl: "US",
        utcOffsetMinutes: 0,
      },
    },
  };

  const response = await fetch("https://www.youtube.com/youtubei/v1/player", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "com.google.android.youtube/19.30.34 (Linux; U; Android 11)",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`YouTube API handshake returned code ${response.status}`);
  }

  const data = await response.json();
  const formats = data.streamingData?.adaptiveFormats || [];

  // Filter out video tracks, keeping only audio
  const audioFormats = formats.filter(
    (f) => f.mimeType && f.mimeType.startsWith("audio/")
  );

  if (audioFormats.length === 0) {
    throw new Error("No suitable audio-only streams found for this track.");
  }

  // Choose the stream with the highest bitrate
  audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const bestAudio = audioFormats[0];

  if (!bestAudio.url) {
    throw new Error("Selected stream signature decipher mechanism is not supported directly.");
  }

  return bestAudio.url;
}

/**
 * Convert standard browser HTTP Range headers to R2-compliant parameter objects
 */
function parseRangeHeader(rangeHeader) {
  const parts = rangeHeader.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : undefined;

  if (isNaN(start)) return {};
  if (end !== undefined) {
    return { offset: start, length: end - start + 1 };
  }
  return { offset: start };
}
