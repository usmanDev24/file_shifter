/**
 * UI & DOM Registry
 * Consolidating references prevents "spaghetti" lookups throughout the logic.
 */
const DOM = {
  fileInput: document.getElementById("file-input"),
  showFiles: document.getElementById("show-files"),
  deviceSelect: document.getElementById("select"),
  selectSkeleton: document.getElementById("select-skeleton"),
  cancelBtn: document.getElementById("cancel-btn"),
};

// Global State
let memtypeModule;
let targetDeviceId;
const connectedDevices = new EventSource("/connected-devices");

/**
 * Utilities: Logic extracted for DRY (Don't Repeat Yourself)
 */
const utils = {
  cleanFileName: (name) => name.replaceAll(/\/|\\/ig, "_"),
  
  formatSize: (bytes) => {
    const mb = bytes / (1024 * 1024);
    return mb < 1 
      ? `${(bytes / 1024).toFixed(2)}KB` 
      : `${mb.toFixed(2)}MB`;
  },

  createEl: (tag, props = {}, ...children) => {
    const element = document.createElement(tag);
    // BUG FIX: Separate 'style' from plain properties because Object.assign() 
    // cannot write a plain string directly to element.style in modern DOM APIs.
    const { style, ...otherProps } = props;
    Object.assign(element, otherProps);
    
    if (style) {
      element.style.cssText = style;
    }

    children.forEach(child => {
      if (child) {
        element.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
    });
    return element;
  }
};

/**
 * Initialization Logic
 */
window.onload = init;
DOM.fileInput.onchange = handleLiveShare;

async function init() {
  await loadMemtype();
  const optionsMap = new Map();

  // Pattern: Observer - Handling device updates
  const updateDeviceList = (event) => {
    try {
      const data = JSON.parse(event.data);
      Object.entries(data).forEach(([id, name]) => {
        if (optionsMap.has(id)) {
          optionsMap.get(id).textContent = name;
        } else {
          const option = utils.createEl("option", { value: id, textContent: name });
          optionsMap.set(id, option);
          if (DOM.selectSkeleton) {
            DOM.selectSkeleton.before(option);
          }
        }
      });
    } catch (err) {
      console.error("Failed to parse device list update:", err);
    }
  };

  connectedDevices.addEventListener("devices", updateDeviceList);
  connectedDevices.addEventListener("newDevice", updateDeviceList);

  DOM.deviceSelect.onchange = () => {
    const selected = Array.from(DOM.deviceSelect.options).find(opt => opt.selected);
    if (selected && selected.value) {
      targetDeviceId = selected.value;
      DOM.fileInput.disabled = false;
    }
  };
}

async function loadMemtype() {
  if (!memtypeModule) {
    try {
      memtypeModule = await import('/public/js/memtype.js');
    } catch (err) {
      console.error("Critical error loading memtype module:", err);
    }
  }
}

/**
 * Orchestrator Class
 * Manages the file transfer lifecycle.
 */
class ShareController {
  constructor(fileInput, deviceName, recipientId) {
    this.files = Array.from(fileInput.files);
    this.deviceName = deviceName;
    this.recipientId = recipientId;
    this.statusSource = new EventSource("/relay-from-server/status");
    this.queueSource = new EventSource("/relay-from-server/to-send");
    
    this.fileRegistry = {};
    this.activeTransferCount = 0;
    this.metadataQueue = [];
  }

  async start() {
    this.files.forEach(file => {
      const cleanName = utils.cleanFileName(file.name);
      const registryKey = file.size + cleanName;
      
      const fileInstance = new FileTransfer(file);
      this.fileRegistry[registryKey] = fileInstance;
      this.metadataQueue.push({ name: cleanName, size: file.size });
    });

    this.setupListeners();
    await this.transmitMetadata();
  }

  setupListeners() {
    this.queueSource.addEventListener("tosend", async (event) => {
      // Constraint: Limit concurrent uploads to prevent network congestion
      if (this.activeTransferCount >= 2) return;

      const fileKey = event.data;
      if (!this.fileRegistry[fileKey]) return;

      try {
        this.activeTransferCount++;
        await this.fileRegistry[fileKey].upload();
      } catch (error) {
        console.error(`Error transferring file ${fileKey}:`, error);
      } finally {
        // BUG FIX: Wrapped in try...finally to guarantee the counter decrements 
        // even if the HTTP connection drops or throws an unexpected exception.
        this.activeTransferCount = Math.max(0, this.activeTransferCount - 1);
      }
    });

    this.statusSource.addEventListener("update", (event) => {
      try {
        const data = JSON.parse(event.data);
        const key = Object.keys(data)[0];
        if (this.fileRegistry[key]) {
          this.fileRegistry[key].updateUI(data[key]);
        }
      } catch (err) {
        console.error("Failed processing status update:", err);
      }
    });
  }

  async transmitMetadata() {
    try {
      const response = await fetch("/relay-from-server/file-meta-data", {
        method: "POST",
        body: JSON.stringify(this.metadataQueue),
        headers: { 
          "Content-Type": "application/json",
          "devicetosend": this.recipientId 
        }
      });
      return await response.text();
    } catch (err) {
      console.error("Failed transmitting metadata:", err);
    }
  }

  terminate() {
    if (confirm("Do you want to cancel Live Sending?")) {
      this.statusSource.close();
      this.queueSource.close();
      
      // Clean up UI visibility state
      DOM.showFiles.style.display = "none";
      DOM.cancelBtn.style.display = "none";
      DOM.fileInput.disabled = false;
      DOM.deviceSelect.disabled = false;
      
      // Reload page context to cleanly re-establish SSE listeners if desired
      window.location.reload();
    }
  }
}

/**
 * File Entity Class
 * Manages individual file state and UI representation.
 */
class FileTransfer {
  constructor(file) {
    this.file = file;
    this.completionCount = 0;
    this.ui = this.buildUI();
  }

  buildUI() {
    const cleanName = utils.cleanFileName(this.file.name);
    const sizeStr = utils.formatSize(this.file.size);
    const emoji = memtypeModule && typeof memtypeModule.addEmoji === "function" 
      ? memtypeModule.addEmoji(cleanName) 
      : "📄 ";

    const loading = utils.createEl("span", { className: "loading loading-dots" });
    const progress = utils.createEl("div", { 
      className: "radial-progress text-info", 
      style: "display: none; --value:0; --size:1.3rem;" 
    });
    const statusText = utils.createEl("span", { className: "w-max text-[0.8rem] md:text-[1rem]" });

    const container = utils.createEl("div", 
      { className: "flex flex-col gap-1 w-full p-2 mt-3 shadow-sm rounded-lg border border-base-200" },
      utils.createEl("div", { className: "flex w-full justify-between break-all items-center" },
        utils.createEl("h3", { 
          className: "text-[0.85rem] font-bold", 
          textContent: `${emoji}${cleanName} (${sizeStr})` 
        }),
        utils.createEl("div", { className: "ml-auto pl-2 flex gap-2 items-center" }, loading, progress, statusText)
      )
    );

    DOM.showFiles.appendChild(container);

    return { loading, progress, statusText };
  }

  updateUI(status) {
    const { loading, progress, statusText } = this.ui;
    const setDisplay = (el, val) => { if (el) el.style.display = val; };

    switch (status) {
      case "pending":
        setDisplay(loading, "inline-block");
        setDisplay(statusText, "none");
        setDisplay(progress, "none");
        break;
      case "sending":
        setDisplay(loading, "inline-block");
        setDisplay(progress, "none");
        statusText.textContent = " sending";
        setDisplay(statusText, "inline-block");
        break;
      case "completed":
        this.completionCount++;
        setDisplay(loading, "none");
        setDisplay(progress, "none");
        statusText.textContent = this.completionCount > 1 ? `${this.completionCount} times ✅` : "✅";
        setDisplay(statusText, "inline-block");
        break;
      case "Canceled":
        setDisplay(loading, "none");
        setDisplay(progress, "none");
        statusText.textContent = "⚠️ canceled";
        setDisplay(statusText, "inline-block");
        break;
      default: // Progress percentage
        setDisplay(loading, "none");
        setDisplay(progress, "inline-block");
        progress.style.setProperty("--value", status);
        statusText.textContent = ` ${status}%`;
        setDisplay(statusText, "inline-block");
    }
  }

  async upload() {
    try {
      const res = await fetch('/relay-from-server/make', {
        method: "POST",
        body: this.file,
        headers: {
          "filename": encodeURIComponent(utils.cleanFileName(this.file.name)),
          "filesize": this.file.size
        }
      });
      return await res.text();
    } catch (error) {
      console.error("Upload execution aborted:", error);
      return "Closed";
    }
  }
}

async function handleLiveShare() {
  if (!targetDeviceId) return;

  DOM.fileInput.disabled = true;
  DOM.deviceSelect.disabled = true;
  connectedDevices.close();

  const deviceName = (localStorage.getItem("deviceName") || "unknown").replaceAll("-", "_");
  DOM.showFiles.style.display = "block";
  DOM.cancelBtn.style.display = "block";

  const controller = new ShareController(DOM.fileInput, deviceName, targetDeviceId);
  
  // BUG FIX: Wired up the unused Cancel Button reference so that 
  // clicking the UI button actually invokes the termination sequence.
  DOM.cancelBtn.onclick = () => controller.terminate();
  
  await controller.start();
  window.onbeforeunload = () => controller.terminate();
}