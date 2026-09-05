# ExamGuard Desktop Releases & Packaging (Phase 15 & 19)

This document covers desktop application packaging, multi-platform artifact generation, release manifest structure, and GitHub Releases CI automation.

---

## 1. Supported Platform Targets & Formats

| Platform | Target Package | Output File Pattern | Builder Strategy |
| :--- | :--- | :--- | :--- |
| **Windows** | NSIS Installer (`.exe`) | `ExamGuard Setup {version}.exe` | `electron-builder --win nsis` |
| **macOS** | Disk Image (`.dmg`) | `ExamGuard-{version}.dmg` | `electron-builder --mac dmg` |
| **Linux** | AppImage (`.AppImage`) | `ExamGuard-{version}.AppImage` | `electron-builder --linux AppImage` |

---

## 2. Release Manifest (`release-manifest.json`) Schema

The root `release-manifest.json` provides an authoritative machine-readable inventory of release binaries:

```json
{
  "name": "ExamGuard",
  "version": "0.3.0",
  "buildTimestamp": "2026-09-05T19:26:00Z",
  "gitCommit": "1e75825",
  "artifacts": [
    {
      "platform": "windows",
      "arch": "x64",
      "filename": "ExamGuard Setup 0.3.0.exe",
      "relativePath": "apps/student-desktop/dist/installer/ExamGuard Setup 0.3.0.exe",
      "sha256": "be7a76f8b0fe51e32b7832700cdb5a77db3c15d0442db4ef5302fde1acc7f89d",
      "size": 111851067,
      "releaseDate": "2026-09-05",
      "signed": false,
      "signatureStatus": "UNSIGNED RELEASE CANDIDATE (No EV Code-Signing Certificate available)",
      "downloadUrl": "https://github.com/siddharth-1118/Exam-Guard/releases/download/v0.3.0/ExamGuard-Setup-0.3.0.exe"
    }
  ]
}
```

---

## 3. GitHub Releases Workflow Integration

Desktop binaries are compiled and published automatically via `.github/workflows/release.yml` whenever a tag matching `v*` (e.g. `v0.3.0`) is pushed to GitHub.

```bash
# To trigger a release build:
git tag v0.3.0
git push origin v0.3.0
```

---

## 4. Code Signing & Security Notice

> [!WARNING]
> Windows builds produced in development or local environments are **UNSIGNED RELEASE CANDIDATES**. Without an EV Code-Signing Certificate, Windows SmartScreen will display an unknown publisher alert upon execution. For enterprise deployment, a valid Microsoft EV Code-Signing Certificate must be integrated into `electron-builder` parameters (`CSC_LINK` & `CSC_KEY_PASSWORD`).
