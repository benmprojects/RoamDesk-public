using System.ComponentModel;
using System.Drawing;
using System.Text;
using System.Text.Json.Serialization;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace DesktopControl;

/// <summary>One step of an act() call.</summary>
sealed class Step
{
    [JsonPropertyName("action"), Description("click, double_click, right_click, middle_click, move, drag, scroll, type, key or wait.")]
    public string Action { get; set; } = "";

    [JsonPropertyName("element"), Description("Control id from the latest screen. More reliable than x,y; use it when the control is listed.")]
    public int? Element { get; set; }

    [JsonPropertyName("x"), Description("Pixel x in the latest screen image.")]
    public double? X { get; set; }

    [JsonPropertyName("y"), Description("Pixel y in the latest screen image.")]
    public double? Y { get; set; }

    [JsonPropertyName("to_x"), Description("drag: end x in the latest screen image.")]
    public double? ToX { get; set; }

    [JsonPropertyName("to_y"), Description("drag: end y in the latest screen image.")]
    public double? ToY { get; set; }

    [JsonPropertyName("text"), Description("type: the exact text to type. New lines press Enter.")]
    public string? Text { get; set; }

    [JsonPropertyName("keys"), Description("key: e.g. \"enter\", \"ctrl+s\", \"alt+tab\", or several in order separated by spaces: \"ctrl+a delete\".")]
    public string? Keys { get; set; }

    [JsonPropertyName("amount"), Description("scroll: wheel notches, positive scrolls down (or right), negative up (or left). Default 3.")]
    public int? Amount { get; set; }

    [JsonPropertyName("horizontal"), Description("scroll: true to scroll sideways.")]
    public bool? Horizontal { get; set; }

    [JsonPropertyName("ms"), Description("wait: milliseconds, up to 10000. Prefer wait_for, which returns as soon as the screen is ready.")]
    public int? Ms { get; set; }
}

[McpServerToolType]
sealed class DesktopTools(Desktop desk)
{
    [McpServerTool(Name = "screen", ReadOnly = true)]
    [Description("""
        Look at the screen. Returns a picture of the monitor with the active window (or the one you name), the active
        window's title, what has keyboard focus, whether the screen changed since your last look, and a numbered list of
        the active window's controls. Click a listed control by its id: that's more reliable than reading pixels.
        """)]
    public async Task<CallToolResult> Screen(
        [Description("\"auto\" (monitor with the active window), \"1\", \"2\"… or \"all\" (every monitor, small).")] string monitor = "auto",
        [Description("List the active window's controls with ids. Default true.")] bool elements = true,
        [Description("Also draw the control ids on the picture. Default false.")] bool marks = false,
        CancellationToken ct = default)
    {
        await desk.Gate.WaitAsync(ct);
        try
        {
            if (Desktop.Unavailable() is { } why) return Fail(why);
            var (_, text, jpeg) = desk.Take(monitor, elements, marks);
            return Result(text, jpeg);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) { return Fail(ex.Message); }
        finally { desk.Gate.Release(); }
    }

    [McpServerTool(Name = "act", Destructive = true, OpenWorld = true)]
    [Description("""
        Use the real mouse and keyboard: one or more steps in order, then wait until the screen stops changing and look
        again, so you don't need a separate screen call. Target a control by element id from the latest screen, or by
        x,y in that screen's image. Stops early if someone moves the mouse, if the pointer is pushed into the top-left
        corner (emergency stop), or before typing into a password field.
        """)]
    public async Task<CallToolResult> Act(
        [Description("Steps to run in order.")] Step[] steps,
        [Description("Wait for the screen to settle afterwards. Default true.")] bool settle = true,
        [Description("Return a new screen afterwards. Default true.")] bool screenshot = true,
        [Description("Monitor for the new screen: \"auto\", \"1\", \"2\"… or \"all\".")] string monitor = "auto",
        CancellationToken ct = default)
    {
        await desk.Gate.WaitAsync(ct);
        try
        {
            if (Desktop.Unavailable() is { } why) return Fail(why);
            var snap = desk.Last;
            var notes = new List<string>();
            var corner = Desktop.Monitors().Select(m => m.Bounds).Aggregate(Rectangle.Union).Location;
            Point? placed = null;
            int done = 0;

            foreach (var step in steps)
            {
                ct.ThrowIfCancellationRequested();
                var cur = Input.Cursor();
                if (Near(cur, corner, 2) && placed != corner) { notes.Add("Emergency stop: the mouse pointer is in the top-left corner. Nothing more was done."); break; }
                if (placed is { } was && !Near(cur, was, 4)) { notes.Add("Stopped: someone else moved the mouse, so I didn't carry on."); break; }

                try
                {
                    var action = step.Action.Trim().ToLowerInvariant();
                    string what;
                    switch (action)
                    {
                        case "click" or "double_click" or "right_click" or "middle_click":
                        {
                            var (p, label) = Target(step, snap);
                            Input.Click(p, action switch { "right_click" => "right", "middle_click" => "middle", _ => "left" }, action == "double_click" ? 2 : 1);
                            placed = p;
                            what = $"{action.Replace('_', ' ')} {label}";
                            break;
                        }
                        case "move":
                        {
                            var (p, label) = Target(step, snap);
                            Input.MoveTo(p);
                            placed = p;
                            what = $"move to {label}";
                            break;
                        }
                        case "drag":
                        {
                            var (from, label) = Target(step, snap);
                            if (step.ToX is null || step.ToY is null) throw new ArgumentException("drag needs to_x and to_y.");
                            var to = ScreenPoint(snap, step.ToX.Value, step.ToY.Value);
                            Input.Drag(from, to);
                            placed = to;
                            what = $"drag from {label} to {step.ToX:0},{step.ToY:0}";
                            break;
                        }
                        case "scroll":
                        {
                            var (p, label) = step.Element is null && step.X is null ? (Input.Cursor(), "the pointer") : Target(step, snap);
                            Input.Scroll(p, step.Amount ?? 3, step.Horizontal == true);
                            placed = p;
                            what = $"scroll {step.Amount ?? 3} at {label}";
                            break;
                        }
                        case "type":
                        {
                            if (string.IsNullOrEmpty(step.Text)) throw new ArgumentException("type needs text.");
                            if (desk.Uia.Focused().password)
                            {
                                notes.Add("Stopped: the field with keyboard focus is a password field. Ask the user to type it themselves.");
                                goto stop;
                            }
                            Input.Type(step.Text);
                            what = $"type {step.Text.Length} characters";
                            break;
                        }
                        case "key":
                            if (string.IsNullOrWhiteSpace(step.Keys)) throw new ArgumentException("key needs keys, e.g. \"enter\" or \"ctrl+s\".");
                            Input.Keys(step.Keys);
                            what = $"press {step.Keys}";
                            break;
                        case "wait":
                            await Task.Delay(Math.Clamp(step.Ms ?? 500, 0, 10_000), ct);
                            what = $"wait {Math.Clamp(step.Ms ?? 500, 0, 10_000)} ms";
                            break;
                        default:
                            throw new ArgumentException($"Unknown action \"{step.Action}\".");
                    }
                    desk.Log(what);
                    done++;
                    // Give the app a moment to react before the next step.
                    await Task.Delay(action.Contains("click") ? 80 : 30, ct);
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
                {
                    notes.Add($"Step {done + 1} failed: {ex.Message}");
                    break;
                }
            }
            stop:
            notes.Insert(0, $"Did {done} of {steps.Length} step{(steps.Length == 1 ? "" : "s")}.");

            if (settle && done > 0)
            {
                var ms = await desk.Watcher.WaitSettled(400, 5000, ct);
                notes.Add(ms < 0 ? "The screen was still changing after 5 s (a video or animation?)." : $"The screen settled {ms} ms after the last step.");
            }
            if (!screenshot) return Text(string.Join("\n", notes));
            var (_, text, jpeg) = desk.Take(monitor, true, false, notes);
            return Result(text, jpeg);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) { return Fail(ex.Message); }
        finally { desk.Gate.Release(); }
    }

    [McpServerTool(Name = "wait_for", ReadOnly = true)]
    [Description("""
        Wait for the screen instead of sleeping: returns the moment it changes, settles, or some text appears or goes
        away, then looks again. The screen is watched several times a second, so this is quick and doesn't miss much.
        Text matches report where the text is, so you can click it.
        """)]
    public async Task<CallToolResult> WaitFor(
        [Description("\"change\", \"settle\", \"text\" (until the text appears) or \"text_gone\" (until it disappears).")] string until,
        [Description("For text and text_gone: the text to look for (not case sensitive).")] string? text = null,
        [Description("Give up after this many milliseconds. Default 10000, up to 60000.")] int timeout_ms = 10_000,
        [Description("\"auto\", \"1\", \"2\"… or \"all\".")] string monitor = "auto",
        CancellationToken ct = default)
    {
        await desk.Gate.WaitAsync(ct);
        try
        {
            if (Desktop.Unavailable() is { } why) return Fail(why);
            var timeout = Math.Clamp(timeout_ms, 100, 60_000);
            var (area, _) = Desktop.ResolveArea(monitor);
            desk.Watcher.Watch(area);
            var started = DateTime.UtcNow;
            string note;
            var found = new List<(string text, Rectangle bounds)>();

            switch (until.Trim().ToLowerInvariant())
            {
                case "change":
                {
                    var baseline = desk.Last?.Area == area ? desk.Last.Signature : desk.Watcher.LatestSignature();
                    var ms = await desk.Watcher.WaitChanged(baseline, timeout, ct);
                    note = ms < 0 ? $"No change in {timeout / 1000.0:0.#} s." : $"The screen changed after {ms} ms.";
                    break;
                }
                case "settle":
                {
                    var ms = await desk.Watcher.WaitSettled(500, timeout, ct);
                    note = ms < 0 ? $"Still changing after {timeout / 1000.0:0.#} s." : $"Settled after {ms} ms.";
                    break;
                }
                case "text" or "text_gone":
                {
                    if (string.IsNullOrWhiteSpace(text)) return Fail("Give the text to look for.");
                    if (!Ocr.Available) return Fail("Windows text recognition isn't installed for any of this PC's languages.");
                    var want = Ocr.Normalise(text);
                    var gone = until.Trim().Equals("text_gone", StringComparison.OrdinalIgnoreCase);
                    bool met = false;
                    while (true)
                    {
                        var (bmp, _) = desk.Watcher.CaptureNow();
                        using (bmp)
                        {
                            found = (await Ocr.Lines(bmp)).Where(l => Ocr.Normalise(l.text).Contains(want))
                                .Select(l => (l.text, new Rectangle(l.bounds.X + area.X, l.bounds.Y + area.Y, l.bounds.Width, l.bounds.Height))).ToList();
                        }
                        met = gone ? found.Count == 0 : found.Count > 0;
                        if (met || (DateTime.UtcNow - started).TotalMilliseconds > timeout) break;
                        await Task.Delay(250, ct);
                    }
                    var secs = (DateTime.UtcNow - started).TotalSeconds;
                    note = met
                        ? (gone ? $"\"{text}\" is gone (after {secs:0.0} s)." : $"Found \"{text}\" after {secs:0.0} s.")
                        : (gone ? $"\"{text}\" was still showing after {timeout / 1000.0:0.#} s." : $"\"{text}\" didn't appear in {timeout / 1000.0:0.#} s.");
                    break;
                }
                default:
                    return Fail("until must be change, settle, text or text_gone.");
            }

            var (snap, screenText, jpeg) = desk.Take(monitor, true, false, [note]);
            if (found.Count > 0)
            {
                var sb = new StringBuilder(screenText).AppendLine().AppendLine("Text found (centre in this image):");
                foreach (var (t, b) in found.Take(10))
                {
                    var c = snap.ToImage(new Point(b.X + b.Width / 2, b.Y + b.Height / 2));
                    sb.AppendLine($"\"{t}\" at {c.X},{c.Y}");
                }
                screenText = sb.ToString().TrimEnd();
            }
            return Result(screenText, jpeg);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) { return Fail(ex.Message); }
        finally { desk.Gate.Release(); }
    }

    [McpServerTool(Name = "zoom", ReadOnly = true)]
    [Description("A sharper look at part of the latest screen, at up to full resolution. Give the region in the screen image's pixels. Keep using the screen image's coordinates for act.")]
    public async Task<CallToolResult> Zoom(
        [Description("Left edge in the screen image.")] double x,
        [Description("Top edge in the screen image.")] double y,
        [Description("Width in the screen image.")] double width,
        [Description("Height in the screen image.")] double height,
        CancellationToken ct = default)
    {
        await desk.Gate.WaitAsync(ct);
        try
        {
            if (Desktop.Unavailable() is { } why) return Fail(why);
            var snap = desk.Last;
            if (snap is null) return Fail("Call screen first.");
            var tl = snap.ToScreen(x, y);
            var br = snap.ToScreen(x + width, y + height);
            var region = Rectangle.Intersect(Rectangle.FromLTRB(tl.X, tl.Y, br.X, br.Y), snap.Area);
            if (region.Width < 4 || region.Height < 4) return Fail("That region is outside the screen or too small.");
            using var bmp = Imaging.Capture(region);
            var s = Imaging.FitScale(region.Width, region.Height);
            int w = Math.Max(1, (int)(region.Width * s)), h = Math.Max(1, (int)(region.Height * s));
            var jpeg = Imaging.Jpeg(bmp, new Rectangle(0, 0, region.Width, region.Height), w, h);
            var factor = w / Math.Max(1.0, width);
            return Result($"Zoom of screen {snap.Id} from {x:0},{y:0} size {width:0}x{height:0}, shown at {w}x{h} ({factor:0.#}x). For act, keep using screen {snap.Id}'s coordinates.", jpeg);
        }
        finally { desk.Gate.Release(); }
    }

    [McpServerTool(Name = "windows", ReadOnly = true)]
    [Description("List the open windows: title, program, monitor and whether minimised.")]
    public string Windows()
    {
        var mons = Desktop.Monitors();
        var sb = new StringBuilder();
        foreach (var w in TopWindows())
        {
            var r = Desktop.WindowBounds(w);
            var mon = mons.FirstOrDefault(m => m.Bounds.Contains(new Point(r.X + r.Width / 2, r.Y + r.Height / 2)))?.Number;
            var state = Native.IsIconic(w) ? ", minimised" : mon is null ? "" : $", monitor {mon}";
            sb.AppendLine($"\"{Native.WindowTitle(w)}\" ({Native.ProcessName(w)}{state})");
        }
        return sb.Length == 0 ? "No windows are open." : sb.ToString().TrimEnd();
    }

    [McpServerTool(Name = "focus_window")]
    [Description("Bring a window to the front (restoring it if minimised), then look at the screen.")]
    public async Task<CallToolResult> FocusWindow(
        [Description("Part of the window title, or the program name such as \"excel.exe\". Not case sensitive.")] string title,
        CancellationToken ct = default)
    {
        await desk.Gate.WaitAsync(ct);
        try
        {
            if (Desktop.Unavailable() is { } why) return Fail(why);
            var match = TopWindows().FirstOrDefault(w =>
                Native.WindowTitle(w).Contains(title, StringComparison.OrdinalIgnoreCase) ||
                Native.ProcessName(w).Equals(title, StringComparison.OrdinalIgnoreCase));
            if (match == 0) return Fail($"No open window matches \"{title}\". Call windows to see what's open.");
            if (Native.IsIconic(match)) Native.ShowWindow(match, 9 /* SW_RESTORE */);
            Input.Nudge();
            Native.SetForegroundWindow(match);
            desk.Log($"focus \"{Native.WindowTitle(match)}\"");
            await desk.Watcher.WaitSettled(300, 2000, ct);
            var focused = Native.GetForegroundWindow() == match;
            var (_, text, jpeg) = desk.Take("auto", true, false, focused ? null : ["Windows didn't bring that window to the front. Click it on the taskbar instead."]);
            return Result(text, jpeg);
        }
        finally { desk.Gate.Release(); }
    }

    static IEnumerable<nint> TopWindows()
    {
        var list = new List<nint>();
        Native.EnumWindows((h, _) =>
        {
            // Owned windows stay in: dialogs such as Save As are owned, and are often exactly what needs focus.
            if (!Native.IsWindowVisible(h)) return true;
            if ((Native.GetWindowLong(h, -20 /* GWL_EXSTYLE */) & 0x80 /* WS_EX_TOOLWINDOW */) != 0) return true;
            if (Native.DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, out var cloaked, 4) == 0 && cloaked != 0) return true;
            if (Native.WindowTitle(h).Length == 0) return true;
            list.Add(h);
            return true;
        }, 0);
        return list;
    }

    static (Point point, string label) Target(Step step, Snapshot? snap)
    {
        if (step.Element is int id)
        {
            if (snap is null) throw new ArgumentException("Call screen first, so there are control ids to use.");
            if (id < 1 || id > snap.Elements.Count) throw new ArgumentException($"There's no control {id} in screen {snap.Id}. Look again with screen.");
            var e = snap.Elements[id - 1];
            var label = $"[{id}] {e.Role}{(e.Name.Length > 0 ? $" \"{e.Name}\"" : "")}";
            return (new Point(e.Bounds.X + e.Bounds.Width / 2, e.Bounds.Y + e.Bounds.Height / 2), label);
        }
        if (step.X is double x && step.Y is double y) return (ScreenPoint(snap, x, y), $"{x:0},{y:0}");
        throw new ArgumentException($"{step.Action} needs element, or x and y.");
    }

    static Point ScreenPoint(Snapshot? snap, double x, double y)
    {
        if (snap is null) throw new ArgumentException("Call screen first: x and y are pixels of the latest screen image.");
        if (!snap.Contains(x, y)) throw new ArgumentException($"{x:0},{y:0} is outside screen {snap.Id} ({snap.Width}x{snap.Height}).");
        return snap.ToScreen(x, y);
    }

    static bool Near(Point a, Point b, int d) => Math.Abs(a.X - b.X) <= d && Math.Abs(a.Y - b.Y) <= d;

    static CallToolResult Result(string text, byte[] jpeg) => new()
    {
        Content = [new TextContentBlock { Text = text }, ImageContentBlock.FromBytes(jpeg, "image/jpeg")],
    };

    static CallToolResult Text(string text) => new() { Content = [new TextContentBlock { Text = text }] };

    static CallToolResult Fail(string text) => new() { Content = [new TextContentBlock { Text = text }], IsError = true };
}
