// =====================================================================
//  校园二手交易平台 · 一键启动器
//  编译方式：见同目录 build.ps1（使用系统自带 csc.exe，无需联网、无需 SDK）
// =====================================================================
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;

internal static class Program
{
    private const string AppTitle = "校园二手交易平台 · 一键启动器";
    private const string IniFileName = "启动配置.ini";

    private static Process serverProc = null;
    private static IntPtr jobHandle = IntPtr.Zero;
    private static bool shuttingDown = false;

    // =================================================================
    //  主流程
    // =================================================================
    private static int Main(string[] args)
    {
        InitConsole();

        // 提权辅助模式：只负责启动 MySQL 服务，然后退出
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], "--start-mysql-only", StringComparison.OrdinalIgnoreCase))
                return MySqlHelperMain();
        }

        string exeDir = ExeDirectory();
        Config cfg = Config.Load(Path.Combine(exeDir, IniFileName), exeDir);

        PrintBanner(cfg);

        if (!File.Exists(Path.Combine(cfg.ProjectDir, "manage.py")))
        {
            PrintFail("项目目录无效，找不到 manage.py：" + cfg.ProjectDir);
            PrintHint("请把本启动器放在项目根目录（与 manage.py 同级），");
            PrintHint("或在 " + IniFileName + " 中修改 ProjectDir 指向项目路径。");
            return Finish(1, cfg);
        }

        // ---------------- [1/4] Python ----------------
        Step(1, 4, "检查 Python 运行环境");
        string python = FindPython(cfg);
        if (python == null)
        {
            PrintFail("没有找到可用的 Python 解释器");
            PrintHint("期望位置：" + Path.Combine(cfg.ProjectDir, @"venv\Scripts\python.exe"));
            PrintHint("请在项目目录执行：python -m venv venv");
            PrintHint("然后执行：venv\\Scripts\\pip install django mysqlclient pillow");
            return Finish(1, cfg);
        }
        PrintOk("Python", python);

        // ---------------- [2/4] MySQL ----------------
        Step(2, 4, "检查 MySQL 数据库服务");
        if (!EnsureMySql(cfg))
        {
            PrintHint("排查顺序：");
            PrintHint("1. 本机是否安装 MySQL，服务名是否为 " + cfg.MySqlService + "；");
            PrintHint("2. 手动打开服务窗口启动 " + cfg.MySqlService + "，再重新运行本启动器；");
            PrintHint("3. settings.py 中的数据库地址端口是否为 " + cfg.MySqlHost + ":" + cfg.MySqlPort + "；");
            PrintHint("4. 数据库 campus_trade 是否已创建，账号密码是否正确。");
            return Finish(1, cfg);
        }

        // ---------------- [3/4] 数据库迁移 ----------------
        if (cfg.AutoMigrate)
        {
            Step(3, 4, "同步数据库结构（manage.py migrate）");
            if (!RunManage(python, cfg, "migrate --noinput"))
            {
                PrintFail("数据库迁移失败，服务无法正常启动");
                PrintHint("提示 Unknown database -> 先执行：CREATE DATABASE campus_trade DEFAULT CHARACTER SET utf8mb4;");
                PrintHint("提示 Access denied    -> 检查 settings.py 里的 USER / PASSWORD");
                PrintHint("提示 Can not connect  -> 检查 MySQL 是否已启动、端口是否为 " + cfg.MySqlPort);
                return Finish(1, cfg);
            }
            PrintOk("数据库结构", "已是最新");
        }
        else
        {
            Step(3, 4, "同步数据库结构");
            PrintInfo("配置中已关闭自动迁移，跳过 migrate");
        }

        // ---------------- [4/4] 启动服务 ----------------
        Step(4, 4, "启动 Django 开发服务器");
        return StartAndRun(python, cfg);
    }

    // =================================================================
    //  启动服务器并驻留
    // =================================================================
    private static int StartAndRun(string python, Config cfg)
    {
        int port = cfg.Port;
        string probeHost = ProbeHost(cfg.Host);

        if (IsTcpOpen(probeHost, port, 400))
        {
            string existUrl = BuildUrl(cfg.Host, port);

            string occupant;
            bool isOurs;
            bool gotResponse;
            ProbeHttp(existUrl, out occupant, out isOurs, out gotResponse);

            // 只有当端口上确实是本平台时，才认为是已经启动
            if (isOurs)
            {
                PrintOk("服务", "端口 " + port + " 上已有本平台在运行，直接打开浏览器");
                if (cfg.OpenBrowser) OpenBrowser(existUrl);
                Console.WriteLine();
                PrintInfo("无需重复启动。关闭本窗口即可（服务器仍在后台运行）。");
                return Finish(0, cfg);
            }

            // 端口被别的程序占用：说明占用者是谁，然后自动换端口
            if (occupant.Length > 0)
                PrintInfo("端口 " + port + " 被其它程序占用（" + occupant + "）");
            else
                PrintInfo("端口 " + port + " 被其它程序占用");

            int alt = FindFreePort(probeHost, port + 1, 20);
            if (alt <= 0)
            {
                PrintFail("端口 " + port + " 已被占用，且后续 20 个端口也不可用");
                return Finish(1, cfg);
            }
            PrintInfo("自动改用端口 " + alt);
            port = alt;
        }

        string url = BuildUrl(cfg.Host, port);

        CreateKillOnCloseJob();

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = python;
        psi.Arguments = "manage.py runserver " + cfg.Host + ":" + port + (cfg.Reload ? "" : " --noreload");
        psi.WorkingDirectory = cfg.ProjectDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = false;
        psi.EnvironmentVariables["PYTHONUTF8"] = "1";
        psi.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        if (cfg.SettingsModule != null && cfg.SettingsModule.Length > 0)
            psi.EnvironmentVariables["DJANGO_SETTINGS_MODULE"] = cfg.SettingsModule;

        try
        {
            serverProc = Process.Start(psi);
        }
        catch (Exception ex)
        {
            PrintFail("无法启动 Python 进程：" + ex.Message);
            return Finish(1, cfg);
        }

        if (serverProc == null)
        {
            PrintFail("无法启动 Python 进程");
            return Finish(1, cfg);
        }

        if (jobHandle != IntPtr.Zero)
        {
            try { AssignProcessToJobObject(jobHandle, serverProc.Handle); }
            catch (Exception) { }
        }

        Console.CancelKeyPress += OnCancelKeyPress;
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;

        PrintInfo("正在等待服务就绪 ...");
        DateTime deadline = DateTime.Now.AddSeconds(60);
        bool ready = false;
        while (DateTime.Now < deadline)
        {
            if (IsHttpAlive(url, 1500)) { ready = true; break; }
            if (serverProc.HasExited) break;
            Thread.Sleep(300);
        }

        if (!ready)
        {
            if (serverProc.HasExited)
            {
                PrintFail("服务进程已退出，退出码 " + serverProc.ExitCode + "，请查看上方日志");
                return Finish(1, cfg);
            }
            PrintFail("60 秒内未检测到服务响应，请查看上方日志");
            StopServer();
            return Finish(1, cfg);
        }

        PrintOk("服务", "已启动 " + url);
        if (cfg.OpenBrowser) OpenBrowser(url);
        PrintReadyPanel(url);

        serverProc.WaitForExit();

        int code = serverProc.ExitCode;
        if (!shuttingDown)
        {
            PrintInfo("服务进程已退出，退出码 " + code);
            if (code == 0) return Finish(0, cfg);
            return Finish(code, cfg);
        }
        return 0;
    }

    // =================================================================
    //  MySQL 检查 / 启动
    // =================================================================
    private static bool EnsureMySql(Config cfg)
    {
        string addr = cfg.MySqlHost + ":" + cfg.MySqlPort;

        if (IsTcpOpen(cfg.MySqlHost, cfg.MySqlPort, 800))
        {
            PrintOk("MySQL", addr + " 连接正常");
            return true;
        }

        if (!cfg.AutoStartMySql)
        {
            PrintFail("MySQL 未运行（配置中已关闭自动启动）");
            return false;
        }

        if (!ServiceExists(cfg.MySqlService))
        {
            PrintFail("本机没有名为 " + cfg.MySqlService + " 的 Windows 服务");
            return false;
        }

        PrintInfo("MySQL 未运行，正在启动服务 " + cfg.MySqlService + " ...");

        bool started = false;
        bool cancelled = false;
        if (IsAdministrator())
        {
            started = StartServiceByName(cfg.MySqlService);
        }
        else if (cfg.AutoElevate)
        {
            PrintInfo("启动系统服务需要管理员权限，正在弹出 UAC 提权窗口，请点击 [是] ...");
            started = RunElevatedMySqlHelper();
            if (!started)
            {
                cancelled = true;
                PrintInfo("提权被取消或失败，无法自动启动 MySQL ...");
            }
        }
        else
        {
            PrintFail("当前进程不是管理员，无法启动系统服务（配置中已关闭自动提权）");
            return false;
        }

        // 提权被取消时不必长时间空等
        int waitMs = started ? 90000 : 3000;
        bool up = WaitFor(delegate() { return IsTcpOpen(cfg.MySqlHost, cfg.MySqlPort, 500); }, waitMs);
        if (up)
        {
            PrintOk("MySQL", "已启动并监听 " + addr);
            return true;
        }

        if (cancelled)
            PrintFail("没有获得管理员权限，MySQL 服务未被启动");
        else
            PrintFail("MySQL 服务在 90 秒内仍未监听 " + addr);
        return false;
    }

    // 提权辅助进程入口：只启动 MySQL 服务
    private static int MySqlHelperMain()
    {
        string exeDir = ExeDirectory();
        Config cfg = Config.Load(Path.Combine(exeDir, IniFileName), exeDir);
        Console.Title = "启动 MySQL 服务 - " + cfg.MySqlService;

        Console.WriteLine("正在启动 MySQL 服务：" + cfg.MySqlService + " ...");
        bool ok = StartServiceByName(cfg.MySqlService);
        if (ok)
            ok = WaitFor(delegate() { return IsTcpOpen(cfg.MySqlHost, cfg.MySqlPort, 500); }, 90000);

        if (ok)
        {
            Console.WriteLine("MySQL 已就绪，本窗口即将自动关闭。");
            Thread.Sleep(1200);
            return 0;
        }

        Console.WriteLine("MySQL 启动失败，请手动在服务窗口中启动 " + cfg.MySqlService + "。");
        Thread.Sleep(3500);
        return 1;
    }

    private static bool RunElevatedMySqlHelper()
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = ExePath();
            psi.Arguments = "--start-mysql-only";
            psi.WorkingDirectory = ExeDirectory();
            psi.UseShellExecute = true;
            psi.Verb = "runas";

            Process p = Process.Start(psi);
            if (p == null) return false;
            p.WaitForExit();
            return p.ExitCode == 0;
        }
        catch (Exception)
        {
            return false; // 用户取消了 UAC
        }
    }

    private static bool StartServiceByName(string name)
    {
        try
        {
            ServiceController sc = new ServiceController(name);
            ServiceControllerStatus st = sc.Status;
            if (st == ServiceControllerStatus.Running) { sc.Close(); return true; }
            if (st == ServiceControllerStatus.StartPending)
            {
                sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(60));
                sc.Close();
                return true;
            }
            sc.Start();
            sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(60));
            sc.Close();
            return true;
        }
        catch (Exception ex)
        {
            PrintInfo("启动服务失败：" + ex.Message);
            return false;
        }
    }

    private static bool ServiceExists(string name)
    {
        try
        {
            ServiceController sc = new ServiceController(name);
            ServiceControllerStatus st = sc.Status; // 权限不足时会抛异常
            sc.Close();
            return true;
        }
        catch (Exception) { }

        // ServiceController 无法区分 服务不存在 与 无权限，用 sc.exe 退出码判断
        int code = RunCaptured("sc.exe", "query " + Quote(name), 8000);
        return code != 1060; // 1060 = 指定的服务未安装
    }

    // =================================================================
    //  进程 / 环境
    // =================================================================
    private static bool RunManage(string python, Config cfg, string extraArgs)
    {
        ProcessStartInfo psi = BuildPythonStartInfo(python, cfg, "manage.py " + extraArgs);
        try
        {
            Process p = Process.Start(psi); // 直接继承控制台，Django 日志实时可见
            if (p == null) return false;
            p.WaitForExit();
            return p.ExitCode == 0;
        }
        catch (Exception ex)
        {
            PrintFail("执行失败：" + ex.Message);
            return false;
        }
    }

    private static ProcessStartInfo BuildPythonStartInfo(string python, Config cfg, string args)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = python;
        psi.Arguments = args;
        psi.WorkingDirectory = cfg.ProjectDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = false;
        psi.EnvironmentVariables["PYTHONUTF8"] = "1";
        psi.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        if (cfg.SettingsModule != null && cfg.SettingsModule.Length > 0)
            psi.EnvironmentVariables["DJANGO_SETTINGS_MODULE"] = cfg.SettingsModule;
        return psi;
    }

    private static string FindPython(Config cfg)
    {
        if (cfg.PythonPath != null && cfg.PythonPath.Length > 0)
        {
            string p = cfg.PythonPath;
            if (!Path.IsPathRooted(p)) p = Path.Combine(cfg.ProjectDir, p);
            if (File.Exists(p)) return p;
        }

        string[] candidates = new string[]
        {
            Path.Combine(cfg.ProjectDir, @"venv\Scripts\python.exe"),
            Path.Combine(cfg.ProjectDir, @".venv\Scripts\python.exe"),
            Path.Combine(cfg.ProjectDir, @"env\Scripts\python.exe")
        };
        for (int i = 0; i < candidates.Length; i++)
            if (File.Exists(candidates[i])) return candidates[i];

        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (pathVar != null)
        {
            string[] dirs = pathVar.Split(';');
            for (int i = 0; i < dirs.Length; i++)
            {
                string d = dirs[i].Trim();
                if (d.Length == 0) continue;
                try
                {
                    string c = Path.Combine(d, "python.exe");
                    if (File.Exists(c)) return c;
                }
                catch (Exception) { }
            }
        }
        return null;
    }

    private static int RunCaptured(string exe, string args, int timeoutMs)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = args;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            Process p = Process.Start(psi);
            if (p == null) return -1;
            p.StandardOutput.ReadToEnd();
            p.StandardError.ReadToEnd();
            if (!p.WaitForExit(timeoutMs))
            {
                try { p.Kill(); } catch (Exception) { }
                return -1;
            }
            return p.ExitCode;
        }
        catch (Exception)
        {
            return -1;
        }
    }

    private static void StopServer()
    {
        shuttingDown = true;
        if (serverProc == null) return;
        try
        {
            if (serverProc.HasExited) return;
            // 用 taskkill 连同子进程一起结束（Reload 模式下 runserver 会有子进程）
            ProcessStartInfo psi = new ProcessStartInfo("taskkill.exe",
                "/PID " + serverProc.Id + " /T /F");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
            serverProc.WaitForExit(5000);
        }
        catch (Exception) { }
    }

    private static void OnCancelKeyPress(object sender, ConsoleCancelEventArgs e)
    {
        e.Cancel = true; // 由我们自己收尾
        if (shuttingDown) return;
        Console.WriteLine();
        PrintInfo("正在停止服务 ...");
        StopServer();
    }

    private static void OnProcessExit(object sender, EventArgs e)
    {
        StopServer();
    }

    // =================================================================
    //  网络探测 / 浏览器
    // =================================================================
    private static bool IsTcpOpen(string host, int port, int timeoutMs)
    {
        TcpClient client = new TcpClient();
        try
        {
            IAsyncResult ar = client.BeginConnect(host, port, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(timeoutMs, false)) return false;
            try { client.EndConnect(ar); }
            catch (Exception) { return false; }
            return client.Connected;
        }
        catch (Exception)
        {
            return false;
        }
        finally
        {
            try { client.Close(); } catch (Exception) { }
        }
    }

    // 探测端口上到底是什么：返回可读描述、是否为本平台、是否拿到了 HTTP 响应
    private static void ProbeHttp(string url, out string description, out bool isCampusTrade, out bool gotResponse)
    {
        description = "";
        isCampusTrade = false;
        gotResponse = false;
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = 2500;
            req.AllowAutoRedirect = false;
            req.KeepAlive = false;
            req.Proxy = null;
            req.UserAgent = "CampusTradeLauncher";
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            {
                gotResponse = true;
                InspectResponse(resp, ref description, ref isCampusTrade);
            }
        }
        catch (WebException wex)
        {
            if (wex.Response != null)
            {
                gotResponse = true;
                using (HttpWebResponse resp = (HttpWebResponse)wex.Response)
                {
                    InspectResponse(resp, ref description, ref isCampusTrade);
                }
            }
            else
            {
                description = "不是 HTTP 服务";
            }
        }
        catch (Exception ex)
        {
            description = ex.GetType().Name;
        }
    }

    private static void InspectResponse(HttpWebResponse resp, ref string description, ref bool isCampusTrade)
    {
        int status = (int)resp.StatusCode;
        string server = resp.Headers["Server"];
        description = "HTTP " + status + (string.IsNullOrEmpty(server) ? "" : " / " + server);

        // Django 开发服务器会带 Server: WSGIServer/...
        if (!string.IsNullOrEmpty(server) &&
            server.IndexOf("WSGIServer", StringComparison.OrdinalIgnoreCase) >= 0)
            isCampusTrade = true;

        try
        {
            Stream st = resp.GetResponseStream();
            if (st != null)
            {
                byte[] buf = new byte[65536];
                int total = 0;
                int read;
                while (total < buf.Length &&
                       (read = st.Read(buf, total, buf.Length - total)) > 0)
                    total += read;

                string body = Encoding.UTF8.GetString(buf, 0, total);
                if (body.IndexOf("校园二手交易平台", StringComparison.Ordinal) >= 0)
                    isCampusTrade = true;
            }
        }
        catch (Exception) { }
    }
    private static bool IsHttpAlive(string url, int timeoutMs)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = timeoutMs;
            req.AllowAutoRedirect = false;
            req.KeepAlive = false;
            req.Proxy = null;
            req.UserAgent = "CampusTradeLauncher";
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            {
                return true;
            }
        }
        catch (WebException wex)
        {
            // 服务器返回了 4xx/5xx 也说明站点已经起来了
            return wex.Response != null;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static bool WaitFor(Func<bool> condition, int timeoutMs)
    {
        DateTime deadline = DateTime.Now.AddMilliseconds(timeoutMs);
        while (DateTime.Now < deadline)
        {
            if (condition()) return true;
            Thread.Sleep(500);
        }
        return condition();
    }

    private static int FindFreePort(string host, int start, int count)
    {
        for (int i = 0; i < count; i++)
        {
            int p = start + i;
            if (p > 65535) break;
            if (!IsTcpOpen(host, p, 250)) return p;
        }
        return -1;
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception)
        {
            try { Process.Start("cmd.exe", "/c start \"\" \"" + url + "\""); }
            catch (Exception) { }
        }
    }

    private static string ProbeHost(string host)
    {
        if (host == "0.0.0.0" || host == "*" || host == "::" || host == "[::]") return "127.0.0.1";
        return host;
    }

    private static string BuildUrl(string host, int port)
    {
        return "http://" + ProbeHost(host) + ":" + port + "/";
    }

    private static bool IsAdministrator()
    {
        try
        {
            WindowsIdentity id = WindowsIdentity.GetCurrent();
            WindowsPrincipal p = new WindowsPrincipal(id);
            return p.IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static string Quote(string s)
    {
        return "\"" + s + "\"";
    }

    // =================================================================
    //  控制台 / Job 对象（父进程退出时自动结束子进程）
    // =================================================================
    private static void InitConsole()
    {
        try { SetConsoleOutputCP(65001); } catch (Exception) { }
        try { SetConsoleCP(65001); } catch (Exception) { }
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch (Exception) { }
        try { Console.Title = AppTitle; } catch (Exception) { }
        try { Console.Clear(); } catch (Exception) { }
    }

    private static void CreateKillOnCloseJob()
    {
        try
        {
            jobHandle = CreateJobObject(IntPtr.Zero, null);
            if (jobHandle == IntPtr.Zero) return;

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr p = Marshal.AllocHGlobal(len);
            try
            {
                Marshal.StructureToPtr(info, p, false);
                SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, p, (uint)len);
            }
            finally
            {
                Marshal.FreeHGlobal(p);
            }
        }
        catch (Exception)
        {
            jobHandle = IntPtr.Zero;
        }
    }

    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize;
        public IntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public IntPtr ProcessMemoryLimit;
        public IntPtr JobMemoryLimit;
        public IntPtr PeakProcessMemoryUsed;
        public IntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
    private static extern bool SetConsoleOutputCP(uint wCodePageID);

    [DllImport("kernel32.dll")]
    private static extern bool SetConsoleCP(uint wCodePageID);

    // =================================================================
    //  路径
    // =================================================================
    private static string ExePath()
    {
        try
        {
            string p = Assembly.GetExecutingAssembly().Location;
            if (p != null && p.Length > 0 && File.Exists(p)) return p;
        }
        catch (Exception) { }
        try
        {
            return Process.GetCurrentProcess().MainModule.FileName;
        }
        catch (Exception)
        {
            return Environment.CurrentDirectory;
        }
    }

    private static string ExeDirectory()
    {
        try
        {
            string dir = Path.GetDirectoryName(ExePath());
            if (dir != null && dir.Length > 0) return dir;
        }
        catch (Exception) { }
        return Environment.CurrentDirectory;
    }

    // =================================================================
    //  控制台输出
    // =================================================================
    private static void PrintBanner(Config cfg)
    {
        WriteColor("============================================================", ConsoleColor.DarkCyan);
        WriteColor("        校园二手交易平台  ·  一键启动器", ConsoleColor.Cyan);
        WriteColor("        Campus Trade  ·  Django Launcher", ConsoleColor.DarkGray);
        WriteColor("============================================================", ConsoleColor.DarkCyan);
        Console.WriteLine("  项目目录 : " + cfg.ProjectDir);
        Console.WriteLine("  访问地址 : " + BuildUrl(cfg.Host, cfg.Port));
        Console.WriteLine("  数据库   : MySQL " + cfg.MySqlHost + ":" + cfg.MySqlPort + "  (服务 " + cfg.MySqlService + ")");
    }

    private static void Step(int index, int total, string title)
    {
        Console.WriteLine();
        WriteColor("[" + index + "/" + total + "] " + title, ConsoleColor.Cyan);
    }

    private static void PrintOk(string tag, string message)
    {
        PrintLine("  [OK] ", ConsoleColor.Green, tag + " : " + message);
    }

    private static void PrintFail(string message)
    {
        PrintLine("  [失败] ", ConsoleColor.Red, message);
    }

    private static void PrintInfo(string message)
    {
        PrintLine("  [..] ", ConsoleColor.DarkGray, message);
    }

    private static void PrintHint(string message)
    {
        PrintLine("        - ", ConsoleColor.DarkYellow, message);
    }

    private static void PrintReadyPanel(string url)
    {
        Console.WriteLine();
        WriteColor("============================================================", ConsoleColor.Green);
        WriteColor("   校园二手交易平台已经启动", ConsoleColor.Green);
        Console.WriteLine("   访问地址   : " + url);
        Console.WriteLine("   管理员后台 : " + url + "admin/");
        Console.WriteLine("   停止服务   : 在本窗口按 Ctrl+C，或直接关闭本窗口");
        WriteColor("============================================================", ConsoleColor.Green);
        Console.WriteLine();
        WriteColor("  以下是服务器实时日志：", ConsoleColor.DarkGray);
        Console.WriteLine();
    }

    private static void PrintLine(string prefix, ConsoleColor color, string message)
    {
        ConsoleColor old = Console.ForegroundColor;
        try { Console.ForegroundColor = color; } catch (Exception) { }
        try { Console.Write(prefix); } catch (Exception) { }
        try { Console.ForegroundColor = old; } catch (Exception) { }
        Console.WriteLine(message);
    }
    private static void WriteColor(string text, ConsoleColor color)
    {
        ConsoleColor old = Console.ForegroundColor;
        try { Console.ForegroundColor = color; } catch (Exception) { }
        Console.WriteLine(text);
        try { Console.ForegroundColor = old; } catch (Exception) { }
    }

    private static void Pause()
    {
        try
        {
            Console.WriteLine();
            WriteColor("  按任意键关闭本窗口 ...", ConsoleColor.DarkGray);
            Console.ReadKey(true);
        }
        catch (Exception) { }
    }

    private static int Finish(int code, Config cfg)
    {
        Console.WriteLine();
        if (code == 0)
            WriteColor("  === 一切正常，窗口可以安全关闭 ===", ConsoleColor.DarkGray);
        else
        {
            WriteColor("  === 启动未成功（错误码 " + code + "）===", ConsoleColor.Red);
            if (cfg == null || cfg.WaitOnExit) Pause();
        }
        return code;
    }

    // =================================================================
    //  配置（可选）：与 exe 同目录的 启动配置.ini
    // =================================================================
    private sealed class Config
    {
        public string ProjectDir = "";
        public string Host = "127.0.0.1";
        public int Port = 8080;
        public string PythonPath = "";
        public string SettingsModule = "campus_trade.settings";
        public string MySqlHost = "127.0.0.1";
        public int MySqlPort = 3306;
        public string MySqlService = "MySQL97";
        public bool AutoStartMySql = true;
        public bool AutoElevate = true;
        public bool AutoMigrate = true;
        public bool OpenBrowser = true;
        public bool Reload = false;
        public bool WaitOnExit = true;

        public static Config Load(string iniPath, string exeDir)
        {
            Config c = new Config();
            Dictionary<string, string> map = ReadIni(iniPath);

            c.ProjectDir = GetStr(map, "ProjectDir", exeDir);
            c.Host = GetStr(map, "Host", c.Host);
            c.Port = GetInt(map, "Port", c.Port);
            c.PythonPath = GetStr(map, "PythonPath", "");
            c.SettingsModule = GetStr(map, "SettingsModule", c.SettingsModule);
            c.MySqlHost = GetStr(map, "MySqlHost", c.MySqlHost);
            c.MySqlPort = GetInt(map, "MySqlPort", c.MySqlPort);
            c.MySqlService = GetStr(map, "MySqlService", c.MySqlService);
            c.AutoStartMySql = GetBool(map, "AutoStartMySql", c.AutoStartMySql);
            c.AutoElevate = GetBool(map, "AutoElevate", c.AutoElevate);
            c.AutoMigrate = GetBool(map, "AutoMigrate", c.AutoMigrate);
            c.OpenBrowser = GetBool(map, "OpenBrowser", c.OpenBrowser);
            c.Reload = GetBool(map, "Reload", c.Reload);
            c.WaitOnExit = GetBool(map, "WaitOnExit", c.WaitOnExit);

            if (c.ProjectDir == null || c.ProjectDir.Length == 0) c.ProjectDir = exeDir;
            if (!Path.IsPathRooted(c.ProjectDir))
                c.ProjectDir = Path.GetFullPath(Path.Combine(exeDir, c.ProjectDir));

            WriteDefaultIfMissing(iniPath, c);
            return c;
        }
    }

    private static Dictionary<string, string> ReadIni(string path)
    {
        Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (!File.Exists(path)) return map;
            string[] lines = File.ReadAllLines(path, Encoding.UTF8);
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length == 0) continue;
                if (line[0] == '#' || line[0] == ';' || line[0] == '[') continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim();
                string val = line.Substring(eq + 1).Trim();
                if (val.Length >= 2)
                {
                    char a = val[0];
                    char b = val[val.Length - 1];
                    if ((a == '"' && b == '"') || (a == '\'' && b == '\''))
                        val = val.Substring(1, val.Length - 2);
                }
                map[key] = val;
            }
        }
        catch (Exception) { }
        return map;
    }

    private static string GetStr(Dictionary<string, string> map, string key, string def)
    {
        string v;
        if (map.TryGetValue(key, out v) && v.Length > 0) return v;
        return def;
    }

    private static int GetInt(Dictionary<string, string> map, string key, int def)
    {
        string v;
        if (map.TryGetValue(key, out v))
        {
            int n;
            if (int.TryParse(v, out n)) return n;
        }
        return def;
    }

    private static bool GetBool(Dictionary<string, string> map, string key, bool def)
    {
        string v;
        if (!map.TryGetValue(key, out v)) return def;
        v = v.Trim().ToLowerInvariant();
        if (v == "1" || v == "true" || v == "yes" || v == "on" || v == "y") return true;
        if (v == "0" || v == "false" || v == "no" || v == "off" || v == "n") return false;
        return def;
    }

    private static void WriteDefaultIfMissing(string iniPath, Config cfg)
    {
        try
        {
            if (File.Exists(iniPath)) return;
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("# 校园二手交易平台 一键启动器 配置文件");
            sb.AppendLine("# 全部为可选配置，删除本文件会使用默认值自动重建。");
            sb.AppendLine();
            sb.AppendLine("# 项目根目录（默认：启动器所在目录）");
            sb.AppendLine("ProjectDir=");
            sb.AppendLine();
            sb.AppendLine("# Django 服务监听地址与端口");
            sb.AppendLine("Host=127.0.0.1");
            sb.AppendLine("Port=8080");
            sb.AppendLine();
            sb.AppendLine("# Python 解释器路径（默认自动查找 venv、.venv、env 或 PATH）");
            sb.AppendLine("PythonPath=");
            sb.AppendLine();
            sb.AppendLine("# Django settings 模块（默认 campus_trade.settings）");
            sb.AppendLine("SettingsModule=campus_trade.settings");
            sb.AppendLine();
            sb.AppendLine("# MySQL 连接信息与服务名（需与 campus_trade/settings.py 保持一致）");
            sb.AppendLine("MySqlHost=127.0.0.1");
            sb.AppendLine("MySqlPort=3306");
            sb.AppendLine("MySqlService=MySQL97");
            sb.AppendLine();
            sb.AppendLine("# 启动时若 MySQL 未运行，是否自动启动（需要管理员权限，会弹 UAC）");
            sb.AppendLine("AutoStartMySql=true");
            sb.AppendLine("# 是否允许自动提权（弹 UAC 启动 MySQL 服务）");
            sb.AppendLine("AutoElevate=true");
            sb.AppendLine();
            sb.AppendLine("# 启动前是否自动执行 manage.py migrate");
            sb.AppendLine("AutoMigrate=true");
            sb.AppendLine("# 服务就绪后是否自动打开浏览器");
            sb.AppendLine("OpenBrowser=true");
            sb.AppendLine("# 是否开启代码热重载（调试用，默认关闭更稳定）");
            sb.AppendLine("Reload=false");
            sb.AppendLine("# 出错时是否停留等待按键");
            sb.AppendLine("WaitOnExit=true");
            File.WriteAllText(iniPath, sb.ToString(), new UTF8Encoding(true));
        }
        catch (Exception) { }
    }
}
