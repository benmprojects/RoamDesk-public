using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

namespace DesktopControl;

/// <summary>Windows' built-in text recognition, for finding text that UI Automation doesn't expose (web pages, canvases, images).</summary>
static class Ocr
{
    static readonly OcrEngine? Engine =
        OcrEngine.TryCreateFromUserProfileLanguages() ?? OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"));

    public static bool Available => Engine is not null;

    /// <summary>Lines of text with their bounds in the bitmap's pixels.</summary>
    public static async Task<List<(string text, Rectangle bounds)>> Lines(Bitmap bmp)
    {
        var lines = new List<(string, Rectangle)>();
        if (Engine is null) return lines;

        double s = Math.Min(1.0, OcrEngine.MaxImageDimension / (double)Math.Max(bmp.Width, bmp.Height));
        using var scaled = s < 1 ? new Bitmap(bmp, (int)(bmp.Width * s), (int)(bmp.Height * s)) : null;
        var src = scaled ?? bmp;

        var data = src.LockBits(new Rectangle(0, 0, src.Width, src.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        byte[] bytes;
        try
        {
            bytes = new byte[src.Width * 4 * src.Height];
            for (int y = 0; y < src.Height; y++) Marshal.Copy(data.Scan0 + y * data.Stride, bytes, y * src.Width * 4, src.Width * 4);
        }
        finally { src.UnlockBits(data); }

        using var sb = SoftwareBitmap.CreateCopyFromBuffer(bytes.AsBuffer(), BitmapPixelFormat.Bgra8, src.Width, src.Height, BitmapAlphaMode.Ignore);
        var result = await Engine.RecognizeAsync(sb);
        foreach (var line in result.Lines)
        {
            if (line.Words.Count == 0) continue;
            double l = line.Words.Min(w => w.BoundingRect.X), t = line.Words.Min(w => w.BoundingRect.Y);
            double r = line.Words.Max(w => w.BoundingRect.X + w.BoundingRect.Width), b = line.Words.Max(w => w.BoundingRect.Y + w.BoundingRect.Height);
            lines.Add((line.Text, Rectangle.FromLTRB((int)(l / s), (int)(t / s), (int)Math.Ceiling(r / s), (int)Math.Ceiling(b / s))));
        }
        return lines;
    }

    public static string Normalise(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).ToLowerInvariant();
}
