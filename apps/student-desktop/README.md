# @examguard/student-desktop

Secure Desktop Examination Application (Windows/macOS/Linux).

## Camera Selection & Hardware Prioritization

ExamGuard Student Desktop features a deterministic camera selection mechanism designed to prioritize physical, built-in laptop webcams over virtual camera drivers (such as Windows Phone Link, OBS Virtual Camera, or DroidCam).

### Classification Heuristics

`classifyCameraDevice(device: MediaDeviceInfo)` inspects device `label` properties and assigns one of four classifications:

1. **`physical-integrated`**: Integrated built-in webcams (e.g. labels containing `"integrated"`, `"internal"`, `"built-in"`, `"webcam"`, `"acer hd"`, `"realtek"`, `"chicony"`, `"sunplus"`, etc.).
2. **`physical-external`**: USB or external webcams (e.g. labels containing `"usb"`, `"external"`, `"logitech"`, `"c920"`, `"brio"`, etc. without virtual markers).
3. **`virtual`**: Software / virtual camera drivers (e.g. labels containing `"phone link"`, `"obs"`, `"virtual"`, `"droidcam"`, `"e2esoft"`, `"manycam"`, `"camo"`, `"iriun"`, `"snap camera"`, `"splitcam"`, `"vividcam"`, `"deviceless"`).
4. **`unknown`**: Devices where labels are absent, generic, or do not match physical or virtual keywords.

### Selection Priority Algorithm

`selectPreferredCamera(devices, userSelectedDeviceId)` resolves camera selection using the following strict priority cascade:

1. **Explicit User Choice**: If `userSelectedDeviceId` is provided and matches an existing available camera, that device is used immediately (regardless of classification).
2. **`physical-integrated`**: First choice when no explicit user selection is made.
3. **`physical-external`**: Second choice if no integrated camera is available.
4. **`unknown`**: Fallback choice if no known physical camera is identified.
5. **`virtual`**: **Never selected automatically**. If only virtual cameras are available, `selectPreferredCamera` returns `null`, transitioning the device status to `unavailable` and prompting the user in preflight.

### Reconnect & Disconnection Handling

- When the active camera is disconnected during preflight or exam execution, `acquireDevice` runs `selectPreferredCamera` to safely switch to the next best physical camera.
- If no physical camera remains available, `acquired` state changes to `unavailable`, preventing unmonitored examination sessions.

### User Selection Override & Preflight UI

- In `PreflightScreen.tsx`, students see the exact camera label currently selected.
- If multiple physical cameras are attached (or if a student explicitly wishes to use a specific camera), a dropdown allows explicit device selection. Selecting a device updates `userSelectedDeviceId`, overriding automatic heuristics.

### Windows / Chromium Platform Limitations

> [!NOTE]
> Neither the W3C Media Capture API nor the Windows OS provides a standard native hardware property distinguishing virtual camera drivers from physical USB/PCI devices. Therefore, camera classification uses pattern-matching heuristics against device labels. In rare cases where a virtual driver masks itself with a generic physical name (or vice versa), the user can override the selection via the Preflight UI dropdown.