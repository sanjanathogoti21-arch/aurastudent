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
