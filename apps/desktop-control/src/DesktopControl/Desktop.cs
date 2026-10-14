using System.Drawing;
using System.Text;

namespace DesktopControl;

sealed record MonitorInfo(int Number, Rectangle Bounds, bool Primary);

/// <summary>What Claude last saw: the screen area, how it was scaled, and the numbered controls in it.</summary>
sealed class Snapshot
{
    public required int Id { get; init; }
    public required Rectangle Area { get; init; }
    public required double Scale { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required string Monitor { get; init; }
    public required List<UiItem> Elements { get; init; }
    public required byte[] Signature { get; init; }
    public required long ChangeMark { get; init; }
    public required DateTime Taken { get; init; }

    public Point ToScreen(double x, double y) => new((int)Math.Round(Area.X + x / Scale), (int)Math.Round(Area.Y + y / Scale));
    public Point ToImage(Point p) => new((int)Math.Round((p.X - Area.X) * Scale), (int)Math.Round((p.Y - Area.Y) * Scale));
    public Rectangle ToImage(Rectangle r) => Rectangle.FromLTRB(ToImage(r.Location).X, ToImage(r.Location).Y, ToImage(new Point(r.Right, r.Bottom)).X, ToImage(new Point(r.Right, r.Bottom)).Y);
    public bool Contains(double x, double y) => x >= 0 && y >= 0 && x <= Width && y <= Height;
}

/// <summary>Shared state behind the tools. One tool call at a time touches the desktop.</summary>
sealed class Desktop : IDisposable
{
    public readonly FrameWatcher Watcher = new(int.TryParse(Environment.GetEnvironmentVariable("DESKTOP_CONTROL_FPS"), out var fps) ? fps : 5);
    public readonly Uia Uia = new();
    public readonly SemaphoreSlim Gate = new(1, 1);
    public Snapshot? Last { get; private set; }

    readonly string logPath;
    int nextId = 1;

    public Desktop()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeDesktopControl");
        Directory.CreateDirectory(dir);
        logPath = Path.Combine(dir, "actions.log");
    }

    /// <summary>Plain-language reason nothing can be done right now, or null if the desktop is usable.</summary>
    public static string? Unavailable() =>
        Native.OnUserDesktop(out _)
            ? null
            : "The PC is locked, or a secure prompt (UAC or Ctrl+Alt+Del) is showing. Windows doesn't let any program see or click that screen. Unlock the PC or answer the prompt, then try again.";

    public static List<MonitorInfo> Monitors()
    {
        var found = new List<(Rectangle r, bool primary)>();
        Native.EnumDisplayMonitors(0, 0, (nint h, nint _, ref Native.RECT _, nint _) =>
        {
            var mi = new Native.MONITORINFOEX { cbSize = System.Runtime.InteropServices.Marshal.SizeOf<Native.MONITORINFOEX>() };
            if (Native.GetMonitorInfo(h, ref mi))
                found.Add((Rectangle.FromLTRB(mi.rcMonitor.Left, mi.rcMonitor.Top, mi.rcMonitor.Right, mi.rcMonitor.Bottom), (mi.dwFlags & 1) != 0));
            return true;
        }, 0);
        // Numbered left to right, the way they sit on the desk.
        return found.OrderBy(m => m.r.X).ThenBy(m => m.r.Y).Select((m, i) => new MonitorInfo(i + 1, m.r, m.primary)).ToList();
    }

    /// <summary>"auto" is the monitor with the active window; "1", "2"… a monitor; "all" every monitor at once (small).</summary>
    public static (Rectangle area, string label) ResolveArea(string monitor)
    {
        var mons = Monitors();
        if (mons.Count == 0) throw new InvalidOperationException("No monitors found.");
        if (string.Equals(monitor, "all", StringComparison.OrdinalIgnoreCase))
        {
            var all = mons.Select(m => m.Bounds).Aggregate(Rectangle.Union);
            return (all, $"all {mons.Count} monitors");
        }
        MonitorInfo? pick = null;
        if (int.TryParse(monitor, out var n)) pick = mons.FirstOrDefault(m => m.Number == n)
            ?? throw new ArgumentException($"There is no monitor {n}. This PC has {mons.Count}.");
        if (pick is null)
        {
            var centre = WindowCentre(Native.GetForegroundWindow()) ?? Input.Cursor();
            pick = mons.FirstOrDefault(m => m.Bounds.Contains(centre)) ?? mons.FirstOrDefault(m => m.Primary) ?? mons[0];
        }
        return (pick.Bounds, $"monitor {pick.Number} of {mons.Count}{(pick.Primary ? " (main)" : "")}");
    }

    static Point? WindowCentre(nint hwnd)
    {
        if (hwnd == 0 || Native.IsIconic(hwnd)) return null;
        var r = WindowBounds(hwnd);
        return r.IsEmpty ? null : new Point(r.X + r.Width / 2, r.Y + r.Height / 2);
    }

    /// <summary>The window's visible frame (without the invisible resize border), in physical pixels.</summary>
    public static Rectangle WindowBounds(nint hwnd)
    {
        if (hwnd == 0 || Native.DwmGetWindowRect(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out var r, System.Runtime.InteropServices.Marshal.SizeOf<Native.RECT>()) != 0) return Rectangle.Empty;
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }

    /// <summary>Capture, read the active window's controls, and describe it all for Claude.</summary>
    public (Snapshot snap, string text, byte[] jpeg) Take(string monitor, bool elements, bool marks, IEnumerable<string>? notes = null)
    {
        var (area, label) = ResolveArea(monitor);
        Watcher.Watch(area);
        var prev = Last;
        var (changes, lastChange) = Watcher.Changes();

        var fg = Native.GetForegroundWindow();
        List<UiItem>? items = null;
        if (elements && fg != 0 && WindowBounds(fg).IntersectsWith(area))
            items = Uia.Collect(fg, 2000, 150)?.Where(i => i.Bounds.IntersectsWith(area)).ToList();

        var (bmp, sig) = Watcher.CaptureNow();
        using (bmp)
        {
            var scale = Imaging.FitScale(area.Width, area.Height);
            var snap = new Snapshot
            {
                Id = nextId++, Area = area, Scale = scale,
                Width = Math.Max(1, (int)Math.Round(area.Width * scale)), Height = Math.Max(1, (int)Math.Round(area.Height * scale)),
                Monitor = monitor, Elements = items ?? [], Signature = sig, ChangeMark = changes, Taken = DateTime.UtcNow,
            };

            Action<Graphics>? overlay = marks && snap.Elements.Count > 0 ? g => DrawMarks(g, snap) : null;
            var jpeg = Imaging.Jpeg(bmp, new Rectangle(0, 0, area.Width, area.Height), snap.Width, snap.Height, overlay);

            var sb = new StringBuilder();
            sb.AppendLine($"Screen {snap.Id}: {label}, {area.Width}x{area.Height} shown at {snap.Width}x{snap.Height}. x and y in act/zoom are pixels of this image.");
            if (fg != 0) sb.AppendLine($"Active window: \"{Native.WindowTitle(fg)}\" ({Native.ProcessName(fg)})");
            var (focused, _) = Uia.Focused();
            if (focused.Length > 0) sb.AppendLine($"Keyboard focus: {focused}");
            var cur = Input.Cursor();
            if (area.Contains(cur)) { var p = snap.ToImage(cur); sb.AppendLine($"Mouse pointer: {p.X},{p.Y}"); }
            if (prev is not null && prev.Area == area)
            {
                var n = changes - prev.ChangeMark;
                var ago = (DateTime.UtcNow - lastChange).TotalSeconds;
                sb.AppendLine(n == 0 ? "No change since your last look." : $"Since your last look the screen changed {n} time{(n == 1 ? "" : "s")}, most recently {ago:0.0} s ago.");
            }
            foreach (var note in notes ?? []) sb.AppendLine(note);

            if (!elements) { /* not asked for */ }
            else if (items is null) sb.AppendLine("Controls: the active app didn't list its controls in time; use x,y from the image.");
            else if (items.Count == 0) sb.AppendLine("Controls: none listed for the active window; use x,y from the image.");
            else
            {
                sb.AppendLine("Controls in the active window (click with element: <id>):");
                for (int i = 0; i < items.Count; i++)
                {
                    var it = items[i];
                    var c = snap.ToImage(new Point(it.Bounds.X + it.Bounds.Width / 2, it.Bounds.Y + it.Bounds.Height / 2));
                    var name = it.Name.Length > 0 ? $" \"{it.Name}\"" : "";
                    var flags = (it.Enabled ? "" : " disabled") + (it.Password ? " password" : "");
                    sb.AppendLine($"[{i + 1}] {it.Role}{name} at {c.X},{c.Y}{flags}");
                }
            }
            Last = snap;
            return (snap, sb.ToString().TrimEnd(), jpeg);
        }
    }

    static void DrawMarks(Graphics g, Snapshot snap)
    {
        using var pen = new Pen(Color.FromArgb(220, 255, 0, 128), 1.5f);
        using var back = new SolidBrush(Color.FromArgb(220, 255, 0, 128));
        using var font = new Font("Segoe UI", 8f, FontStyle.Bold, GraphicsUnit.Pixel);
        for (int i = 0; i < snap.Elements.Count; i++)
        {
            var r = snap.ToImage(snap.Elements[i].Bounds);
            g.DrawRectangle(pen, r);
            var tag = (i + 1).ToString();
            var size = g.MeasureString(tag, font);
            g.FillRectangle(back, r.X, r.Y, size.Width, size.Height);
            g.DrawString(tag, font, Brushes.White, r.X, r.Y);
        }
    }

    /// <summary>Records what was done, never what was typed (it may be private).</summary>
    public void Log(string what)
    {
        try { File.AppendAllText(logPath, $"{DateTime.Now:dd/MM/yyyy HH:mm:ss}  {what}{Environment.NewLine}"); }
        catch { /* logging must never stop an action */ }
    }

    public void Dispose()
    {
        Watcher.Dispose();
        Uia.Dispose();
    }
}
