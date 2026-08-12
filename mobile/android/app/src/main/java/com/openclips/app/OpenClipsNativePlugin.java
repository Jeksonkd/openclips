package com.openclips.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.arthenica.ffmpegkit.FFmpegKit;
import com.arthenica.ffmpegkit.FFmpegSession;
import com.arthenica.ffmpegkit.ReturnCode;
import com.arthenica.ffmpegkit.Statistics;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

// Everything a Capacitor WebView can't do on its own: pick real files (not
// just blob URLs) via the system document picker, copy them into app
// storage so both the WebView (via Capacitor.convertFileSrc) and ffmpeg-kit
// (which needs a real filesystem path, not a content:// URI) can use the
// same file, run ffmpeg-kit for export, and hand the finished video to
// MediaStore so it shows up in the device's Gallery like a real export.
@CapacitorPlugin(name = "OpenClipsNative")
public class OpenClipsNativePlugin extends Plugin {

    @PluginMethod
    public void getPaths(PluginCall call) {
        File exportDir = new File(getContext().getCacheDir(), "exports");
        if (!exportDir.exists()) exportDir.mkdirs();
        JSObject ret = new JSObject();
        ret.put("exportDir", exportDir.getAbsolutePath() + "/");
        call.resolve(ret);
    }

    @PluginMethod
    public void pickVideos(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "pickVideosResult");
    }

    @ActivityCallback
    private void pickVideosResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSArray clips = new JSArray();
        try {
            if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
                JSObject empty = new JSObject();
                empty.put("clips", clips);
                call.resolve(empty);
                return;
            }
            Intent data = result.getData();
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                for (int i = 0; i < count; i++) uris.add(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            for (Uri uri : uris) {
                JSObject clip = importOne(uri);
                if (clip != null) clips.put(clip);
            }
            JSObject ret = new JSObject();
            ret.put("clips", clips);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("pickVideos failed: " + e.getMessage());
        }
    }

    private JSObject importOne(Uri uri) throws Exception {
        String name = queryDisplayName(uri);
        File outDir = new File(getContext().getFilesDir(), "clips");
        if (!outDir.exists()) outDir.mkdirs();
        String base = (name != null ? name : "clip.mp4").replaceAll("[^a-zA-Z0-9._-]", "_");
        File outFile = new File(outDir, System.currentTimeMillis() + "_" + base);
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(outFile)) {
            if (in == null) return null;
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }

        double duration = 0;
        int width = 0, height = 0;
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(outFile.getAbsolutePath());
            String d = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (d != null) duration = Double.parseDouble(d) / 1000.0;
            String w = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
            String h = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
            String rotation = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
            if (w != null) width = Integer.parseInt(w);
            if (h != null) height = Integer.parseInt(h);
            if ("90".equals(rotation) || "270".equals(rotation)) {
                int tmp = width; width = height; height = tmp;
            }
        } finally {
            try { mmr.release(); } catch (Exception ignored) { /* nothing more to do */ }
        }

        JSObject clip = new JSObject();
        clip.put("path", outFile.getAbsolutePath());
        clip.put("name", name != null ? name : outFile.getName());
        clip.put("duration", duration);
        clip.put("width", width);
        clip.put("height", height);
        return clip;
    }

    private String queryDisplayName(Uri uri) {
        String result = null;
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) result = cursor.getString(idx);
            }
        } catch (Exception ignored) { /* fall back to a generated name */ }
        return result;
    }

    @PluginMethod
    public void generateThumbnail(PluginCall call) {
        String path = call.getString("path");
        Double atSecondsArg = call.getDouble("atSeconds");
        double atSeconds = atSecondsArg == null ? 0.0 : atSecondsArg;
        if (path == null) { call.reject("path required"); return; }
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(path);
            Bitmap bmp = mmr.getFrameAtTime(Math.round(atSeconds * 1_000_000), MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (bmp == null) { call.reject("no frame at that time"); return; }
            File outDir = new File(getContext().getCacheDir(), "thumbs");
            if (!outDir.exists()) outDir.mkdirs();
            File outFile = new File(outDir, "thumb_" + System.currentTimeMillis() + "_" + Math.round(atSeconds * 1000) + ".jpg");
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                bmp.compress(Bitmap.CompressFormat.JPEG, 82, fos);
            }
            JSObject ret = new JSObject();
            ret.put("path", outFile.getAbsolutePath());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("thumbnail failed: " + e.getMessage());
        } finally {
            try { mmr.release(); } catch (Exception ignored) { /* nothing more to do */ }
        }
    }

    // args is a full ffmpeg argv (no leading "ffmpeg") built in JS, mirroring
    // how the desktop app builds its own filter_complex - kept there rather
    // than duplicated in Java so the two stay conceptually parallel.
    @PluginMethod
    public void exportVideo(PluginCall call) {
        JSArray argsArr = call.getArray("args");
        if (argsArr == null) { call.reject("args required"); return; }
        String[] args;
        try {
            List<Object> list = argsArr.toList();
            args = new String[list.size()];
            for (int i = 0; i < list.size(); i++) args[i] = String.valueOf(list.get(i));
        } catch (Exception e) {
            call.reject("bad args: " + e.getMessage());
            return;
        }

        FFmpegKit.executeWithArgumentsAsync(
            args,
            (FFmpegSession session) -> {
                ReturnCode rc = session.getReturnCode();
                JSObject ret = new JSObject();
                ret.put("success", ReturnCode.isSuccess(rc));
                ret.put("code", rc != null ? rc.getValue() : -1);
                if (!ReturnCode.isSuccess(rc)) {
                    String logs = session.getAllLogsAsString();
                    ret.put("log", logs != null ? logs.substring(Math.max(0, logs.length() - 4000)) : "");
                }
                call.resolve(ret);
            },
            log -> { /* per-line ffmpeg log - noisy, only the final logs above are surfaced */ },
            (Statistics stats) -> {
                JSObject progress = new JSObject();
                progress.put("timeMs", stats.getTime());
                notifyListeners("exportProgress", progress);
            }
        );
    }

    @PluginMethod
    public void saveToGallery(PluginCall call) {
        String path = call.getString("path");
        String displayName = call.getString("displayName");
        if (displayName == null) displayName = "OpenClips_export.mp4";
        if (path == null) { call.reject("path required"); return; }
        try {
            File file = new File(path);
            ContentValues values = new ContentValues();
            values.put(MediaStore.Video.Media.DISPLAY_NAME, displayName);
            values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
            values.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/OpenClips");
            values.put(MediaStore.Video.Media.IS_PENDING, 1);

            Uri collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri itemUri = getContext().getContentResolver().insert(collection, values);
            if (itemUri == null) { call.reject("MediaStore insert failed"); return; }

            try (OutputStream out = getContext().getContentResolver().openOutputStream(itemUri);
                 FileInputStream in = new FileInputStream(file)) {
                if (out == null) { call.reject("could not open output stream"); return; }
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }

            values.clear();
            values.put(MediaStore.Video.Media.IS_PENDING, 0);
            getContext().getContentResolver().update(itemUri, values, null, null);

            JSObject ret = new JSObject();
            ret.put("uri", itemUri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("saveToGallery failed: " + e.getMessage());
        }
    }
}
