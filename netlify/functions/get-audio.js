const ytdl = require('ytdl-core');
const fetch = require('node-fetch'); // Ensure node-fetch is supported, or use global fetch in Node 18+

exports.handler = async function(event, context) {
    const videoId = event.queryStringParameters.id;

    if (!videoId) {
        return {
            statusCode: 400,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: "Missing video id parameter." })
        };
    }

    try {
        const info = await ytdl.getInfo(videoId);
        
        // Select the best audio-only format
        const audioFormat = ytdl.chooseFormat(info.formats, { 
            quality: 'highestaudio', 
            filter: 'audioonly' 
        });

        if (!audioFormat || !audioFormat.url) {
            throw new Error("No direct audio formats resolved.");
        }

        // Fetch the raw audio stream from Google Video servers on the backend
        const response = await fetch(audioFormat.url);
        if (!response.ok) {
            throw new Error(`Failed to fetch raw stream from YouTube: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Return the raw audio bytes as a base64 payload from your own domain
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "audio/webm", // or audio/mp4 depending on format
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type, Range",
                "Access-Control-Allow-Methods": "GET",
                "Cache-Control": "public, max-age=3600"
            },
            body: buffer.toString('base64'),
            isBase64Encoded: true
        };

    } catch (err) {
        console.error("[Proxy Stream Error]:", err.message);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: "Failed to proxy audio stream.", details: err.message })
        };
    }
};
