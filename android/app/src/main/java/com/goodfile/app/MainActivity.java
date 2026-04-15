package com.goodfile.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FileServerPlugin.class);
        registerPlugin(DownloadPlugin.class);
        super.onCreate(savedInstanceState);
    }
}