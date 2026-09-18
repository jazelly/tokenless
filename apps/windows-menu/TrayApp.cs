using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TokenlessApi.WindowsMenu
{
    internal static class Program
    {
        internal const string InstanceName = @"Local\TokenlessApi.WindowsMenu";
        internal static string ExitPipeName { get { return "TokenlessApi.WindowsMenu.Control." + Process.GetCurrentProcess().SessionId; } }

        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Contains("--exit"))
            {
                SignalExistingTrayExit();
                RequestExistingTrayExit();
                return;
            }
            bool created;
            using (var mutex = new Mutex(true, InstanceName, out created))
            {
                if (!created) return;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try { using (var app = new TrayApp()) Application.Run(app); }
                catch { MessageBox.Show("Could not start Tokenless API. Rebuild the Windows tray app.\n无法启动 Tokenless API，请重新构建 Windows 托盘应用。", "Tokenless API", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            }
        }

        private static void RequestExistingTrayExit()
        {
            using (var current = Process.GetCurrentProcess())
            {
                foreach (var process in Process.GetProcessesByName("TokenlessApiTray"))
                {
                    try
                    {
                        if (process.Id == current.Id || process.SessionId != current.SessionId) continue;
                        if (!process.WaitForExit(5000))
                        {
                            process.Kill();
                            process.WaitForExit(2000);
                        }
                    }
                    catch { }
                    finally { process.Dispose(); }
                }
            }
        }

        private static void SignalExistingTrayExit()
        {
            try
            {
                using (var pipe = new NamedPipeClientStream(".", ExitPipeName, PipeDirection.InOut, PipeOptions.None))
                {
                    pipe.Connect(1000);
                    pipe.WriteByte(1);
                    pipe.Flush();
                    pipe.ReadByte();
                }
            }
            catch (IOException) { }
            catch (TimeoutException) { }
        }
    }

    internal sealed class TrayApp : ApplicationContext
    {
        private readonly NotifyIcon tray;
        private readonly ContextMenuStrip menu = new ContextMenuStrip();
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        private readonly NamedPipeServerStream exitPipe;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly HashSet<Process> activeProcesses = new HashSet<Process>();
        private readonly object processLock = new object();
        private readonly string home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".tokenless");
        private readonly string node;
        private readonly string cli;
        private readonly uint uiThreadId;
        private Dictionary<string, object> snapshot;
        private ToolStripMenuItem statusItem;
        private ToolStripMenuItem activityItem;
        private ToolStripMenuItem profilesItem;
        private bool chinese;
        private bool busy;
        private bool refreshing;
        private bool failed;
        private bool closing;
        private bool initialRefreshAttempted;
        private bool iconUsesLightInk;
        private DateTime lastRefresh = DateTime.MinValue;
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunName = "Tokenless API";

        [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr handle);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", SetLastError = true)] private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);

        internal TrayApp()
        {
            var binding = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "runtime.json")));
            node = Convert.ToString(binding["node"]);
            cli = Convert.ToString(binding["cli"]);
            if (!Path.IsPathRooted(node) || !Path.IsPathRooted(cli) || !File.Exists(node) || !File.Exists(cli)) throw new IOException();
            uiThreadId = GetCurrentThreadId();
            ReadLanguage();
            iconUsesLightInk = ShouldUseLightInk();
            tray = new NotifyIcon { Icon = LoadTrayIcon(iconUsesLightInk), Text = "Tokenless API", ContextMenuStrip = menu, Visible = true };
            tray.MouseClick += async (sender, e) => { if (e.Button == MouseButtons.Left) await Perform(OpenDashboard, Text("Open dashboard", "打开 Dashboard")); };
            menu.Opening += (sender, e) =>
            {
                BuildMenu();
                if (!busy && (!initialRefreshAttempted || DateTime.UtcNow - lastRefresh > TimeSpan.FromSeconds(30)))
                {
                    initialRefreshAttempted = true;
                    BeginRefresh();
                }
            };
            // Create the UI handle before asynchronous continuations are scheduled.
            var unused = menu.Handle;
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
            exitPipe = new NamedPipeServerStream(Program.ExitPipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            Task.Run(() => ListenForExit());
            BuildMenu();
            timer.Interval = 500;
            timer.Tick += (sender, e) =>
            {
                UpdateThemeIcon();
                if (!busy && !initialRefreshAttempted && !menu.Visible)
                {
                    initialRefreshAttempted = true;
                    BeginRefresh();
                }
            };
            timer.Start();
        }

        private void ListenForExit()
        {
            try
            {
                exitPipe.WaitForConnection();
                if (exitPipe.ReadByte() != 1) return;
                try
                {
                    exitPipe.WriteByte((byte)(PostThreadMessage(uiThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero) ? 1 : 0));
                    exitPipe.Flush();
                }
                catch (IOException) { }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }

        private string Text(string en, string zh) { return chinese ? zh : en; }

        private void ReadLanguage()
        {
            var systemLanguage = ReadSystemLanguage();
            if (!String.IsNullOrEmpty(systemLanguage))
            {
                chinese = systemLanguage.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
                return;
            }
            try
            {
                var config = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(home, "config.json")));
                object language;
                chinese = config.TryGetValue("language", out language) && Convert.ToString(language).StartsWith("zh", StringComparison.OrdinalIgnoreCase);
            }
            catch { chinese = System.Globalization.CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase); }
        }

        private static string ReadSystemLanguage()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop"))
                {
                    var value = key == null ? null : key.GetValue("PreferredUILanguages");
                    var languages = value as string[];
                    if (languages != null) return languages.FirstOrDefault(language => !String.IsNullOrWhiteSpace(language));
                    return value as string;
                }
            }
            catch { return null; }
        }

        private static bool ShouldUseLightInk()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    var value = key == null ? null : key.GetValue("SystemUsesLightTheme") ?? key.GetValue("AppsUseLightTheme");
                    if (value != null) return Convert.ToInt32(value) == 0;
                }
            }
            catch { }
            var control = SystemColors.Control;
            var luminance = (control.R * 299 + control.G * 587 + control.B * 114) / 1000;
            return luminance < 128;
        }

        private static Icon LoadTrayIcon(bool lightInk)
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("tokenless-mark.png"))
            using (var source = new Bitmap(stream))
            using (var tinted = new Bitmap(source.Width, source.Height))
            using (var scaled = new Bitmap(32, 32))
            {
                var ink = lightInk ? Color.FromArgb(248, 248, 248) : Color.FromArgb(24, 24, 24);
                for (var x = 0; x < source.Width; x++)
                {
                    for (var y = 0; y < source.Height; y++)
                    {
                        var pixel = source.GetPixel(x, y);
                        tinted.SetPixel(x, y, Color.FromArgb(pixel.A, ink.R, ink.G, ink.B));
                    }
                }
                using (var graphics = Graphics.FromImage(scaled))
                {
                    graphics.Clear(Color.Transparent);
                    graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    graphics.DrawImage(tinted, new Rectangle(0, 0, scaled.Width, scaled.Height));
                }
                var handle = scaled.GetHicon();
                try { using (var borrowed = Icon.FromHandle(handle)) return (Icon)borrowed.Clone(); }
                finally { DestroyIcon(handle); }
            }
        }

        private void UpdateThemeIcon()
        {
            var lightInk = ShouldUseLightInk();
            if (lightInk == iconUsesLightInk) return;
            var oldIcon = tray.Icon;
            tray.Icon = LoadTrayIcon(lightInk);
            iconUsesLightInk = lightInk;
            if (oldIcon != null) oldIcon.Dispose();
        }

        private void BuildMenu()
        {
            // Keep clickable items alive until the user finishes interacting.
            // An in-flight refresh updates only the stable status rows.
            if (closing || menu.Visible) return;
            ReadLanguage();
            while (menu.Items.Count > 0) { var old = menu.Items[0]; menu.Items.RemoveAt(0); old.Dispose(); }
            UpdateThemeIcon();
            statusItem = new ToolStripMenuItem(StatusLabel()) { Enabled = false };
            menu.Items.Add(statusItem);
            activityItem = new ToolStripMenuItem(ActivityLabel()) { Enabled = false };
            profilesItem = new ToolStripMenuItem(ProfileLabel()) { Enabled = false };
            menu.Items.Add(activityItem);
            menu.Items.Add(profilesItem);
            Add(menu.Items, Text("Open dashboard", "打开 Dashboard"), OpenDashboard, Text("Open dashboard", "打开 Dashboard"));
            var recent = new ToolStripMenuItem(Text("Recent conversations", "最近会话"));
            object entries;
            if (snapshot != null && snapshot.TryGetValue("conversations", out entries))
            {
                var values = entries as System.Collections.IEnumerable;
                if (values != null) foreach (var rawConversation in values)
                {
                    var conversation = rawConversation as Dictionary<string, object>;
                    if (conversation == null || String.IsNullOrWhiteSpace(ReadString(conversation, "jobId"))) continue;
                    var captured = conversation;
                    var title = ReadString(conversation, "title");
                    if (String.IsNullOrWhiteSpace(title)) title = Text("Untitled conversation", "未命名会话");
                    title = title.Replace("&", "&&");
                    if (title.Length > 70) title = title.Substring(0, 67) + "…";
                    Add(recent.DropDownItems, title, () => OpenConversation(captured), title);
                    if (recent.DropDownItems.Count >= 10) break;
                }
            }
            if (recent.DropDownItems.Count == 0) recent.DropDownItems.Add(new ToolStripMenuItem(Text("No recent conversations", "暂无最近会话")) { Enabled = false });
            menu.Items.Add(recent);
            menu.Items.Add(new ToolStripSeparator());
            Add(menu.Items, Text("Refresh status", "刷新状态"), Refresh, Text("Refresh status", "刷新状态"));
            Add(menu.Items, Text("Restart Tokenless API", "重启 Tokenless API"), Restart, Text("Restart Tokenless API", "重启 Tokenless API"));
            Add(menu.Items, Text("Check for updates", "检查更新"), CheckUpdates, Text("Check for updates", "检查更新"));
            var startup = Add(menu.Items, Text("Start at sign-in", "登录时启动"), ToggleStartup, Text("Start at sign-in", "登录时启动"));
            startup.Checked = StartupEnabled();
            menu.Items.Add(new ToolStripSeparator());
            Add(menu.Items, Text("Exit tray only", "仅退出托盘"), () => { ExitThread(); return Task.FromResult(0); }, Text("Exit tray only", "仅退出托盘"));
            Add(menu.Items, Text("Stop Tokenless API and exit", "停止 Tokenless API 并退出"), StopAndExit, Text("Stop Tokenless API and exit", "停止 Tokenless API 并退出"));
            UpdateStatusPresentation();
        }

        private string StatusLabel()
        {
            if (busy) return "Tokenless API · " + Text("Working…", "正在处理…");
            if (failed) return "Tokenless API · " + Text("Status unavailable", "状态暂不可用");
            var daemon = ReadMap(snapshot, "daemon");
            if (daemon == null) return "Tokenless API · " + Text("Starting…", "正在启动…");
            var version = ReadString(daemon, "version");
            return "Tokenless API · " + Text("Running", "运行中") + (String.IsNullOrWhiteSpace(version) ? "" : " · v" + version);
        }

        private string ActivityLabel()
        {
            if (snapshot == null) return failed ? Text("Activity unavailable", "任务状态暂不可用") : Text("Reading task status…", "正在读取任务状态…");
            var count = ReadInt(snapshot, "activeJobCount");
            return count == 0
                ? Text("No active tasks", "暂无活跃任务")
                : Text(count + " active task(s)", count + " 个活跃任务");
        }

        private string ProfileLabel()
        {
            if (snapshot == null) return failed ? Text("Browser profiles unavailable", "浏览器 Profile 状态暂不可用") : Text("Reading browser profiles…", "正在读取浏览器 Profile…");
            var runtime = ReadMap(snapshot, "runtime");
            var count = ReadInt(runtime, "activeProfileCount");
            return Text("Browser profiles · " + count + " active", "浏览器 Profile · " + count + " 个活跃");
        }

        private void UpdateStatusPresentation()
        {
            if (statusItem != null && statusItem.Owner != null) statusItem.Text = StatusLabel();
            if (activityItem != null && activityItem.Owner != null) activityItem.Text = ActivityLabel();
            if (profilesItem != null && profilesItem.Owner != null) profilesItem.Text = ProfileLabel();
            if (tray != null) tray.Text = LimitTrayText(TrayStatusText());
        }

        private string TrayStatusText()
        {
            if (busy) return "Tokenless API · " + Text("Working", "正在处理");
            if (failed) return "Tokenless API · " + Text("Status unavailable", "状态暂不可用");
            if (snapshot == null) return "Tokenless API · " + Text("Starting", "正在启动");
            var count = ReadInt(snapshot, "activeJobCount");
            return count == 0
                ? "Tokenless API · " + Text("Running", "运行中")
                : "Tokenless API · " + Text(count + " active task(s)", count + " 个活跃任务");
        }

        private static string LimitTrayText(string value) { return value.Length <= 63 ? value : value.Substring(0, 63); }
        private static Dictionary<string, object> ReadMap(Dictionary<string, object> source, string key)
        {
            if (source == null) return null;
            object value;
            return source.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }
        private static string ReadString(Dictionary<string, object> source, string key)
        {
            if (source == null) return "";
            object value;
            return source.TryGetValue(key, out value) ? Convert.ToString(value) : "";
        }
        private static int ReadInt(Dictionary<string, object> source, string key)
        {
            if (source == null) return 0;
            object value;
            if (!source.TryGetValue(key, out value)) return 0;
            try { return Math.Max(0, Convert.ToInt32(value)); }
            catch { return 0; }
        }

        private ToolStripMenuItem Add(ToolStripItemCollection items, string label, Func<Task> action, string operation)
        {
            var item = new ToolStripMenuItem(label) { Enabled = !busy };
            item.Click += async (sender, e) => await Perform(action, operation);
            items.Add(item);
            return item;
        }

        private async Task Perform(Func<Task> action, string operation)
        {
            if (busy || closing) return;
            busy = true;
            UpdateStatusPresentation();
            try { await action(); failed = false; }
            catch
            {
                failed = true;
                // Never display raw CLI output: it may contain local session data.
                if (!closing)
                {
                    var dashboardFailure = operation.IndexOf("Dashboard", StringComparison.OrdinalIgnoreCase) >= 0;
                    tray.ShowBalloonTip(5000, "Tokenless API", dashboardFailure
                        ? Text("Could not open Dashboard. Check Tokenless API with the CLI, then try again.", "无法打开 Dashboard。请通过 CLI 检查 Tokenless API，然后重试。")
                        : Text("The operation failed. Check Tokenless API with the CLI, then refresh status.", "操作失败。请通过 CLI 检查 Tokenless API，然后刷新状态。"), ToolTipIcon.Warning);
                }
            }
            finally
            {
                busy = false;
                lastRefresh = DateTime.UtcNow;
                if (!closing)
                {
                    if (menu.Visible) UpdateStatusPresentation();
                    else BuildMenu();
                }
            }
        }

        private async Task Refresh()
        {
            if (refreshing) return;
            refreshing = true;
            try { snapshot = await Invoke("menubar", "status"); }
            finally { refreshing = false; }
        }

        private async void BeginRefresh()
        {
            if (refreshing || busy || closing) return;
            refreshing = true;
            try
            {
                var retry = false;
                try { snapshot = await Invoke("menubar", "status"); }
                catch
                {
                    if (snapshot != null || closing) throw;
                    retry = true;
                }
                if (retry)
                {
                    await Task.Delay(1000);
                    if (closing) return;
                    snapshot = await Invoke("menubar", "status");
                }
                failed = false;
            }
            catch
            {
                failed = true;
                if (!closing) tray.ShowBalloonTip(5000, "Tokenless API", Text("The status could not be refreshed. Check Tokenless API with the CLI, then try again.", "无法刷新状态。请通过 CLI 检查 Tokenless API，然后重试。"), ToolTipIcon.Warning);
            }
            finally
            {
                refreshing = false;
                lastRefresh = DateTime.UtcNow;
                if (!closing)
                {
                    if (menu.Visible) UpdateStatusPresentation();
                    else BuildMenu();
                }
            }
        }
        private Task OpenDashboard() { return OpenConversation(null); }
        private async Task OpenConversation(Dictionary<string, object> conversation)
        {
            var args = new List<string> { "dashboard" };
            if (conversation != null)
            {
                var jobId = ReadString(conversation, "jobId");
                if (String.IsNullOrWhiteSpace(jobId)) throw new IOException();
                args.AddRange(new[] { "--job-id", jobId });
                var profile = ReadString(conversation, "profileSlug");
                if (!String.IsNullOrEmpty(profile)) args.AddRange(new[] { "--profile", profile });
            }
            // Let the supported CLI boundary select the user's default browser.
            // This is the same Windows path used by `tokenless dashboard`.
            await Invoke(args.ToArray());
        }

        private async Task<bool> ConfirmStop()
        {
            await Refresh();
            if (ReadInt(snapshot, "activeJobCount") == 0) return true;
            return MessageBox.Show(Text("Active tasks may be interrupted. Continue?", "当前有任务正在运行，继续会中断任务。是否继续？"), "Tokenless API", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes;
        }
        private async Task Restart()
        {
            if (!await ConfirmStop()) return;
            await Invoke("daemon", "stop");
            await Refresh();
            ShowInformation(Text("Restarted", "已重启"), Text("Tokenless API restarted successfully.", "Tokenless API 已成功重启。"));
        }
        private async Task StopAndExit() { if (await ConfirmStop()) { await Invoke("daemon", "stop"); ExitThread(); } }
        private async Task CheckUpdates()
        {
            var result = await Invoke("upgrade", "--check");
            var available = result.ContainsKey("updateAvailable") && Convert.ToBoolean(result["updateAvailable"]);
            var latest = ReadString(result, "latest");
            ShowInformation(
                available ? Text("Update available", "有可用更新") : Text("Up to date", "已是最新版本"),
                available
                    ? Text(
                        String.IsNullOrWhiteSpace(latest) ? "A new CLI version is available. Update and rebuild this source checkout." : "Tokenless API v" + latest + " is available. Update and rebuild this source checkout.",
                        String.IsNullOrWhiteSpace(latest) ? "有新的 CLI 版本可用。请更新并重新构建本地源码。" : "Tokenless API v" + latest + " 已发布。请更新并重新构建本地源码。")
                    : Text("Tokenless API is up to date.", "Tokenless API 当前已是最新版本。"));
        }

        private void ShowInformation(string title, string message)
        {
            if (!closing) tray.ShowBalloonTip(5000, title, message, ToolTipIcon.Info);
        }

        private bool StartupEnabled()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey)) return key != null && Convert.ToString(key.GetValue(RunName)) == Quote(Application.ExecutablePath);
        }
        private Task ToggleStartup()
        {
            bool enabled = StartupEnabled();
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (enabled) key.DeleteValue(RunName, false);
                else key.SetValue(RunName, Quote(Application.ExecutablePath));
            }
            ShowInformation(
                Text("Start at sign-in", "登录时启动"),
                enabled
                    ? Text("Start at sign-in disabled.", "已关闭登录时启动。")
                    : Text("Start at sign-in enabled.", "已开启登录时启动。"));
            return Task.FromResult(0);
        }

        private async Task<Dictionary<string, object>> Invoke(params string[] args)
        {
            var arguments = new[] { cli }.Concat(args).Concat(new[] { "--home", home, "--json" });
            using (var process = new Process())
            {
                try
                {
                    process.StartInfo = new ProcessStartInfo(node, String.Join(" ", arguments.Select(Quote)))
                    {
                        UseShellExecute = false, CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden,
                        RedirectStandardOutput = true, RedirectStandardError = true,
                        StandardOutputEncoding = System.Text.Encoding.UTF8,
                        StandardErrorEncoding = System.Text.Encoding.UTF8,
                        WorkingDirectory = Path.GetDirectoryName(cli)
                    };
                    process.Start();
                    lock (processLock)
                    {
                        activeProcesses.Add(process);
                        if (closing)
                        {
                            try { process.Kill(); } catch { }
                            throw new OperationCanceledException();
                        }
                    }
                    var stdout = process.StandardOutput.ReadToEndAsync();
                    var stderr = process.StandardError.ReadToEndAsync();
                    var exited = await Task.Run(() => process.WaitForExit(120000));
                    if (!exited) { process.Kill(); throw new TimeoutException(); }
                    var output = await stdout;
                    await stderr;
                    if (process.ExitCode != 0) throw new IOException();
                    var payload = json.Deserialize<Dictionary<string, object>>(output);
                    if (!payload.ContainsKey("ok") || !Convert.ToBoolean(payload["ok"])) throw new IOException();
                    return payload;
                }
                finally
                {
                    lock (processLock)
                    {
                        activeProcesses.Remove(process);
                    }
                }
            }
        }

        // Windows CommandLineToArgvW quoting, including trailing backslashes.
        private static string Quote(string value)
        {
            var result = new System.Text.StringBuilder("\"");
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

        protected override void ExitThreadCore()
        {
            PrepareExit();
            base.ExitThreadCore();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                PrepareExit();
                timer.Dispose();
                var icon = tray.Icon;
                tray.Icon = null;
                if (icon != null) icon.Dispose();
                tray.Dispose();
                menu.Dispose();
                exitPipe.Dispose();
            }
            base.Dispose(disposing);
        }

        private void PrepareExit()
        {
            if (closing) return;
            closing = true;
            timer.Stop();
            try { exitPipe.Dispose(); } catch { }
            tray.Visible = false;
            lock (processLock)
            {
                foreach (var process in activeProcesses.ToArray())
                {
                    try { if (!process.HasExited) process.Kill(); } catch { }
                }
            }
        }
    }
}
