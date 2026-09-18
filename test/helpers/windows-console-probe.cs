using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A GUI host reproduces the tray's lack of a parent console. Watching both
// window classes also catches Windows Terminal, whose process is OS-brokered.
internal static class WindowsConsoleProbe
{
    private delegate void WinEvent(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
    private delegate bool EnumWindow(IntPtr hwnd, IntPtr arg);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr arg);
    private static readonly List<object> shown = new List<object>();
    private static readonly HashSet<IntPtr> seen = new HashSet<IntPtr>();
    private static readonly Stopwatch watch = Stopwatch.StartNew();
    private static WinEvent callback;

    private static void Observe(IntPtr hwnd)
    {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        var windowClass = name.ToString();
        if (windowClass != "ConsoleWindowClass" && windowClass != "CASCADIA_HOSTING_WINDOW_CLASS") return;
        if (!IsWindowVisible(hwnd) || !seen.Add(hwnd)) return;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        // Do not record window titles, command lines, or CLI output.
        shown.Add(new { milliseconds = watch.ElapsedMilliseconds, pid, windowClass });
    }

    [STAThread]
    private static int Main(string[] args)
    {
        var json = new JavaScriptSerializer();
        using (var process = new Process())
        using (var timer = new Timer { Interval = 20 })
        {
            EnumWindows((hwnd, arg) => { if (IsWindowVisible(hwnd)) seen.Add(hwnd); return true; }, IntPtr.Zero);
            callback = (hook, evt, hwnd, obj, child, thread, time) => { if (obj == 0 && child == 0) Observe(hwnd); };
            var hookHandle = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, callback, 0, 0, 0);
            if (hookHandle == IntPtr.Zero) return 2;
            try
            {
                process.StartInfo = new ProcessStartInfo(args[1], String.Join(" ", Array.ConvertAll(args, Quote), 2, args.Length - 2))
                {
                    UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    WorkingDirectory = Path.GetDirectoryName(args[2])
                };
                process.Start();
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                long exitedAt = -1;
                timer.Tick += (sender, e) =>
                {
                    EnumWindows((hwnd, arg) => { Observe(hwnd); return true; }, IntPtr.Zero);
                    if (process.HasExited && exitedAt < 0) exitedAt = watch.ElapsedMilliseconds;
                    if ((exitedAt >= 0 && watch.ElapsedMilliseconds - exitedAt > 1000) || watch.ElapsedMilliseconds > 30000)
                        Application.ExitThread();
                };
                timer.Start();
                Application.Run();
                timer.Stop();
                var timedOut = !process.HasExited;
                if (timedOut) { process.Kill(); process.WaitForExit(2000); }
                bool ok = false;
                string errorCode = null;
                int stdoutBytes = 0;
                int stderrBytes = 0;
                if (stdout.Wait(2000) && stderr.Wait(2000))
                {
                    var stdoutText = stdout.Result;
                    var stderrText = stderr.Result;
                    stdoutBytes = Encoding.UTF8.GetByteCount(stdoutText);
                    stderrBytes = Encoding.UTF8.GetByteCount(stderrText);
                    try
                    {
                        var payload = json.Deserialize<Dictionary<string, object>>(stdoutText);
                        object value;
                        if (payload.TryGetValue("ok", out value)) ok = Convert.ToBoolean(value);
                        Dictionary<string, object> error = null;
                        if (payload.TryGetValue("error", out value)) error = value as Dictionary<string, object>;
                        if (error != null && error.TryGetValue("code", out value)) errorCode = Convert.ToString(value);
                    }
                    catch { }
                }
                var exitCode = process.HasExited ? process.ExitCode : -1;
                // Report only bounded metadata. CLI output may contain local session data.
                File.WriteAllText(args[0], json.Serialize(new { exitCode, ok, timedOut, errorCode, stdoutBytes, stderrBytes, windows = shown }), new UTF8Encoding(false));
                return 0;
            }
            finally { UnhookWinEvent(hookHandle); }
        }
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
}
