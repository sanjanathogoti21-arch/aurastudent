// Run after `npx cap add android`. Adds permissions and the long-press "Voice task" shortcut.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, 'android', 'app', 'src', 'main');
const mf = path.join(root, 'AndroidManifest.xml');
let x = fs.readFileSync(mf, 'utf8');
const perms = ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.POST_NOTIFICATIONS', 'android.permission.VIBRATE', 'android.permission.SCHEDULE_EXACT_ALARM'];
for (const p of perms) if (!x.includes(p)) x = x.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
// shortcut meta-data on the launcher activity
if (!x.includes('android.app.shortcuts')) {
  x = x.replace(/(<category android:name="android.intent.category.LAUNCHER"\s*\/>\s*<\/intent-filter>)/, `$1\n            <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />`);
}
fs.writeFileSync(mf, x);
fs.mkdirSync(path.join(root, 'res', 'xml'), { recursive: true });
fs.writeFileSync(path.join(root, 'res', 'xml', 'shortcuts.xml'), `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <shortcut android:shortcutId="voice_task" android:enabled="true" android:shortcutShortLabel="@string/voice_task_short" android:shortcutLongLabel="@string/voice_task_long">
        <intent android:action="android.intent.action.VIEW" android:targetPackage="app.aurastudent.planner" android:targetClass="app.aurastudent.planner.MainActivity" android:data="aurastudent://voice" />
    </shortcut>
</shortcuts>
`);
// custom URL scheme so the shortcut intent reaches the app
x = fs.readFileSync(mf, 'utf8');
if (!x.includes('android:scheme="aurastudent"')) {
  x = x.replace('</activity>', `    <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="aurastudent" android:host="voice" />
            </intent-filter>
        </activity>`);
  fs.writeFileSync(mf, x);
}
const sv = path.join(root, 'res', 'values', 'strings.xml');
let s = fs.readFileSync(sv, 'utf8');
if (!s.includes('voice_task_short')) s = s.replace('</resources>', '    <string name="voice_task_short">Voice task</string>\n    <string name="voice_task_long">Add a voice task</string>\n</resources>');
fs.writeFileSync(sv, s);
console.log('Android project patched');

/* ---------- Hands-free ("Hey Aura") native part ---------- */
{
  const pkg = path.join(root, 'java', 'app', 'aurastudent', 'planner');
  fs.mkdirSync(pkg, { recursive: true });
  for (const f of fs.readdirSync(path.join(__dirname, 'handsfree'))) if (f.endsWith('.java')) fs.copyFileSync(path.join(__dirname, 'handsfree', f), path.join(pkg, f));
  // small notification icon
  fs.mkdirSync(path.join(root, 'res', 'drawable'), { recursive: true });
  const icon = path.join(__dirname, '..', 'badge-96.png');
  fs.copyFileSync(fs.existsSync(icon) ? icon : path.join(__dirname, '..', 'icon-192.png'), path.join(root, 'res', 'drawable', 'ic_stat.png'));

  let m = fs.readFileSync(mf, 'utf8');
  for (const p of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MICROPHONE', 'android.permission.WAKE_LOCK'])
    if (!m.includes(p)) m = m.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
  if (!m.includes('.ListenService'))
    m = m.replace('</application>', `    <service android:name=".ListenService" android:exported="false" android:foregroundServiceType="microphone" />
        <receiver android:name=".Reminders$ReminderReceiver" android:exported="false" />
    </application>`);
  fs.writeFileSync(mf, m);

  // app-level gradle: Vosk (offline speech) + JNA
  const ag = path.join(__dirname, 'android', 'app', 'build.gradle');
  let g = fs.readFileSync(ag, 'utf8');
  if (!g.includes('vosk-android')) g = g.replace(/dependencies\s*\{/, `dependencies {\n    implementation 'com.alphacephei:vosk-android:0.3.47'\n    implementation 'net.java.dev.jna:jna:5.13.0@aar'`);
  fs.writeFileSync(ag, g);
  // notification channels need Android 8+
  const vg = path.join(__dirname, 'android', 'variables.gradle');
  if (fs.existsSync(vg)) fs.writeFileSync(vg, fs.readFileSync(vg, 'utf8').replace(/minSdkVersion = \d+/, 'minSdkVersion = 26'));
  console.log('Hands-free native code added');
}
