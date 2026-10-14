using System.Runtime.InteropServices;
using System.Text;

namespace DesktopControl;

/// <summary>Win32 calls. The process is per-monitor DPI aware (v2), so every coordinate here is in physical pixels.</summary>
static class Native
{
    public static readonly nint PerMonitorAwareV2 = -4;

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(nint value);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor, rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    public delegate bool MonitorEnumProc(nint hMonitor, nint hdc, ref RECT rect, nint data);
    public delegate bool EnumWindowsProc(nint hwnd, nint data);

    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(nint hdc, nint clip, MonitorEnumProc callback, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(nint hMonitor, ref MONITORINFOEX info);
    [DllImport("user32.dll")] public static extern nint MonitorFromWindow(nint hwnd, uint flags);

    [DllImport("user32.dll")] public static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(nint hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, nint data);
    [DllImport("user32.dll")] public static extern nint GetWindow(nint hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(nint hwnd, int index);
    // Unlike GetWindowText, this doesn't send the window a message, so a frozen app can't stall us.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int InternalGetWindowText(nint hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(nint hwnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetWindowRect(nint hwnd, int attribute, out RECT value, int size);

    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char c);

    [DllImport("user32.dll", SetLastError = true)] public static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(nint desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(nint obj, int index, StringBuilder info, int length, out int needed);

    public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;

    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public int mouseData; public uint dwFlags, time; public nint dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public nint dwExtraInfo; }

    public static string WindowTitle(nint hwnd)
    {
        var sb = new StringBuilder(512);
        InternalGetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ProcessName(nint hwnd)
    {
        try
        {
            GetWindowThreadProcessId(hwnd, out var pid);
            using var p = System.Diagnostics.Process.GetProcessById((int)pid);
            return p.ProcessName + ".exe";
        }
        catch { return "unknown"; }
    }

    /// <summary>False when the PC is locked or a secure prompt (UAC, Ctrl+Alt+Del) is showing: nothing can be seen or clicked then.</summary>
    public static bool OnUserDesktop(out string name)
    {
        var desk = OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
        if (desk == 0) { name = "secure desktop"; return false; }
        try
        {
            var sb = new StringBuilder(256);
            GetUserObjectInformation(desk, 2 /* UOI_NAME */, sb, sb.Capacity * 2, out _);
            name = sb.ToString();
            return name.Equals("Default", StringComparison.OrdinalIgnoreCase);
        }
        finally { CloseDesktop(desk); }
    }
}
