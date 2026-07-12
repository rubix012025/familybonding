const ytdl = require('ytdl-core');

exports.handler = async function(event, context) {
    const videoId = event.queryStringParameters.id;

    if (!videoId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing video id parameter." })
        };
    }

    try {
        const info = await ytdl.getInfo(videoId);
        
        // Isolate the highest quality audio-only format stream
        const audioFormat = ytdl.chooseFormat(info.formats, { 
            quality: 'highestaudio', 
            filter: 'audioonly' 
        });

        if (!audioFormat || !audioFormat.url) {
            throw new Error("No direct audio format URL resolved.");
        }

        // Redirect browser to stream the direct CORS-enabled audio source safely
        return {
            statusCode: 302,
            headers: {
                "Location": audioFormat.url,
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "GET"
            },
            body: ""
        };

    } catch (err) {
        console.error("[Audio Resolver Error]:", err.message);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: "Failed to resolve raw audio stream url.", details: err.message })
        };
    }
};
