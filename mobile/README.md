# OpenClips Mobile

A scoped-down, CapCut-style Android companion to the OpenClips desktop editor: import clips,
trim/split, add a fade transition between clips, export - built with
[Capacitor](https://capacitorjs.com/) (the UI is plain HTML/CSS/JS in `www/`) plus a small
custom native plugin (`android/app/src/main/java/com/openclips/app/OpenClipsNativePlugin.java`)
that handles everything a WebView can't do on its own: picking real files via the system
document picker, running ffmpeg via
[ffmpeg-kit (maintained fork)](https://github.com/ffmpegkit-maintained/ffmpeg-kit), thumbnail
extraction, and saving the export to the device's Gallery via MediaStore.

This is a **v1 companion app**, not a port of the desktop feature set - no masks, keyframes,
curves/wheels, or the full transition library. Just the core mobile flow: add clips, trim, one
transition type, export.

## Why `dev.ffmpegkit-maintained` and not `com.arthenica`

The original `com.arthenica:ffmpeg-kit-*` artifacts were removed from Maven Central after the
project's retirement (announced Jan 2025, artifacts pulled April 2025). `dev.ffmpegkit-maintained`
is an actively maintained drop-in continuation - same package (`com.arthenica.ffmpegkit`), same
class names, only the Gradle group ID changed. If you see `ffmpeg-kit-full-gpl:6.0.LTS` "not
found" errors from an older reference to this project, that's why.

## Building

You need a JDK 17, the Android SDK (`platform-tools`, `platforms;android-34`,
`build-tools;34.0.0`), and Gradle (the wrapper will fetch its own compatible version - just
needs a JDK on `JAVA_HOME`).

```bash
cd mobile
npm install
npx cap sync android
cd android
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk ./gradlew assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`. It's signed with the
standard Android debug key, so it installs directly on any device with "install unknown apps"
allowed - it is **not** signed for Play Store distribution.

## Known limitations / not yet verified

- Built and packaged in an environment without a physical Android device or emulator available,
  so the APK has been verified to **build and package correctly** (including a real compile
  against the ffmpeg-kit API), but the app's actual runtime behavior - import, trim, export,
  gallery save - has not been exercised on a real device yet. Test on real hardware before
  relying on it.
- No custom splash screen yet (Capacitor default).
