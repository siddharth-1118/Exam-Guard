import {
  isBuiltInCamera,
  isVirtualCamera,
  selectPreferredCamera,
} from '../src/media/devices';

describe('Camera Selection Strategy & Heuristics', () => {
  describe('isVirtualCamera classification', () => {
    it('correctly identifies virtual cameras by label', () => {
      expect(isVirtualCamera('Phone Link')).toBe(true);
      expect(isVirtualCamera('Link to Windows')).toBe(true);
      expect(isVirtualCamera('Windows Phone')).toBe(true);
      expect(isVirtualCamera('OBS Virtual Camera')).toBe(true);
      expect(isVirtualCamera('DroidCam Source 3')).toBe(true);
      expect(isVirtualCamera('ManyCam Virtual Webcam')).toBe(true);
      expect(isVirtualCamera('Snap Camera')).toBe(true);
      expect(isVirtualCamera('XSplit VCam')).toBe(true);
    });

    it('returns false for physical webcams', () => {
      expect(isVirtualCamera('Integrated Camera')).toBe(false);
      expect(isVirtualCamera('HD WebCam')).toBe(false);
      expect(isVirtualCamera('Logitech HD Pro Webcam C920')).toBe(false);
      expect(isVirtualCamera('USB Video Device')).toBe(false);
    });
  });

  describe('isBuiltInCamera classification', () => {
    it('correctly identifies laptop built-in webcams', () => {
      expect(isBuiltInCamera('Integrated Camera')).toBe(true);
      expect(isBuiltInCamera('Built-in iSight')).toBe(true);
      expect(isBuiltInCamera('Internal Camera')).toBe(true);
      expect(isBuiltInCamera('Laptop Webcam')).toBe(true);
      expect(isBuiltInCamera('FaceTime HD Camera')).toBe(true);
    });

    it('returns false for external/virtual webcams', () => {
      expect(isBuiltInCamera('Logitech C920')).toBe(false);
      expect(isBuiltInCamera('Phone Link')).toBe(false);
      expect(isBuiltInCamera('OBS Virtual Camera')).toBe(false);
    });
  });

  describe('selectPreferredCamera (Step 10 test cases)', () => {
    const integratedCam = { deviceId: 'cam-integrated-1', kind: 'videoinput', label: 'Integrated Camera' };
    const phoneLinkCam = { deviceId: 'cam-phone-link-1', kind: 'videoinput', label: 'Phone Link' };
    const obsVirtualCam = { deviceId: 'cam-obs-1', kind: 'videoinput', label: 'OBS Virtual Camera' };
    const usbWebcam = { deviceId: 'cam-usb-1', kind: 'videoinput', label: 'Logitech Brio 4K' };

    it('Case 1: Integrated Camera + Phone Link camera -> Integrated Camera selected', () => {
      const devices = [phoneLinkCam, integratedCam];
      const selected = selectPreferredCamera(devices);
      expect(selected?.deviceId).toBe(integratedCam.deviceId);
    });

    it('Case 2: Integrated Camera + OBS Virtual Camera -> Integrated Camera selected', () => {
      const devices = [obsVirtualCam, integratedCam];
      const selected = selectPreferredCamera(devices);
      expect(selected?.deviceId).toBe(integratedCam.deviceId);
    });

    it('Case 3: Integrated Camera + USB webcam -> Integrated Camera selected by default', () => {
      const devices = [usbWebcam, integratedCam];
      const selected = selectPreferredCamera(devices);
      expect(selected?.deviceId).toBe(integratedCam.deviceId);
    });

    it('Case 4: Only USB physical webcam -> USB webcam selected', () => {
      const devices = [usbWebcam];
      const selected = selectPreferredCamera(devices);
      expect(selected?.deviceId).toBe(usbWebcam.deviceId);
    });

    it('Case 5: Only virtual camera -> Returns null (unavailable state for exam proctoring)', () => {
      const devices = [phoneLinkCam, obsVirtualCam];
      const selected = selectPreferredCamera(devices);
      expect(selected).toBeNull();
    });

    it('Case 6: User explicitly selects a different camera -> Explicit selection wins', () => {
      const devices = [integratedCam, usbWebcam, phoneLinkCam];
      // User explicitly picks USB webcam
      const selectedUsb = selectPreferredCamera(devices, usbWebcam.deviceId);
      expect(selectedUsb?.deviceId).toBe(usbWebcam.deviceId);

      // User explicitly picks Phone Link (explicit override allowed)
      const selectedPhone = selectPreferredCamera(devices, phoneLinkCam.deviceId);
      expect(selectedPhone?.deviceId).toBe(phoneLinkCam.deviceId);
    });

    it('Case 7 & 8: Phone Link appears/disappears -> ExamGuard stays on preferred physical device', () => {
      // System initially has Integrated Camera
      let devices = [integratedCam];
      let selected = selectPreferredCamera(devices);
      expect(selected?.deviceId).toBe(integratedCam.deviceId);

      // Phone Link connects dynamically
      devices = [phoneLinkCam, integratedCam];
      selected = selectPreferredCamera(devices);
      expect(selected?.deviceId).toBe(integratedCam.deviceId); // Stays on integrated camera!

      // Phone Link disconnects
      devices = [integratedCam];
      selected = selectPreferredCamera(devices);
      expect(selected?.deviceId).toBe(integratedCam.deviceId);
    });
  });
});
