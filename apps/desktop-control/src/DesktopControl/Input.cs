using System.Drawing;
using System.Runtime.InteropServices;
using static DesktopControl.Native;

namespace DesktopControl;

/// <summary>Real mouse and keyboard input through SendInput, in physical screen pixels.</summary>
static class Input
{
    const uint LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, MIDDLEDOWN = 0x20, MIDDLEUP = 0x40, WHEEL = 0x800, HWHEEL = 0x1000;
    const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;

    public static Point Cursor()
    {
        GetCursorPos(out var p);
        return new Point(p.X, p.Y);
    }

    public static void MoveTo(Point p) => SetCursorPos(p.X, p.Y);

    /// <summary>
    /// A zero-distance mouse movement. Windows only lets the process that sent the latest input change the foreground
    /// window; this counts as input but, unlike the usual Alt-key trick, doesn't open menus or key tips in any app.
    /// </summary>
    public static void Nudge() => Send([Mouse(0x0001 /* MOUSEEVENTF_MOVE */)]);

    public static void Click(Point p, string button, int count)
    {
        MoveTo(p);
        Thread.Sleep(25);
        var (down, up) = button switch
        {
            "right" => (RIGHTDOWN, RIGHTUP),
            "middle" => (MIDDLEDOWN, MIDDLEUP),
            _ => (LEFTDOWN, LEFTUP),
        };
        for (int i = 0; i < count; i++)
        {
            Send([Mouse(down), Mouse(up)]);
            if (i < count - 1) Thread.Sleep(40);
        }
    }

    public static void Drag(Point from, Point to)
    {
        MoveTo(from);
        Thread.Sleep(30);
        Send([Mouse(LEFTDOWN)]);
        Thread.Sleep(60);
        const int steps = 12;
        for (int i = 1; i <= steps; i++)
        {
            MoveTo(new Point(from.X + (to.X - from.X) * i / steps, from.Y + (to.Y - from.Y) * i / steps));
            Thread.Sleep(15);
        }
        Thread.Sleep(60);
        Send([Mouse(LEFTUP)]);
    }

    /// <summary>Positive notches scroll down (or right), negative up (or left).</summary>
    public static void Scroll(Point p, int notches, bool horizontal)
    {
        MoveTo(p);
        Thread.Sleep(25);
        var m = Mouse(horizontal ? HWHEEL : WHEEL);
        m.u.mi.mouseData = horizontal ? notches * 120 : -notches * 120;
        Send([m]);
    }

    /// <summary>Types text exactly as given (any language or symbol), with new lines as Enter.</summary>
    public static void Type(string text)
    {
        var batch = new List<INPUT>();
        foreach (var ch in text.ReplaceLineEndings("\n"))
        {
            if (ch == '\n') { batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); }
            else if (ch == '\t') { batch.Add(Key(0x09, false)); batch.Add(Key(0x09, true)); }
            else { batch.Add(Unicode(ch, false)); batch.Add(Unicode(ch, true)); }
            // Small batches with a pause: some apps drop characters that arrive all at once.
            if (batch.Count >= 40) { Send(batch.ToArray()); batch.Clear(); Thread.Sleep(10); }
        }
        if (batch.Count > 0) Send(batch.ToArray());
    }

    /// <summary>
    /// Presses keys: "enter", "ctrl+s", "alt+f4", "ctrl+shift+esc". Several presses separated by spaces run in order:
    /// "ctrl+a delete".
    /// </summary>
    public static void Keys(string spec)
    {
        foreach (var combo in spec.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = combo.Split('+', StringSplitOptions.RemoveEmptyEntries);
            if (combo.EndsWith("++")) parts = [.. parts, "+"]; // "ctrl++"
            var codes = parts.Select(Resolve).ToList();
            var down = new List<INPUT>();
            var up = new List<INPUT>();
            foreach (var (vk, shift) in codes)
            {
                if (shift) { down.Add(Key(0x10, false)); up.Insert(0, Key(0x10, true)); }
                down.Add(Key(vk, false));
                up.Insert(0, Key(vk, true));
            }
            Send([.. down, .. up]);
            Thread.Sleep(30);
        }
    }

    static readonly Dictionary<string, ushort> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ctrl"] = 0x11, ["control"] = 0x11, ["shift"] = 0x10, ["alt"] = 0x12,
        ["win"] = 0x5B, ["windows"] = 0x5B, ["meta"] = 0x5B, ["cmd"] = 0x5B, ["super"] = 0x5B,
        ["enter"] = 0x0D, ["return"] = 0x0D, ["tab"] = 0x09, ["esc"] = 0x1B, ["escape"] = 0x1B,
        ["backspace"] = 0x08, ["delete"] = 0x2E, ["del"] = 0x2E, ["insert"] = 0x2D, ["space"] = 0x20,
        ["up"] = 0x26, ["down"] = 0x28, ["left"] = 0x25, ["right"] = 0x27,
        ["home"] = 0x24, ["end"] = 0x23, ["pageup"] = 0x21, ["pagedown"] = 0x22,
        ["printscreen"] = 0x2C, ["menu"] = 0x5D, ["apps"] = 0x5D, ["capslock"] = 0x14,
    };

    static readonly HashSet<ushort> Extended = [0x2D, 0x2E, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x5B, 0x5D, 0x2C];

    static (ushort vk, bool shift) Resolve(string name)
    {
        if (Named.TryGetValue(name, out var vk)) return (vk, false);
        if (name.Length > 1 && (name[0] == 'f' || name[0] == 'F') && int.TryParse(name[1..], out var n) && n is >= 1 and <= 24)
            return ((ushort)(0x70 + n - 1), false);
        if (name.Length == 1)
        {
            var c = name[0];
            if (char.IsAsciiLetter(c)) return (char.ToUpperInvariant(c), false);
            if (char.IsAsciiDigit(c)) return (c, false);
            var scan = VkKeyScan(c);
            if (scan != -1) return ((ushort)(scan & 0xFF), (scan & 0x100) != 0);
        }
        throw new ArgumentException($"Unknown key \"{name}\". Use names like enter, tab, esc, ctrl, shift, alt, win, up, f5, or a single character.");
    }

    static INPUT Mouse(uint flags) => new() { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags } } };

    static INPUT Key(ushort vk, bool up) => new()
    {
        type = INPUT_KEYBOARD,
        u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = (up ? KEYUP : 0) | (Extended.Contains(vk) ? EXTENDED : 0) } },
    };

    static INPUT Unicode(char c, bool up) => new()
    {
        type = INPUT_KEYBOARD,
        u = new InputUnion { ki = new KEYBDINPUT { wScan = c, dwFlags = UNICODE | (up ? KEYUP : 0) } },
    };

    static void Send(INPUT[] inputs)
    {
        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent != inputs.Length)
            throw new InvalidOperationException("Windows blocked the input. The target is probably running as administrator, which a normal program can't control.");
    }
}
