//-------------------------------------------------------------------------------------
//   GNU GENERAL PUBLIC LICENSE  Version 3, 29 June 2007. see Licence file for detail.
//
//                Copyright (c) 2025 Usman Ghani (usmandev24)
//--------------------------------------------------------------------------------------
import * as http from "node:http";
import { checkDevice, getIpv4 } from "./model/checkDevice.mjs";
import { routes } from "./routes/addRoute.mjs";
import { handle404 } from "./routes/mainRoutes.mjs";
import qrcode from "qrcode";
import cookieParser from "./model/cookie_parser.mjs";
import { serverFile } from "./model/serveStatic.mjs";
import EventEmitter from "node:events";
import { createFile, varifyDir } from "./model/file-stat.mjs";

export let connectedDevices = new Map();
export const serverEmitter = new EventEmitter();
export const port = 4000;
export const server = http.createServer(async (req, res) => {
  const isServer = checkDevice(req.socket.address().address);

  for (let route of routes) {
    if (req.url === route.url) {
      const identified = await identityCheck(req, res);
      if (identified) {
        addToConnected(req, res);
        await route.handler(req, res, isServer);
      }
      return;
    }
  }
  handle404(req, res);
});
const allowedRouts = [
  "/public/styles/main_styles.css",
  "/set-device-id",
  "/set-device-name",
  "/public/js/v.js",
  "/edit-device-name",
];
function addToConnected(req, res) {
  if (allowedRouts.includes(req.url)) return;
  const cookie = cookieParser(req.headers.cookie);

  if (connectedDevices.has(cookie.deviceid)) {
    let name = connectedDevices.get(cookie.deviceid);
    if (name != cookie.devicename) {
      connectedDevices.set(cookie.deviceid, cookie.devicename);
      serverEmitter.emit("nameChange", cookie.deviceid, cookie.devicename);
    }
  } else {
    connectedDevices.set(cookie.deviceid, cookie.devicename);
  }
  serverEmitter.emit("newDevice", cookie.deviceid, cookie.devicename);
}

async function identityCheck(req, res) {
  if (allowedRouts.includes(req.url)) return true;
  const cookie = cookieParser(req.headers.cookie);
  if (!cookie) {
    /*
      No cookie found, varification.html make fetch req to "/set-device-id"
      see identityRouts.mjs to know what "/set-device-id" does.
    */
    await serverFile(req, res, "public", "varification.html");
    return false;

  } else if (!cookie.devicename) {
    /*
      device-name.html will get name form user and
      make fetch req to "/set-device-name".
    */
    await serverFile(req, res, "public", "device-name.html");
    return false;
  }
  return true;
}

server.listen(port);
server.on("error", (err) => {
  console.log(err);
});
server.on("listening", () => {
  console.log(`------------------------------------------------------------------------
                Welcome to seemless file sharing Web-App.
          Copyright (C) 2025 "USMAN GHANI" https://github.com/usmandev24
-------------------------------------------------------------------------
                                 `);
  if (!getIpv4()) {
    console.log(`
*****    !!!  NO Network connected  ***********`);
    return;
  }

  try {
    qrcode
      .toString(`http://${getIpv4()}:4000`, { small: true, type: "terminal" })
      .then((q) => {
        console.log(`
---> On Both devices Go To http://${getIpv4()}:${port} in browser.
---> OR  Scan QrCode:

${q}`);
      });
    qrcode
      .toString(`http://${getIpv4()}:4000`, { small: true, type: "svg" })
      .then((svg) => {
        varifyDir("public", "images").then((v) => {
          createFile(svg, "public", "images", "qrcode.svg");
        });
      });
  } catch (error) {
    console.error(error);
  }
});

process.on("uncaughtException", (err) => {
  console.error(`Error : ${err}
    Stack: ${err.stack}`);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandeld rejection : " + err);
  console.error("Stack: " + err.stack);
});
