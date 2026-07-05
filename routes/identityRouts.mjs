//-------------------------------------------------------------------------------------
//   GNU GENERAL PUBLIC LICENSE  Version 3, 29 June 2007. see Licence file for detail.
//
//                Copyright (c) 2025 Usman Ghani (usmandev24)
//--------------------------------------------------------------------------------------

import { addRoute } from "./addRoute.mjs";
import cookieParser from "../model/cookie_parser.mjs";
import { varifyFile, varifyDir } from "../model/file-stat.mjs";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crpto from "node:crypto";

// this fuction create a Id using req header data not perfect way. I will change it
export function createHeaderId(req) {
  const ua = req.headers["user-agent"] || "";
  const accept = req.headers["accept"] || "";
  const acceptLang = req.headers["accept-language"] || "";
  const acceptEnc = req.headers["accept-encoding"] || "";
  const secChUa = req.headers["sec-ch-ua"] || "";
  const secChUaMobile = req.headers["sec-ch-ua-mobile"] || "";
  const secChUaPlatform = req.headers["sec-ch-ua-platform"] || "";

  const components = [
    ua,
    secChUa,
    secChUaPlatform,
    secChUaMobile,
    accept,
    acceptLang,
    acceptEnc,
  ].join("|");

  const hash = crpto.createHash("sha256").update(components).digest("hex");

  return hash;
}

addRoute("/set-device-id", async (req, res) => {
  await varifyDir("appData");
  await varifyFile("appData", "devicesData.json");

  const filePath = path.join("appData", "devicesData.json");
  const readed = await fs.readFile(filePath, "utf-8");
  let devicesData = readed ? JSON.parse(readed) : Object.create(null);

  const hid = createHeaderId(req);
  const existingId = Object.keys(devicesData).find((id) => id === hid);


  if (existingId) {
    let deviceName = devicesData[hid]?.name || "Unknown";
    const openParenIndex = deviceName.indexOf("(");
    if (openParenIndex !== -1) {
      deviceName = deviceName.slice(0, openParenIndex).trim();
    }
    deviceName = `${deviceName}(${crpto.randomInt(1000, 9000)})`;

    // 2. FIX: Use appendHeader sequentially to guarantee isolated header lines.
    res.appendHeader(
      "Set-Cookie",
      `deviceid=${encodeURIComponent(hid)}; SameSite=Lax; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 365}`,
    );
    res.appendHeader(
      "Set-Cookie",
      `devicename=${encodeURIComponent(deviceName)}; SameSite=Lax; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 365}`,
    );

    res.end(JSON.stringify({ status: "ok", name: deviceName }));
  } else {
    // 3. FIX: Standardize with appendHeader for structural uniformity across the lifecycle
    res.appendHeader(
      "Set-Cookie",
      `deviceid=${encodeURIComponent(hid)}; SameSite=Lax; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 365}`,
    );

    res.end(JSON.stringify({ status: "new" }));
  }
});

addRoute("/set-device-name", async (req, res) => {
  await varifyDir("appData");
  await varifyFile("appData", "devicesData.json");

  const reqDeviceName = req.headers.devicename;
  const cookie = cookieParser(req.headers.cookie);

  const filePath = path.join("appData", "devicesData.json");
  const readed = await fs.readFile(filePath, "utf-8");
  let devicesData = readed ? JSON.parse(readed) : Object.create(null);

  devicesData[cookie.deviceid] = { name: reqDeviceName };
  res.setHeader(
    "set-cookie",
    `devicename=${reqDeviceName}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 365}`,
  );
  await fs.writeFile(filePath, JSON.stringify(devicesData), "utf-8");
  res.end("done");
});

addRoute("/clear-cookie", (req, res) => {
  res.setHeader("set-cookie", [
    `deviceid=; httponly; path=/; max-age=0`,
    "devicename=; httponly; path=/; max-age=0",
  ]);
  res.end("DONE CLeard");
});
