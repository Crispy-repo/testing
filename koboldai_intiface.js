// ==UserScript==
// @name         KoboldCPP
// @namespace    http://tampermonkey.net/
// @version      2025-03-31
// @description  try to take over the world!
// @author       You
// @match        http://localhost:5001/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=undefined.localhost
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/buttplug@3.0.0/dist/web/buttplug.min.js

// ==/UserScript==



(async function() {
    'use strict';

    // Global variables
    let client = null;
    let isConnected = false;
    let mappingStarted = false;
    // mappingConfig is an array of objects: { mapping: number, osc: number }
    let mappingConfig = [];
    let lastSentValues = []; // Last chat value received for each device
    // Oscillation variables: for each device, store the current oscillation timer, base value, and start time.
    let oscillationTimers = [];
    let oscillationBases = [];
    let oscillationStartTime = [];
    // Interval for chat processing (mapping)
    let mappingProcessingInterval = null;
    // Global variable for the connection status check interval.
    let connectionCheckInterval = null;

    // Helper function to round a number to 3 decimal places.
    function roundTo3(num) {
        return Math.round(num * 1000) / 1000;
    }

    // Debug log helper.
    function debugLog(message) {
        console.log(message);
    }

    // Toggle the help/documentation popup.
    function toggleDocumentation() {
        const helpPanel = document.getElementById("help-panel");
        if (!helpPanel.style.display || helpPanel.style.display === "none") {
            helpPanel.style.display = "block";
        } else {
            helpPanel.style.display = "none";
        }
    }

    // Create the help/documentation popup.
    function createHelpPanel() {
        const helpPanel = document.createElement("div");
        helpPanel.id = "help-panel";
        helpPanel.style.position = "fixed";
        helpPanel.style.bottom = "calc(95px + 320px)"; // positioned above the UI; adjust if needed
        helpPanel.style.right = "10px";
        helpPanel.style.width = "400px"; // wider to match panel
        helpPanel.style.background = "rgba(0,0,0,0.9)";
        helpPanel.style.color = "white";
        helpPanel.style.padding = "10px";
        helpPanel.style.borderRadius = "8px";
        helpPanel.style.fontFamily = "Arial, sans-serif";
        helpPanel.style.fontSize = "12px";
        helpPanel.style.zIndex = "10000";
        helpPanel.style.display = "none";
        helpPanel.innerHTML = `
            <strong>Program Documentation</strong><br>
            This program connects to Intiface using the fixed URL <code>ws://localhost:12345</code> and scans for connected devices.<br><br>
            <em>Mapping Settings:</em><br>
            - Use the dropdowns to assign which chat message number controls each device.<br>
            - Under each device, adjust the slider (0–50) to set an oscillation percentage. For example, 10 means the device’s intensity will oscillate between base ± 10% of the base value if no new value arrives.<br>
            - The oscillated intensity is clamped between 0 and 100.<br><br>
            <em>Connection:</em><br>
            - The toggle button shows a red dot with "Connect" when disconnected and a green dot with "Disconnect" when connected.<br><br>
            <em>Chat Processing:</em><br>
            - The script listens for chat messages containing numbers and sends vibration commands accordingly.<br><br>
            Click the "?" button again to close this help.
        `;
        document.body.appendChild(helpPanel);
    }

    // Update the toggle button appearance based on connection status.
    function updateToggleButton() {
        const btn = document.getElementById("connect-btn");
        if (isConnected) {
            btn.innerHTML = `<span id="connection-indicator" style="display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; background:green;"></span>Disconnect`;
        } else {
            btn.innerHTML = `<span id="connection-indicator" style="display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; background:red;"></span>Connect`;
        }
    }

    // Toggle connection: if connected, disconnect; if not, connect.
    async function toggleConnection() {
        if (!isConnected) {
            await connectToIntiface();
            if (!connectionCheckInterval) {
                connectionCheckInterval = setInterval(checkConnectionStatus, 10000);
            }
        } else {
            await disconnectFromIntiface();
            if (connectionCheckInterval) {
                clearInterval(connectionCheckInterval);
                connectionCheckInterval = null;
            }
        }
        updateToggleButton();
    }

    // Start processing chat messages (mapping).
    function startMapping() {
        // Clear any existing oscillation timers.
        if (oscillationTimers && oscillationTimers.length > 0) {
            for (let i = 0; i < oscillationTimers.length; i++) {
                if (oscillationTimers[i]) {
                    clearInterval(oscillationTimers[i]);
                }
            }
        }
        const mappingSettingsDiv = document.getElementById("mapping-settings");
        const selects = mappingSettingsDiv.getElementsByTagName("select");
        mappingConfig = [];
        lastSentValues = [];
        oscillationTimers = [];
        oscillationBases = [];
        oscillationStartTime = [];
        for (let i = 0; i < selects.length; i++) {
            const sel = selects[i];
            const mappingValue = parseInt(sel.value, 10);
            const slider = document.getElementById("osc-device-" + i);
            const oscValue = parseFloat(slider.value) || 0;
            mappingConfig.push({ mapping: mappingValue, osc: oscValue });
            lastSentValues.push(null);
            oscillationTimers.push(null);
            oscillationBases.push(null);
            oscillationStartTime.push(null);
        }
        debugLog("Mapping configuration set: " + mappingConfig.map(obj => `(${obj.mapping}, ${obj.osc}%)`).join(", "));
        mappingStarted = true;
        mappingProcessingInterval = setInterval(checkMessages, 2000);
        const startBtn = document.getElementById("start-btn");
        startBtn.innerText = "Stop";
        startBtn.style.backgroundColor = "";
        startBtn.style.border = "";
        startBtn.style.fontWeight = "";
    }

    // Stop processing chat messages (mapping) and send 0 to every device.
    function stopMapping() {
        if (mappingProcessingInterval) {
            clearInterval(mappingProcessingInterval);
            mappingProcessingInterval = null;
        }
        mappingStarted = false;
        const startBtn = document.getElementById("start-btn");
        startBtn.innerText = "Start";
        // Send a 0 command to every device.
        try {
            if (client && client.devices && client.devices.length > 0) {
                for (let i = 0; i < client.devices.length; i++) {
                    sendVibrationCommandToDevice(client.devices[i], 0);
                }
            }
        } catch(e) {
            debugLog("Error sending stop command: " + e);
        }
    }

    // Toggle mapping processing: start if not running; stop if running.
    function toggleMapping() {
        if (mappingStarted) {
            stopMapping();
        } else {
            startMapping();
        }
    }

    // Create the UI. The UI wrapper holds the help button and control panel.
    function createUI() {
        // Create a container for the UI.
        const wrapper = document.createElement('div');
        wrapper.id = 'ui-wrapper';
        // Position the wrapper fixed at bottom-right.
        wrapper.style.position = 'fixed';
        wrapper.style.bottom = '10px';
        wrapper.style.right = '10px';
        wrapper.style.zIndex = '9999';

        // Create the main control panel.
        const panel = document.createElement('div');
        panel.id = 'control-panel';
        panel.style.width = '400px'; // wider panel
        panel.style.background = 'rgba(0,0,0,0.8)';
        panel.style.color = 'white';
        panel.style.padding = '10px';
        panel.style.borderRadius = '8px';
        panel.style.fontFamily = 'Arial, sans-serif';
        panel.style.position = 'relative';

        // Add the help ("?") button inside the panel at the top left.
        const helpBtn = document.createElement("button");
        helpBtn.id = "help-btn";
        helpBtn.innerText = "?";
        helpBtn.style.position = "absolute";
        helpBtn.style.top = "5px";
        helpBtn.style.left = "5px"; // flush with left edge of the panel
        helpBtn.style.background = "none";
        helpBtn.style.border = "none";
        helpBtn.style.color = "white";
        helpBtn.style.fontSize = "16px";
        helpBtn.style.cursor = "pointer";
        panel.appendChild(helpBtn);

        // Create a content container with margin to avoid overlap with the help button.
        const contentDiv = document.createElement("div");
        contentDiv.style.marginTop = "30px";
        contentDiv.innerHTML = `
            <div id="connection-section">
                <strong>Intiface Connection</strong><br>
                <div id="doc-section" style="margin-top:5px; font-size:12px;">
                    <a id="doc-link" href="https://docs.intiface.com/docs/intiface-central/ui/app-modes-repeater-panel/" target="_blank" style="color:white; text-decoration:none; background-color:#2196F3; padding:2px 4px; border-radius:4px; font-weight:bold;">
                        Repeater Mode Documentation
                    </a>
                </div>
                <button id="connect-btn" style="width:100%; padding:5px; margin-top:5px;">
                    <span id="connection-indicator" style="display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; background:red;"></span>Connect
                </button>
                <div id="status" style="margin-top:5px; font-size:14px; color: orange;">Not connected</div>
            </div>
            <div id="mapping-section" style="display:none; margin-top:10px;">
                <strong>Mapping Settings</strong><br>
                <div id="mapping-settings"></div>
                <button id="refresh-devices-btn" style="width:100%; padding:5px; margin-top:5px;">Refresh Devices</button>
                <button id="start-btn" style="width:100%; padding:5px; margin-top:5px;">Start</button>
            </div>
            <div id="last-value" style="margin-top:10px; font-size:14px;">Last Read: None</div>
        `;
        panel.appendChild(contentDiv);

        // Create the "Hide UI" button inside the panel (top right).
        const hideBtn = document.createElement('button');
        hideBtn.id = 'hide-ui-btn';
        hideBtn.innerText = 'Hide UI';
        hideBtn.style.position = 'absolute';
        hideBtn.style.top = '5px';
        hideBtn.style.right = '5px';
        hideBtn.style.fontSize = '10px';
        hideBtn.style.padding = '2px 4px';
        hideBtn.style.cursor = 'pointer';
        panel.appendChild(hideBtn);

        // Append the panel to the wrapper.
        wrapper.appendChild(panel);
        document.body.appendChild(wrapper);

        // Hook up event listeners.
        helpBtn.addEventListener("click", toggleDocumentation);
        document.getElementById("connect-btn").addEventListener("click", toggleConnection);
        hideBtn.addEventListener("click", function() {
            wrapper.style.display = 'none';
            showRestoreButton();
        });
        // Use toggleMapping for the start button.
        document.getElementById("start-btn").addEventListener("click", toggleMapping);
        document.getElementById("refresh-devices-btn").addEventListener("click", function() {
            populateMappingSettings();
            mappingStarted = false;
            const startBtn = document.getElementById("start-btn");
            startBtn.innerText = "Restart";
            startBtn.style.backgroundColor = "#ff9800";
            startBtn.style.border = "2px solid #fff";
            startBtn.style.fontWeight = "bold";
        });
        createRestoreButton();
    }

    // Create a small restore button that appears when the UI wrapper is hidden.
    function createRestoreButton() {
        const restoreBtn = document.createElement('div');
        restoreBtn.id = 'restore-btn';
        restoreBtn.style.position = 'fixed';
        restoreBtn.style.bottom = '10px';
        restoreBtn.style.right = '10px';
        restoreBtn.style.width = '40px';
        restoreBtn.style.height = '40px';
        restoreBtn.style.background = 'rgba(0,0,0,0.8)';
        restoreBtn.style.color = 'white';
        restoreBtn.style.borderRadius = '50%';
        restoreBtn.style.display = 'none';
        restoreBtn.style.justifyContent = 'center';
        restoreBtn.style.alignItems = 'center';
        restoreBtn.style.cursor = 'pointer';
        restoreBtn.style.zIndex = '10000';
        restoreBtn.innerText = '💦';
        document.body.appendChild(restoreBtn);

        restoreBtn.addEventListener("click", function() {
            document.getElementById('ui-wrapper').style.display = 'block';
            this.style.display = 'none';
        });
    }

    // Show the restore button when the UI wrapper is hidden.
    function showRestoreButton() {
        const restoreBtn = document.getElementById('restore-btn');
        if (restoreBtn) {
            restoreBtn.style.display = 'flex';
        }
    }

    // Connect to Intiface via WebSocket and start scanning for devices.
    async function connectToIntiface() {
        const wsUrl = "ws://localhost:12345"; // fixed URL, ws/wss limitation
        try {
            client = new Buttplug.ButtplugClient("KoboldAI Intiface");
            const connector = new Buttplug.ButtplugBrowserWebsocketClientConnector(wsUrl);
            await client.connect(connector);
            await client.startScanning();
            isConnected = true;
            document.getElementById("status").innerText = "Connected!";
            document.getElementById("status").style.color = "lime";
            debugLog("Connected to Intiface and scanning for devices...");
            setTimeout(populateMappingSettings, 4000);
        } catch (err) {
            isConnected = false;
            document.getElementById("status").innerText = "Connection failed!";
            document.getElementById("status").style.color = "red";
            debugLog("Connection error: " + err);
        }
    }

    // Disconnect from Intiface.
    async function disconnectFromIntiface() {
        if (client && isConnected) {
            try {
                await client.disconnect();
                isConnected = false;
                document.getElementById("status").innerText = "Disconnected";
                document.getElementById("status").style.color = "red";
                debugLog("Disconnected from Intiface.");
                updateToggleButton();
                if (connectionCheckInterval) {
                    clearInterval(connectionCheckInterval);
                    connectionCheckInterval = null;
                }
            } catch (err) {
                debugLog("Error disconnecting: " + err);
            }
        }
    }

    // Check if the connection is still up. This function is called every 10 seconds.
    function checkConnectionStatus() {
        try {
            if (client && typeof client.connected !== "undefined") {
                isConnected = client.connected;
                if (isConnected) {
                    document.getElementById("status").innerText = "Connected!";
                    document.getElementById("status").style.color = "lime";
                    debugLog("Connection status check: Connected");
                } else {
                    document.getElementById("status").innerText = "Disconnected";
                    document.getElementById("status").style.color = "red";
                    debugLog("Connection status check: Disconnected");
                }
                updateToggleButton();
            }
        } catch (e) {
            isConnected = false;
            document.getElementById("status").innerText = "Disconnected";
            document.getElementById("status").style.color = "red";
            debugLog("Connection status check error: " + e);
            updateToggleButton();
        }
    }

    // Populate the mapping settings based on the connected devices (up to 4).
    // Each device gets a flex container row with its name and dropdown on one line,
    // and underneath a slider (0–50) for oscillation.
    function populateMappingSettings() {
        try {
            if (!client || !client.connected) {
                debugLog("Client not connected. Cannot populate mapping settings.");
                return;
            }
            let devices = client.devices;
            if (!devices || devices.length === 0) {
                debugLog("No devices found. Ensure your toys are turned on and connected.");
                return;
            }
            if (devices.length > 4) {
                devices = devices.slice(0, 4);
            }
            const mappingSection = document.getElementById("mapping-section");
            mappingSection.style.display = "block";
            const mappingSettingsDiv = document.getElementById("mapping-settings");
            mappingSettingsDiv.innerHTML = "";
            for (let i = 0; i < devices.length; i++) {
                const device = devices[i];
                // Create a container for this device mapping.
                const container = document.createElement("div");
                container.style.marginTop = "10px";
                container.style.borderBottom = "1px solid #555";
                container.style.paddingBottom = "5px";
                // Create a row for the device name and dropdown.
                const row = document.createElement("div");
                row.style.display = "flex";
                row.style.alignItems = "center";
                row.style.flexWrap = "wrap";
                // Device name label.
                const label = document.createElement("div");
                label.innerText = device.name + ": ";
                label.style.flex = "1";
                label.style.whiteSpace = "nowrap";
                // Dropdown for chat number mapping.
                const select = document.createElement("select");
                select.id = "mapping-device-" + i;
                for (let j = 1; j <= devices.length; j++) {
                    const option = document.createElement("option");
                    option.value = j;
                    option.text = "Number " + j;
                    if (j === i + 1) {
                        option.selected = true;
                    }
                    select.appendChild(option);
                }
                row.appendChild(label);
                row.appendChild(select);
                container.appendChild(row);
                // Create a row for the oscillation slider.
                const sliderRow = document.createElement("div");
                sliderRow.style.marginTop = "5px";
                sliderRow.style.display = "flex";
                sliderRow.style.alignItems = "center";
                const sliderLabel = document.createElement("div");
                sliderLabel.innerText = "Osc:";
                sliderLabel.style.marginRight = "5px";
                // Slider input.
                const slider = document.createElement("input");
                slider.type = "range";
                slider.min = "0";
                slider.max = "50";
                slider.step = "1";
                slider.value = "0";
                slider.id = "osc-device-" + i;
                // Display current slider value.
                const sliderValue = document.createElement("span");
                sliderValue.id = "osc-value-display-" + i;
                sliderValue.innerText = "0%";
                sliderValue.style.marginLeft = "5px";
                slider.addEventListener("input", function() {
                    sliderValue.innerText = slider.value + "%";
                    if(mappingStarted) {
                        mappingStarted = false;
                        const startBtn = document.getElementById("start-btn");
                        startBtn.innerText = "Restart";
                        startBtn.style.backgroundColor = "#ff9800";
                        startBtn.style.border = "2px solid #fff";
                        startBtn.style.fontWeight = "bold";
                    }
                });
                sliderRow.appendChild(sliderLabel);
                sliderRow.appendChild(slider);
                sliderRow.appendChild(sliderValue);
                container.appendChild(sliderRow);
                mappingSettingsDiv.appendChild(container);
            }
        } catch (e) {
            debugLog("Error in populateMappingSettings: " + e);
        }
    }

    // Called when the user clicks "Start" (or "Restart") after mapping is set.
    function startMapping() {
        // Clear any existing oscillation timers.
        if (oscillationTimers && oscillationTimers.length > 0) {
            for (let i = 0; i < oscillationTimers.length; i++) {
                if (oscillationTimers[i]) {
                    clearInterval(oscillationTimers[i]);
                }
            }
        }
        const mappingSettingsDiv = document.getElementById("mapping-settings");
        const selects = mappingSettingsDiv.getElementsByTagName("select");
        mappingConfig = [];
        lastSentValues = [];
        oscillationTimers = [];
        oscillationBases = [];
        oscillationStartTime = [];
        for (let i = 0; i < selects.length; i++) {
            const sel = selects[i];
            const mappingValue = parseInt(sel.value, 10);
            const slider = document.getElementById("osc-device-" + i);
            const oscValue = parseFloat(slider.value) || 0;
            mappingConfig.push({ mapping: mappingValue, osc: oscValue });
            lastSentValues.push(null);
            oscillationTimers.push(null);
            oscillationBases.push(null);
            oscillationStartTime.push(null);
        }
        debugLog("Mapping configuration set: " + mappingConfig.map(obj => `(${obj.mapping}, ${obj.osc}%)`).join(", "));
        mappingStarted = true;
        mappingProcessingInterval = setInterval(checkMessages, 2000);
        const startBtn = document.getElementById("start-btn");
        startBtn.innerText = "Stop";
        startBtn.style.backgroundColor = "";
        startBtn.style.border = "";
        startBtn.style.fontWeight = "";
    }

    // Stop processing chat messages and send a 0 command to every device.
    function stopMapping() {
        if (mappingProcessingInterval) {
            clearInterval(mappingProcessingInterval);
            mappingProcessingInterval = null;
        }
        mappingStarted = false;
        const startBtn = document.getElementById("start-btn");
        startBtn.innerText = "Start";
        // Clear any oscillation timers and send 0 to every device.
        for (let i = 0; i < oscillationTimers.length; i++) {
            if (oscillationTimers[i]) {
                clearInterval(oscillationTimers[i]);
                oscillationTimers[i] = null;
            }
        }
        try {
            if (client && client.devices && client.devices.length > 0) {
                for (let i = 0; i < client.devices.length; i++) {
                    sendVibrationCommandToDevice(client.devices[i], 0);
                }
            }
        } catch(e) {
            debugLog("Error sending stop command: " + e);
        }
    }

    // Toggle mapping: start if not running; stop if running.
    function toggleMapping() {
        if (mappingStarted) {
            stopMapping();
        } else {
            startMapping();
        }
    }

function checkMessages() {
    if (!isConnected || !mappingStarted) return;
    // Find all elements that are the AI's image
    let aiImages = document.querySelectorAll('.AI-portrait-image');
    if (!aiImages || aiImages.length === 0) {
        debugLog("No AI messages found.");
        return;
    }
    let validMsg = null;
    // Iterate backwards to get the most recent message
    for (let i = aiImages.length - 1; i >= 0; i--) {
        // Assume the parent container holds the message text
        let container = aiImages[i].parentElement;
        let textContent = container.innerText || container.textContent;
        if (textContent && textContent.match(/\d+/)) {
            validMsg = textContent;
            break;
        }
    }
    if (!validMsg) {
        debugLog("No valid vibration message found.");
        return;
    }
    debugLog("Latest valid message: " + validMsg);
    const numberMatches = validMsg.match(/\d{1,3}/g);
    if (!numberMatches) {
        debugLog("No numbers found in the message.");
        return;
    }
    document.getElementById("last-value").innerText = "Last Read: " + numberMatches.join(", ");

    // Process the numbers based on your mapping configuration
    for (let i = 0; i < mappingConfig.length; i++) {
        const mappingObj = mappingConfig[i];
        const chatIndex = mappingObj.mapping - 1; // 0-based index
        if (chatIndex < numberMatches.length) {
            const newValue = parseInt(numberMatches[chatIndex], 10);
            if (newValue !== lastSentValues[i]) {
                if (oscillationTimers[i]) {
                    clearInterval(oscillationTimers[i]);
                    oscillationTimers[i] = null;
                }
                oscillationBases[i] = newValue;
                oscillationStartTime[i] = Date.now();
                sendVibrationCommandToDevice(client.devices[i], newValue);
                lastSentValues[i] = newValue;
            } else {
                if (mappingObj.osc > 0) {
                    if (!oscillationTimers[i]) {
                        oscillationStartTime[i] = Date.now();
                        oscillationTimers[i] = setInterval(function() {
                            const frequency = 0.5; // Hz
                            const t = (Date.now() - oscillationStartTime[i]) / 1000;
                            const base = oscillationBases[i];
                            const amplitude = (mappingObj.osc / 100) * base;
                            let oscillated = base + amplitude * Math.sin(2 * Math.PI * frequency * t);
                            oscillated = Math.max(0, Math.min(100, oscillated));
                            sendVibrationCommandToDevice(client.devices[i], oscillated);
                        }, 175);
                    }
                } else {
                    if (oscillationTimers[i]) {
                        clearInterval(oscillationTimers[i]);
                        oscillationTimers[i] = null;
                    }
                }
            }
        } else {
            debugLog(`Device ${i + 1}: No corresponding number found in the message.`);
        }
    }
}
    // Sends a vibration command to a specific device.
    async function sendVibrationCommandToDevice(device, vibValue) {
        if (!device || !device.vibrate) return;
        const intensity = Math.min(Math.max(vibValue / 100, 0), 1);
        await device.vibrate(intensity);
        debugLog(`Sent vibration: ${roundTo3(intensity)} to ${device.name}`);
    }

    // Initialize help popup, UI, and start periodic connection status checks.
    createHelpPanel();
    createUI();
    connectionCheckInterval = setInterval(checkConnectionStatus, 10000);

})();
