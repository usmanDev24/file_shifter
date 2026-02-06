//-------------------------------------------------------------------------------------
//   GNU GENERAL PUBLIC LICENSE  Version 3, 29 June 2007. see Licence file for detail.
//
//                Copyright (c) 2025 Usman Ghani (usmandev24) 
//--------------------------------------------------------------------------------------

let memtype;
const show_files = document.getElementById("show-containers")
const emitter = new EventTarget();
const newFilesUpdates = new EventSource("/shared-files/updates")
const statusUpdate = new EventSource("/shared-files/updates/status")

window.onbeforeunload = () => {
  newFilesUpdates.close();
  statusUpdate.close();
}
let liveContainers = Object.create(null)
window.addEventListener("load", main)
async function main() {
  await getMemtype()
  const Data = await getFileToDownload();
  const liveShared = Data["liveShared"];
  for (let key of Object.keys(liveShared)) {
    if (!liveShared[key]) continue;
    const newContainer = FilesContainer.create(key, liveShared[key], "live");
    liveContainers[key] = newContainer
  }
  newFilesUpdates.addEventListener("newLiveShare", (event) => {
    const data = JSON.parse(event.data);
    for (let key of Object.keys(data)) {
      if (liveContainers[key]) liveContainers[key].remove();
      const container = FilesContainer.create(key, data[key], "live");
      liveContainers[key] = container;
    }
  })
  statusUpdate.addEventListener("liveShareCanceled", (event) => {
    const data = JSON.parse(event.data);
    const toClear = liveContainers[data.id];
    toClear.remove();
  })
}


class FilesContainer {
  constructor(id, obj, method) {
    this.deviceId = id
    this.deviceName = obj["name"]
    this.method = method;
    this.filesObj = obj["filesObj"]
    this.dom = document.createElement("div");
    this.dom.className = "w-full mt-3 p-1 md:p-4 bg-base-100 rounded-lg"
    this.allFileDatas = Object.create(null);
    this.addTitle();
  }
  static create(id, obj, method) {
    const containerObj = new FilesContainer(id, obj, method);
    show_files.appendChild(containerObj.dom);
    containerObj.renderFiles();
    containerObj.attchEvents();
    return containerObj;
  }
  renderFiles() {
    for (let fileKey of Object.keys(this.filesObj)) {
      const file = this.filesObj[fileKey]
      const fileData = new FileData(file.name, file.link, "pending")
      fileData.appendTo(this.dom)
      this.allFileDatas[fileKey] = fileData;
    }
  }
  
  attchEvents() {
    if (this.method === "live") {
      statusUpdate.addEventListener("liveFileUpdate", (event) => {
        const data = JSON.parse(event.data);
        if (data.id === this.deviceId) {
          const filekey = data.filekey
          const fileData = this.allFileDatas[filekey];
          fileData.update(data.status);
          if (data.status === "completed" || data.status === "Canceled") {
            this.onComplete(filekey)
          } else if (Number(data.status) != NaN) {
            this.onDown(filekey)
          }
        }
      })
    } else if (this.method === "bypc") {

    }
  }
  
  addTitle() {
    this.dom.appendChild(el("h2", {
      className: "text-center text-lg p-4"
    }, "🔴 Live Sharing :", el("span", {
      className: "font-bold pl-4 "
    }, this.deviceName)))
  }
  remove() {
    this.dom.remove()
  }
  onDown(filekey) {
    for (let key of Object.keys(this.allFileDatas)) {
      if (key === filekey) continue;
      const file = this.allFileDatas[key];
      file.setPending()
    }
  }
  onComplete(filekey) {
    for (let key of Object.keys(this.allFileDatas)) {
      if (key === filekey) continue;
      const file = this.allFileDatas[key];
      file.setReady()
    }
  }
}


class FileData {
  constructor(fileName, link, status = null) {
    this.name = fileName;
    this.link = link
    this.status = status
    this.ui = createFileUi(fileName, link);
    this.count = 0;
  }
  appendTo(dom) {
    dom.appendChild(this.ui.oneFileSet)
  }
  setPending() {
    const ui = this.ui;
    if (ui.statusText.textContent == "✅") return;
    this.setDisplay(ui.loading, "inline-block");
    this.setDisplay(ui.statusText, "none");
    this.setDisplay(ui.progress, "none");
    this.setDisplay(ui.downBtn, "none");
  }
  setReady() {
    const ui = this.ui;
    if (ui.statusText.textContent == "✅") return;
    this.setDisplay(ui.loading, "none");
    this.setDisplay(ui.statusText, "none");
    this.setDisplay(ui.progress, "none");
    this.setDisplay(ui.downBtn, "inline-block");
  }
  update(status) {
    const ui = this.ui;
    switch (status) {
      case "sending":
        this.setDisplay(ui.loading, "none");
        this.setText(ui.statusText, "sending...");
        this.setDisplay(ui.downBtn, 'none')
        break;
      case "completed":
        this.count += 1;
        this.setDisplay(ui.loading, "none");
        this.setDisplay(ui.progress, "none");
        this.setDisplay(ui.downBtn, "none")
        this.setDisplay(ui.statusText, "inline-block")
        this.setText(ui.statusText, `✅`);
        break;
      case "Canceled":
        this.setDisplay(ui.loading, "none");
        this.setDisplay(ui.progress, "none");
        this.setText(ui.statusText, "⚠️ canceled");
        this.setDisplay(ui.downBtn, "inline-block")
        setTimeout(() => {
          this.setDisplay(ui.statusText, "none")
        }, 1000);
        break;
      default:
        this.setDisplay(ui.loading, "none");
        this.setDisplay(ui.downBtn, "none");
        this.setDisplay(ui.progress, "inline-block");
        this.setDisplay(ui.statusText, "inline")
        ui.progress.style.setProperty("--value", status)
        this.setText(ui.statusText, status+"%")
        
    }
  }
  setDisplay(ele, value) {
    ele.style.display = value;
  }
  setText(ele, text) {
    ele.textContent = text;
  }

}
async function getFileToDownload() {
  const res = await fetch("/shared-files");
  return JSON.parse(await res.text())
}


function createFileUi(fileName, link) {
  //Dom Elements ;
  const oneFileSet = el("div", {
    className:
      "flex flex-col gap-1 shadow shadow-sm dark:shadow-md w-full p-2 mt-3   rounded-lg ",
  });
  const nameRow = el("div", {
    className: "flex w-full justify-between  break-all items-center",
  });
  const nameText = document.createElement("h3");
  nameText.className = "text-[0.85rem] font-bold md:text-[0.95rem]";

  const loading = el("span", {
    className: "hidden loading loading-dots"
  })
  const progress = el("div", {
    className: "radial-progress text-info ",
    ariaValueNow: "70",
    role: "progressbar"
  })
  progress.setAttribute(
    "style",
    "--value:0; --size:1.5rem;"
  );
  progress.style.display = "none"
  const statusText = el("span", {
    className: "w-max  text-[0.8rem] md:text-[1rem]",
  }, "");
  const downBtn = el("a", {
    target : "_blank",
    href: link,
    className: "text-[1.2rem] md:text-[1.4rem]"
  }, "⬇️")

  const loadStatDiv = el("div", {
    className: "ml-auto pl-2 flex justify-between align-center-safe gap-2"
  }, loading, progress, statusText, downBtn)

  nameRow.appendChild(nameText);
  nameRow.appendChild(loadStatDiv);
  
  nameText.textContent = memtype.addEmoji(fileName.slice(0, fileName.lastIndexOf("(")-1)) + fileName;
  oneFileSet.appendChild(nameRow);
  return {
    oneFileSet, nameRow, nameText, loadStatDiv, statusText, loading, progress
    , downBtn
  }
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  children.forEach((c) => {
    if (typeof c === "string") {
      e.appendChild(document.createTextNode(c));
    } else e.appendChild(c);
  });
  return e;

}
async function getMemtype() {
  if (!memtype) {
    memtype = await import('/public/js/memtype.js');
  }
}  

