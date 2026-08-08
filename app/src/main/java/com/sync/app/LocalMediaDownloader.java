package com.sync.app;

import android.content.Context;
import android.util.Log;

import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;

import kotlin.Unit;
import kotlin.jvm.functions.Function3;

/** yt-dlp 기반 YouTube 오디오 다운로드 */
public final class LocalMediaDownloader {

    private static final String TAG = "SYNC-DL";
    private static final AtomicBoolean INITIALIZED = new AtomicBoolean(false);
    private static final Object INIT_LOCK = new Object();

    public interface ProgressListener {
        void onProgress(int percent);
    }

    private LocalMediaDownloader() {}

    public static void ensureInitialized(Context context) throws Exception {
        if (INITIALIZED.get()) return;
        synchronized (INIT_LOCK) {
            if (INITIALIZED.get()) return;
            Context app = context.getApplicationContext();
            YoutubeDL.getInstance().init(app);
            YoutubeDL.getInstance().updateYoutubeDL(app, YoutubeDL.UpdateChannel._STABLE);
            INITIALIZED.set(true);
            Log.i(TAG, "yt-dlp initialized");
        }
    }

    public static File download(
            Context context,
            LocalMediaStore store,
            String videoId,
            ProgressListener listener) throws Exception {
        ensureInitialized(context);
        store.deleteMedia(videoId);

        String url = "https://www.youtube.com/watch?v=" + videoId;
        YoutubeDLRequest request = new YoutubeDLRequest(url);
        request.addOption("-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best");
        request.addOption("-o", store.outputTemplate(videoId));
        request.addOption("--no-playlist");
        request.addOption("--no-part");
        request.addOption("--newline");

        YoutubeDL.getInstance().execute(request, null, new Function3<Float, Long, String, Unit>() {
            @Override
            public Unit invoke(Float progress, Long etaInSeconds, String line) {
                if (listener != null) listener.onProgress(Math.round(progress));
                return Unit.INSTANCE;
            }
        });

        File file = store.findMediaFile(videoId);
        if (file == null) {
            throw new IOException("다운로드 파일을 찾을 수 없습니다");
        }
        Log.i(TAG, "saved " + videoId + " -> " + file.getName() + " (" + file.length() + " bytes)");
        return file;
    }
}
