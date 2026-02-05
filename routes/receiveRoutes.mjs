//-------------------------------------------------------------------------------------
//   GNU GENERAL PUBLIC LICENSE  Version 3, 29 June 2007. see Licence file for detail.
//
//                Copyright (c) 2025 Usman Ghani (usmandev24) 
//--------------------------------------------------------------------------------------

import { addRoute } from "./addRoute.mjs";
import { LiveSendState  } from "./relay-from-server.mjs";
import { emitter as liveEmitter } from "./relay-from-server.mjs";
import { getId, getName, linkedDevices } from "./relay-from-server.mjs";
import { serverFile } from "../model/serveStatic.mjs";

let receivingDevices = new Set()
class State {
  constructor() {
    this.liveShared = LiveSendState;
  }
  init() {

    addRoute("/shared-files", (req, res) => {
      const reqID = getId(req);
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "content-type": "application/json"
      });
      
      let allShared = Object.create(null)
      let liveShared = Object.create(null);
      Object.keys(this.liveShared).forEach(key => {
        if (reqID === linkedDevices.get(key)) liveShared[key] = this.liveShared[key]
      })
      allShared["liveShared"] = liveShared;
      res.end(JSON.stringify(allShared));
    })

    addRoute("/shared-files/updates", (req, res) => {
      const reqID = getId(req)
      receivingDevices.add(reqID)
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "connection": "keep-alive",
        "content-type": "text/event-stream"
      })
      function liveSharelistner(sendId, fileObj) {
        if (reqID != linkedDevices.get(sendId)) return;
        let toSend = Object.create(null);
        toSend[sendId] = fileObj;
        res.write(`event: newLiveShare\ndata: ${JSON.stringify(toSend)}\n\n`)
      }
      liveEmitter.on("newLiveShare", liveSharelistner);
      req.on("close", () => {
        liveEmitter.removeListener("newLiveShare", liveSharelistner)
        receivingDevices.delete(reqID)
      })
    })
    addRoute("/shared-files/updates/status", (req, res) => {
      const deviceID = getId(req);
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "connection": "keep-alive",
        "content-type": "text/event-stream"
      })
      function liveStatuslistner(sendID, receiveID, key, status) {
        if (!key) {
          res.write(`event: liveShareCanceled\ndata: ${JSON.stringify({ id: sendID })}\n\n`);
        }
        else if (receiveID === deviceID) {
          res.write(`event: liveFileUpdate\ndata: ${JSON.stringify({ id: sendID, filekey: key, status: status })}\n\n`);
        }
      }
      liveEmitter.on("update", liveStatuslistner);
      req.on("close", () => {
        liveEmitter.removeListener("update", liveStatuslistner);
      });
    })
  }
  toJson() {
    let allShared = Object.create(null)
    allShared["liveShared"] = this.liveShared;
    return JSON.stringify(allShared)
  }
}
addRoute("/receive", async (req, res, isServer) => {
  const reqID = getId(req)
  if (receivingDevices.has(reqID)) {
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
    
    <div class=" bg-base-300 rounded-2xl font-bold m-4 md:m-16">
      <h2 class="text-xl text-center text-warning p-4">! Recieve Page Already Open</h2>
      <p class=" text-center" >Not Allowed! The Receive Page is Already Opened <br>Close this Tab</p>
    </div>
   
  </body>
</html>

      `)
    return
  }
  res.writeHead(200, "Ok", {
    "content-type": "text/html",
    "cache-control": "no-cache",
  });
  await serverFile(req, res, "public", "receive.html");
  res.end();

});

const receiveHandler = new State();
receiveHandler.init();