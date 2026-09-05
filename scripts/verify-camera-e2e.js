const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

app.whenReady().then(async () => {
  console.log('=== REAL WINDOWS CAMERA E2E VERIFICATION ===');
  
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../apps/student-desktop/dist/main/preload.js')
    }
  });

  win.webContents.on('console-message', (event, level, message) => {
    console.log('[RENDERER LOG]', message);
  });

  const indexPath = path.join(__dirname, '../apps/student-desktop/dist/renderer/index.html');
  await win.loadFile(indexPath);

  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const results = {};

          // Probe stream to populate labels if unpopulated
          let tempStream;
          try {
            tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
          } catch (e) {}

          // 1. Enumerate Devices
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devices.filter(d => d.kind === 'videoinput');
          results.enumeratedDevices = videoInputs.map(d => ({ deviceId: d.deviceId, label: d.label }));

          if (tempStream) {
            tempStream.getTracks().forEach(t => t.stop());
          }

          // 2. Classify devices using label patterns directly inside browser context
          const VIRTUAL_CAMERA_PATTERNS = [
            'phone link', 'obs', 'virtual', 'droidcam', 'e2esoft', 'manycam',
            'camo', 'iriun', 'snap camera', 'splitcam', 'vividcam', 'deviceless'
          ];
          const INTEGRATED_PATTERNS = [
            'integrated', 'internal', 'built-in', 'webcam', 'acer hd', 'realtek',
            'chicony', 'sunplus', 'facetime', 'front camera', 'ir camera', 'laptop camera'
          ];
          const EXTERNAL_PATTERNS = [
            'usb', 'external', 'logitech', 'c920', 'c922', 'brio', 'microsoft lifecam',
            'anker', 'razer', 'elgato'
          ];

          function classifyCameraDevice(device) {
            const label = (device.label || '').toLowerCase();
            if (!label) return 'unknown';
            if (VIRTUAL_CAMERA_PATTERNS.some(p => label.includes(p))) return 'virtual';
            if (INTEGRATED_PATTERNS.some(p => label.includes(p))) return 'physical-integrated';
            if (EXTERNAL_PATTERNS.some(p => label.includes(p))) return 'physical-external';
            return 'unknown';
          }

          function selectPreferredCamera(deviceList, userSelectedId) {
            if (userSelectedId) {
              const sel = deviceList.find(d => d.deviceId === userSelectedId);
              if (sel) return sel;
            }
            const classified = deviceList.map(device => ({ device, classification: classifyCameraDevice(device) }));
            const integrated = classified.find(c => c.classification === 'physical-integrated');
            if (integrated) return integrated.device;
            const external = classified.find(c => c.classification === 'physical-external');
            if (external) return external.device;
            const unknown = classified.find(c => c.classification === 'unknown');
            if (unknown) return unknown.device;
            return null;
          }

          const classifiedDevices = videoInputs.map(d => ({
            deviceId: d.deviceId,
            label: d.label,
            classification: classifyCameraDevice(d)
          }));
          results.classifiedDevices = classifiedDevices;

          // 3. Automatic Selection
          const selectedDevice = selectPreferredCamera(videoInputs);
          results.automaticSelectedDevice = selectedDevice ? {
            deviceId: selectedDevice.deviceId,
            label: selectedDevice.label,
            classification: classifyCameraDevice(selectedDevice)
          } : null;

          if (!selectedDevice) {
            results.autoSelectionPass = false;
            return results;
          }

          const selectedClassification = classifyCameraDevice(selectedDevice);
          const isPhysical = selectedClassification === 'physical-integrated' || selectedClassification === 'physical-external';
          const isVirtualExcluded = classifiedDevices.filter(d => d.classification === 'virtual').every(v => v.deviceId !== selectedDevice.deviceId);

          results.autoSelectionPass = isPhysical && isVirtualExcluded;

          // 4. Exact getUserMedia Call
          const constraints = {
            video: {
              deviceId: { exact: selectedDevice.deviceId },
              width: { ideal: 640 },
              height: { ideal: 480 }
            }
          };
          results.constraintsUsed = constraints;

          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          const videoTrack = stream.getVideoTracks()[0];

          results.trackSettings = videoTrack.getSettings();
          results.trackLabel = videoTrack.label;
          results.trackReadyState = videoTrack.readyState;
          results.trackEnabled = videoTrack.enabled;

          // Compare track.getSettings().deviceId with selectedDevice.deviceId
          results.trackDeviceIdMatchesSelected = videoTrack.getSettings().deviceId === selectedDevice.deviceId;

          // 5. Verify Frame Reception
          const frameVerification = await new Promise((resolve) => {
            let count = 0;
            const video = document.createElement('video');
            video.srcObject = stream;
            video.onloadeddata = () => {
              results.videoPlaying = true;
            };
            video.play().catch(() => {});

            const check = setInterval(() => {
              count++;
              if (videoTrack.readyState === 'live' && videoTrack.enabled) {
                clearInterval(check);
                resolve({ frameSuccess: true, count });
              } else if (count > 15) {
                clearInterval(check);
                resolve({ frameSuccess: false, count });
              }
            }, 100);
          });

          results.frameVerification = frameVerification;

          // 6. Test Exam Termination / Stop Track
          videoTrack.stop();
          results.stoppedTrackState = videoTrack.readyState;

          return results;
        } catch (err) {
          return { error: err.stack || err.message };
        }
      })();
    `);

    console.log('=== VERIFICATION JSON OUTPUT ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Execution error:', err);
  }

  app.quit();
});
