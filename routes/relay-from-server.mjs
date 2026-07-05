//-------------------------------------------------------------------------------------
//   GNU GENERAL PUBLIC LICENSE  Version 3, 29 June 2007. see Licence file for detail.
//
//                Copyright (c) 2025 Usman Ghani (usmandev24) 
//--------------------------------------------------------------------------------------

import { addRoute, removeRouts } from "./addRoute.mjs";
import EventEmitter from "node:events";
import { PassThrough } from "node:stream";
import { serverFile } from "../model/serveStatic.mjs";
import cookieParser from "../model/cookie_parser.mjs";
import { memtype } from "../model/memtype.mjs";

// Global Shared State
export const emitter = new EventEmitter();
export const LiveSendState = Object.create(null); 
export const linkedDevices = new Map(); 

// Internal State tracking
const STREAMS = Object.create(null);  
const liveSendDevices = new Set(); 

// Helper: Safely extract device ID from cookies
export function getId(req) {
  const cookies = cookieParser(req.headers.cookie || "");
  return cookies ? cookies.deviceid : undefined;
}

// Helper: Safely extract device name from cookies
export function getName(req) {
  const cookies = cookieParser(req.headers.cookie || "");
  return cookies ? cookies.devicename : undefined;
}

// Helper: Format bytes into human-readable strings
function calcSize(size) {
  const mb = size / (1024 * 1024);
  return mb < 1 ? `${(size / 1024).toFixed(2)}KB` : `${mb.toFixed(2)}MB`;
}

// Helper: Emit events universally
function emitUpdate(event, sendID, receiveID, key, status) {
  emitter.emit(event, sendID, receiveID, key, status);
}

// Route: Receive metadata for files to be shared
addRoute("/relay-from-server/file-meta-data", async (req, res) => {
  req.setEncoding("utf-8");
  const deviceID = getId(req);
  
  if (!deviceID) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Missing Device ID");
  }

  // CRITICAL FIX: Clean up any old routes if this device is resubmitting metadata
  // to avoid dead route leaks in memory.
  cleanupRouts(deviceID);

  LiveSendState[deviceID] = Object.create(null);
  LiveSendState[deviceID].name = getName(req);

  linkedDevices.set(deviceID, req.headers["devicetosend"]);
  STREAMS[deviceID] = Object.create(null);

  let metaData = "";
  req.on("data", (data) => {
    metaData += data;
  });

  req.on("end", () => {
    try {
      const parsedMeta = JSON.parse(metaData);
      addLinksRouts(deviceID, parsedMeta);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid JSON metadata payload");
    }
  });
});

// Logic: Dynamically establish download routes per file
function addLinksRouts(deviceID, metaData) {
  const filesObj = Object.create(null);

  for (const file of metaData) {
    file.name = file.name.replaceAll(/\/|\\/ig, "_");
    
    const url = `/relay-from-server/file?name=${encodeURIComponent(file.name)}&device-id=${encodeURIComponent(deviceID)}`;
    const fileKey = file.size + file.name;
    
    const fileInfo = Object.create(null);
    fileInfo.key = fileKey;
    fileInfo.name = `${file.name} (${calcSize(file.size)})`;
    fileInfo.size = file.size;
    fileInfo.status = "pending";
    fileInfo.link = url;
    fileInfo.downloading = 0;

    filesObj[fileKey] = fileInfo;
    STREAMS[deviceID][fileKey] = null;

    addRoute(url, async (req, res) => {
      const currentFile = filesObj[fileKey];
      
      if (!currentFile) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("File metadata not found.");
      }

      // CRITICAL FIX: Guard against multiple devices downloading the same stream simultaneously.
      // Node.js streams can only be read once; concurrent downloads would corrupt the file data.
      if (currentFile.downloading > 0 || currentFile.status === "sending") {
        res.writeHead(409, { "Content-Type": "text/html" });
        return res.end("<html><body><h1>File is currently being downloaded by another device. Please wait.</h1></body></html>");
      }

      let stream = STREAMS[deviceID]?.[fileKey];

      if (!stream) {
        const availability = await makeDownloadAble(deviceID, fileKey);
        if (availability === "busy") {
          res.writeHead(503, { "Content-Type": "text/html" });
          return res.end("<html><body><h1>Sharing Device is Busy</h1></body></html>");
        }
        stream = STREAMS[deviceID]?.[fileKey];
      }

      if (!stream) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Stream missing or expired.");
      }

      const type = memtype(currentFile.name);
      const openParenIndex = currentFile.name.lastIndexOf("(");
      const filename = openParenIndex !== -1 ? currentFile.name.slice(0, openParenIndex).trim() : currentFile.name;

      res.writeHead(200, {
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Type": type,
        "Content-Length": currentFile.size
      });

      stream.pipe(res);
      currentFile.status = "sending";
      currentFile.downloading += 1;
      const receiveID = getId(req);

      emitUpdate("update", deviceID, receiveID, currentFile.key, currentFile.status);

      const sendPercent = setInterval(() => {
        if (res.socket && !res.socket.destroyed && currentFile.size > 0) {
          const percent = ((res.socket.bytesWritten / currentFile.size) * 100).toFixed(0);
          emitUpdate("update", deviceID, receiveID, currentFile.key, percent);
        }
      }, 800);

      const handleDownloadEnd = (finalStatus) => {
        clearInterval(sendPercent);
        if (currentFile.status !== "completed" && currentFile.status !== "Canceled") {
          currentFile.status = finalStatus;
          emitUpdate("update", deviceID, receiveID, currentFile.key, currentFile.status);
        }
        
        if (currentFile.downloading > 0) currentFile.downloading -= 1;
        if (currentFile.downloading === 0) {
          emitter.emit("downloaded", deviceID, currentFile.key);
        }
      };

      res.on("finish", () => {
        handleDownloadEnd("completed");
      });

      res.on("close", () => {
        if (currentFile.status !== "completed") {
          handleDownloadEnd("Canceled");
        }
      });
    });
  }
  
  LiveSendState[deviceID].filesObj = filesObj;
  emitter.emit("newLiveShare", deviceID, LiveSendState[deviceID]);
}

// Logic: Check/Wait for a device stream to become available
async function makeDownloadAble(deviceID, file) {
  return new Promise((resolve) => {
    emitter.emit("makeDownloadAble", deviceID, file);

    const timeoutId = setTimeout(() => {
      emitter.removeListener("maded", listener);
      resolve("busy");
    }, 3000);

    function listener(id, filekey) {
      if (id === deviceID && filekey === file) {
        clearTimeout(timeoutId);
        emitter.removeListener("maded", listener);
        resolve("ready");
      }
    }

    emitter.on("maded", listener);
  });
}

// Route: Server-Sent Events (SSE) channel telling sender to make stream ready
addRoute("/relay-from-server/to-send", async (req, res) => {
  const deviceID = getId(req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  function listener(id, file) {
    if (deviceID === id) {
      res.write(`event: tosend\ndata: ${file}\n\n`);
    }
  }

  emitter.on("makeDownloadAble", listener);
  
  req.on("close", () => {
    emitter.removeListener("makeDownloadAble", listener);
    cleanupRouts(deviceID);

    // CRITICAL FIX: Destroy all active streams for this device to prevent memory hanging on sudden disconnects
    if (STREAMS[deviceID]) {
      for (const key in STREAMS[deviceID]) {
        if (STREAMS[deviceID][key]) STREAMS[deviceID][key].destroy();
      }
      delete STREAMS[deviceID];
    }

    delete LiveSendState[deviceID];
    linkedDevices.delete(deviceID);
  });
});

// Logic: Cleanup allocated dynamic endpoints
function cleanupRouts(deviceID) {
  if (!LiveSendState[deviceID] || !LiveSendState[deviceID].filesObj) return;
  
  emitter.emit("update", deviceID);
  const fileInfo = LiveSendState[deviceID].filesObj;
  for (const file of Object.values(fileInfo)) {
    removeRouts(file.link);
  }
}

// Route: Accept incoming upload stream from the sender device
addRoute("/relay-from-server/make", async (req, res) => {
  const { filename, filesize } = req.headers;
  const deviceID = getId(req);
  const fileKey = filesize + decodeURIComponent(filename);

  const stream = new PassThrough();
  res.writeHead(200, { "Connection": "keep-alive" }); // Fixed to standard 200 chunked upload status
  req.pipe(stream);

  if (!STREAMS[deviceID]) STREAMS[deviceID] = Object.create(null);
  STREAMS[deviceID][fileKey] = stream;
  
  emitter.emit("maded", deviceID, fileKey);

  let isCleanedUp = false;
  function cleanupStream() {
    if (isCleanedUp) return;
    isCleanedUp = true;

    emitter.removeListener("downloaded", listener);
    req.unpipe(stream);
    stream.destroy();
    if (STREAMS[deviceID]) STREAMS[deviceID][fileKey] = null;
    res.end("ok");
    req.destroy();
  }

  async function listener(id, key) {
    if (id === deviceID && key === fileKey) {
      cleanupStream();
    }
  }

  emitter.on("downloaded", listener);

  // CRITICAL FIX: If the sender cancels or refreshes the page mid-stream, 
  // immediately destroy the stream so the downloader isn't left hanging forever.
  req.on("close", () => {
    cleanupStream();
  });
});

// Route: SSE updates pushing real-time download tracking to recipient UI
addRoute("/relay-from-server/status", (req, res) => {
  const deviceID = getId(req);
  liveSendDevices.add(deviceID);
  
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  function listener(sendID, receiveID, key, status) {
    if (sendID === deviceID) {
      res.write(`event: update\ndata: ${JSON.stringify({ [key]: status })}\n\n`);
    }
  }

  emitter.on("update", listener);
  req.on("close", () => {
    emitter.removeListener("update", listener);
    liveSendDevices.delete(deviceID);
  });
});

// Route: Main UI Page Serving
addRoute('/live-send', async (req, res) => {
  const deviceID = getId(req);
  
  if (liveSendDevices.has(deviceID)) {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache'
    });
    return res.end(`
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" href="./public/styles/main_styles.css" />
          <title>Not Allowed</title>
        </head>
        <body>
          <div class="flex flex-1 justify-between items-center border-b border-base-300 m-auto">
            <h1 class="text-xl lg:text-2xl p-2 ml-2 font-bold"><a href="/">File Shifter</a></h1>
          </div>
          <div class="text-center bg-base-300 rounded-2xl font-bold m-4 md:m-16">
            <h2 class="text-xl text-warning p-4">! Live Send Page Already Open</h2>
            <p class="p-4">This Page is Already Opened <br> Close this Tab</p>
          </div>
        </body>
      </html>
    `);
  }
  
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Cache-Control': 'no-cache'
  });
  await serverFile(req, res, 'public', 'live-send.html');
  res.end();
});