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

export const emitter = new EventEmitter();
export let LiveSendState = Object.create(null) // Containing live shared Files metadata with sharing device ID.
export const linkedDevices = new Map(); // Devices linked to each other with one live sharing ohter.

export function getId(req) {
  let data = cookieParser(req.headers.cookie);
  return data.deviceid;
}
export function getName(req) {
  let data = cookieParser(req.headers.cookie);
  return data.devicename;
}

let STREAMS = Object.create(null)  // Passthrouh streams
let liveSendDevices = new Set(); // Devices on which live send page is active

addRoute("/relay-from-server/file-meta-data", async (req, res) => {
  req.setEncoding("utf-8");
  const deviceID = getId(req);
  LiveSendState[deviceID] = Object.create(null);
  LiveSendState[deviceID].name = getName(req)

  linkedDevices.set(deviceID, req.headers["devicetosend"])

  STREAMS[deviceID] = Object.create(null)
  let metaData = "";
  req.on("data", (data) => {
    metaData += data;
  });
  req.on("end", () => {
    metaData = JSON.parse(metaData);
    addLinksRouts(deviceID, metaData);
  });

  res.end();
});

function addLinksRouts(deviceID, metaData) {
  let filesObj = Object.create(null);
  for (let file of metaData) {
    file.name = file["name"].replaceAll(/\/|\\/ig, "_")
    const url = `/relay-from-server/file?name=${encodeURIComponent(file.name)}$device-id=${encodeURIComponent(deviceID)}`;
    const fileKey = file.size + file.name;
    const fileInfo = Object.create(null);
    fileInfo.key = fileKey;
    fileInfo.name = file.name + ` (${calcSize(file.size)})`;
    fileInfo.size = file.size;
    fileInfo.status = "pending";
    fileInfo.link = url;
    fileInfo.downloading = 0

    filesObj[fileKey] = fileInfo;
    STREAMS[deviceID][fileKey] = null;

    addRoute(url, async (req, res) => {
      const file = filesObj[fileKey]
      let stream = STREAMS[deviceID][fileKey]

      if (!stream) {
        stream = await makeDownloadAble(deviceID, fileKey);
        if (stream === "busy") {
          res.end("<html><body><h1>Sharing Device is Busy</h1></body></html>")
          return;
        }
        stream = STREAMS[deviceID][fileKey]
      } 
      const type = memtype(file.name);
      let filename=`${file["name"].slice(0, file["name"].lastIndexOf("("))}`;
      res.writeHead(200, "OK", {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-type": type,
        "content-length": file.size
      });

      stream.pipe(res);
      file.status = "sending";
      file.downloading += 1;
      const receiveID = getId(req);

      emitUpdate("update", deviceID, receiveID, file.key, file.status);

      const sendPercent = setInterval(() => {
        let percent = res.socket.bytesWritten / file.size * 100;
        percent = percent.toFixed(0);
        emitUpdate("update", deviceID, receiveID, file.key, percent)
      }, 800);

      res.on("finish", () => {
        file.status = "completed";
        emitUpdate("update", deviceID, receiveID, file.key, file.status);
        if (file.downloading > 0) file.downloading -= 1;
        if (file.downloading === 0)
          emitter.emit("downloaded", deviceID, file.key);
      });

      res.on("close", () => {
        if (file.status != "completed") {
          file.status = "Canceled";
          if (file.downloading > 0) file.downloading -= 1
          if (file.downloading === 0)
            emitter.emit("downloaded", deviceID, file.key);
          emitUpdate("update", deviceID, receiveID, file.key, file.status);

        }
        clearInterval(sendPercent)
      })
    });
  }
  LiveSendState[deviceID].filesObj = filesObj;
  emitter.emit("newLiveShare", deviceID, LiveSendState[deviceID])
}

async function makeDownloadAble(deviceID, file) {
  return new Promise((resolve, reject) => {
    emitter.emit("makeDownloadAble", deviceID, file);
    function listner(id, filekey) {
      if (id === deviceID && filekey === file) {
        resolve();
        emitter.removeListener("maded", listner)
      }
    }
    setTimeout(() => {
      resolve("busy");
      emitter.removeListener("maded", listner)
    }, 3000);
    emitter.on("maded", listner)
  })
}

addRoute("/relay-from-server/to-send", async (req, res) => {
  const deviceID = getId(req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  function listner(id, file) {
    if (deviceID === id) {
      res.write(`event: tosend\ndata: ${file}\n\n`)
    }
  }
  emitter.on("makeDownloadAble", listner);
  req.on("close", () => {
    emitter.removeListener("makeDownloadAble", listner);
    cleanupRouts(deviceID);
    LiveSendState[deviceID] = null
  })
});
function cleanupRouts(deviceID) {
  if (!LiveSendState[deviceID]) return;
  emitter.emit("update", deviceID)
  const fileInfo = LiveSendState[deviceID]["filesObj"];
  for (let file of Object.values(fileInfo)) {
    removeRouts(file.link);
  }
}
addRoute("/relay-from-server/make", async (req, res) => {
  const { filename, filesize, devicename } = req.headers;
  const deviceID = getId(req);
  const fileKey = filesize + filename

  const stream = new PassThrough()
  res.writeHead(206, "OK", {
    connection: "keep-alive",
  });
  req.pipe(stream);

  STREAMS[deviceID][fileKey] = stream;
  emitter.emit("maded", deviceID, fileKey)
  async function listner(id, key) {
    if (id === deviceID && key === fileKey) {
      req.unpipe(stream);
      stream.destroy()
      res.end("ok");
      req.destroy();
      STREAMS[deviceID][fileKey] = null;
    }
  }
  emitter.on("downloaded", listner);
  req.on("close", () => {
    emitter.removeListener("downloaded", listner)
  })
});

function emitUpdate(event, sendID, receiveID, key, status) {
  emitter.emit(event, sendID, receiveID, key, status)
}

addRoute("/relay-from-server/status", (req, res) => {
  const deviceID = getId(req);
  liveSendDevices.add(deviceID)
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  function listner(sendID, receiveID, key, status) {
    if (sendID === deviceID) {
      res.write(`event: update\ndata: ${JSON.stringify({ [key]: status })}\n\n`);
    }
  }
  emitter.on("update", listner);
  req.on("close", () => {
    emitter.removeListener("update", listner);
    liveSendDevices.delete(deviceID)
  });
});

function calcSize(size) {
  let fileSize = (size / (1024 * 1024)).toFixed(2) + "MB";
  if (size / (1024 * 1024) < 1) fileSize = (size / 1024).toFixed(2) + "KB";
  return fileSize;
}

addRoute('/live-send', async (req, res, isServer) => {
  const deviceID = getId(req);
  if (liveSendDevices.has(deviceID)) {
    res.writeHead(200, 'Ok', {
      'content-type': 'text/html',
      'cache-control': 'no-cache'
    })
    res.end(`
      <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="./public/styles/main_styles.css" />
    <title>Not Allowed</title>
  </head>
  <body>
    <div
      class="flex flex-1 justify-between items-center border-b border-base-300 m-auto"
    >
      <div></div>
      <h1 class="text-xl lg:text-2xl p-2 ml-2 font-bold">
        <a href="/">File Shifter</a>
      </h1>
      <div></div>
    </div>
    <div class="text-center bg-base-300 rounded-2xl font-bold m-4 md:m-16">
      <h2 class="text-xl text-warning p-4">! Live Send Page Already Open</h2>
      <p class=" p-4" >This Page is Already Opened <br> Close this Tab</p>
    </div>
  </body>
</html>

      `)
    return
  }
  res.writeHead(200, 'Ok', {
    'content-type': 'text/html',
    'cache-control': 'no-cache'
  })
  await serverFile(req, res, 'public', 'live-send.html');
  res.end();
})
