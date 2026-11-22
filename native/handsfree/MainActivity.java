package app.aurastudent.planner;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HandsFreePlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new Hub.CbJs(), "AuraCb");
    }
}
