using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace DesktopControl;

/// <summary>Screen capture, the coarse signature used to tell whether the screen changed, and image encoding.</summary>
static class Imaging
{
    /// <summary>Signature cell size in physical pixels.</summary>
    public const int Cell = 16;

    // Claude scales down anything bigger than this, which would shift the coordinates it reads off the image.
    const int MaxEdge = 1568;
    const double MaxPixels = 1_150_000;

    public static Bitmap Capture(Rectangle area)
    {
        var bmp = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppRgb);
        using var g = Graphics.FromImage(bmp);
        g.CopyFromScreen(area.X, area.Y, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
        return bmp;
    }

    /// <summary>Mean brightness of each 16×16 cell (sampling every second pixel).</summary>
    public static byte[] Signature(Bitmap bmp)
    {
        int cw = (bmp.Width + Cell - 1) / Cell, ch = (bmp.Height + Cell - 1) / Cell;
        var sums = new int[cw * ch];
        var counts = new int[cw * ch];
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        try
        {
            var row = new byte[data.Stride];
            for (int y = 0; y < bmp.Height; y += 2)
            {
                Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, data.Stride);
                int rowCell = (y / Cell) * cw;
                for (int x = 0; x < bmp.Width; x += 2)
                {
                    int i = x * 4;
                    int c = rowCell + x / Cell;
                    sums[c] += (row[i] * 29 + row[i + 1] * 150 + row[i + 2] * 77) >> 8;
                    counts[c]++;
                }
            }
        }
        finally { bmp.UnlockBits(data); }
        var sig = new byte[sums.Length];
        for (int c = 0; c < sig.Length; c++) sig[c] = (byte)(counts[c] == 0 ? 0 : sums[c] / counts[c]);
        return sig;
    }

    /// <summary>
    /// A real change: a menu, dialog, page load, tooltip or several typed words. A blinking text caret or a single
    /// character changes one or two cells a little and doesn't count, otherwise the screen would never "settle".
    /// </summary>
    public static bool Differs(byte[]? a, byte[]? b)
    {
        if (a is null || b is null || a.Length != b.Length) return true;
        int moderate = 0;
        for (int i = 0; i < a.Length; i++)
        {
            int d = Math.Abs(a[i] - b[i]);
            if (d > 60) return true;
            if (d > 8 && ++moderate >= 5) return true;
        }
        return false;
    }

    /// <summary>Scale that keeps the image at a size Claude reads without resizing it again.</summary>
    public static double FitScale(int w, int h) =>
        Math.Min(1.0, Math.Min(MaxEdge / (double)Math.Max(w, h), Math.Sqrt(MaxPixels / (w * (double)h))));

    public static byte[] Jpeg(Bitmap src, Rectangle crop, int w, int h, Action<Graphics>? overlay = null)
    {
        using var outBmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(outBmp))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(src, new Rectangle(0, 0, w, h), crop, GraphicsUnit.Pixel);
            overlay?.Invoke(g);
        }
        var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var ps = new EncoderParameters(1);
        ps.Param[0] = new EncoderParameter(Encoder.Quality, 85L);
        using var ms = new MemoryStream();
        outBmp.Save(ms, codec, ps);
        return ms.ToArray();
    }
}

/// <summary>
/// Watches one screen area several times a second while Claude is using the desktop, keeping only a coarse signature
/// per frame. That's what lets act() return the moment the screen settles, wait_for() return the moment it changes,
/// and screen() say what happened between looks, instead of Claude sleeping and re-screenshotting.
/// </summary>
sealed class FrameWatcher : IDisposable
{
    readonly object gate = new();
    readonly int intervalMs;
    readonly Thread thread;
    volatile bool stopped;

    Rectangle area;
    byte[]? lastSig;
    DateTime lastUse = DateTime.MinValue, lastChange = DateTime.UtcNow, lastSample = DateTime.MinValue, fastUntil = DateTime.MinValue;
    long changes;

    // Stop sampling when Claude hasn't touched the desktop for a while.
    static readonly TimeSpan IdleAfter = TimeSpan.FromSeconds(90);

    public FrameWatcher(int fps)
    {
        intervalMs = 1000 / Math.Clamp(fps, 1, 15);
        thread = new Thread(Run) { IsBackground = true, Name = "frame-watcher" };
        thread.Start();
    }

    public int Fps => 1000 / intervalMs;

    /// <summary>Point the watcher at an area (a monitor) and mark it in use.</summary>
    public void Watch(Rectangle a)
    {
        lock (gate)
        {
            if (a != area) { area = a; lastSig = null; lastChange = DateTime.UtcNow; }
            lastUse = DateTime.UtcNow;
        }
    }

    /// <summary>Capture the watched area now (full resolution) and record it like any other sample.</summary>
    public (Bitmap bmp, byte[] sig) CaptureNow()
    {
        Rectangle a;
        lock (gate) { a = area; lastUse = DateTime.UtcNow; }
        var bmp = Imaging.Capture(a);
        var sig = Imaging.Signature(bmp);
        Record(a, sig);
        return (bmp, sig);
    }

    public (long changes, DateTime lastChange) Changes()
    {
        lock (gate) return (changes, lastChange);
    }

    public byte[]? LatestSignature()
    {
        lock (gate) return lastSig;
    }

    /// <summary>Wait until nothing has changed for <paramref name="quietMs"/>, measured from now. Returns how long it took, or -1 on timeout.</summary>
    public async Task<int> WaitSettled(int quietMs, int timeoutMs, CancellationToken ct)
    {
        var start = DateTime.UtcNow;
        Boost(timeoutMs);
        while (true)
        {
            lock (gate)
            {
                var since = lastChange > start ? lastChange : start;
                if ((lastSample - since).TotalMilliseconds >= quietMs) return (int)(since - start).TotalMilliseconds;
            }
            if ((DateTime.UtcNow - start).TotalMilliseconds > timeoutMs) return -1;
            await Task.Delay(40, ct);
        }
    }

    /// <summary>Wait until the screen differs from <paramref name="baseline"/>. Returns how long it took, or -1 on timeout.</summary>
    public async Task<int> WaitChanged(byte[]? baseline, int timeoutMs, CancellationToken ct)
    {
        var start = DateTime.UtcNow;
        Boost(timeoutMs);
        while (true)
        {
            lock (gate)
            {
                if (lastSample > start && Imaging.Differs(baseline, lastSig)) return (int)(DateTime.UtcNow - start).TotalMilliseconds;
            }
            if ((DateTime.UtcNow - start).TotalMilliseconds > timeoutMs) return -1;
            await Task.Delay(40, ct);
        }
    }

    /// <summary>Sample at 10 fps while something is waiting on the screen.</summary>
    void Boost(int ms)
    {
        lock (gate) { fastUntil = DateTime.UtcNow.AddMilliseconds(ms + 200); lastUse = DateTime.UtcNow; }
    }

    void Record(Rectangle a, byte[] sig)
    {
        lock (gate)
        {
            if (a != area) return;
            if (lastSig != null && Imaging.Differs(lastSig, sig)) { lastChange = DateTime.UtcNow; changes++; }
            lastSig = sig;
            lastSample = DateTime.UtcNow;
        }
    }

    void Run()
    {
        while (!stopped)
        {
            Rectangle a;
            int wait;
            bool active;
            lock (gate)
            {
                a = area;
                active = !a.IsEmpty && DateTime.UtcNow - lastUse < IdleAfter;
                wait = DateTime.UtcNow < fastUntil ? Math.Min(100, intervalMs) : intervalMs;
            }
            if (!active || !Native.OnUserDesktop(out _)) { Thread.Sleep(250); continue; }
            var t0 = Environment.TickCount64;
            try
            {
                using var bmp = Imaging.Capture(a);
                Record(a, Imaging.Signature(bmp));
            }
            catch { /* the desktop can disappear mid-capture (lock, UAC); try again next tick */ }
            var spent = (int)(Environment.TickCount64 - t0);
            Thread.Sleep(Math.Max(10, wait - spent));
        }
    }

    public void Dispose() => stopped = true;
}
