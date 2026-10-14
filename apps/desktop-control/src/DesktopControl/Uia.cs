using System.Drawing;
using FlaUI.Core;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

namespace DesktopControl;

/// <summary>A control in the active window, as Windows UI Automation reports it. Bounds are physical screen pixels.</summary>
sealed record UiItem(string Role, string Name, Rectangle Bounds, bool Enabled, bool Password);

/// <summary>Reads the active window's buttons, fields, links and list items so they can be clicked by id rather than by guessing pixels.</summary>
sealed class Uia : IDisposable
{
    readonly UIA3Automation automation = new();
    int busy;

    static readonly ControlType[] Interactive =
    [
        ControlType.Button, ControlType.SplitButton, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox,
        ControlType.Edit, ControlType.Document, ControlType.Hyperlink, ControlType.ListItem, ControlType.MenuItem,
        ControlType.TabItem, ControlType.TreeItem, ControlType.DataItem, ControlType.Slider, ControlType.Spinner,
    ];

    /// <summary>
    /// Interactive, on-screen controls of a window. Null if the app didn't answer in time (some apps have huge trees);
    /// a slow walk keeps running in the background but a second one isn't started on top of it.
    /// </summary>
    public List<UiItem>? Collect(nint hwnd, int timeoutMs, int max)
    {
        if (hwnd == 0 || Interlocked.Exchange(ref busy, 1) == 1) return null;
        var task = Task.Run(() =>
        {
            try { return Walk(hwnd, max); }
            finally { Interlocked.Exchange(ref busy, 0); }
        });
        try { return task.Wait(timeoutMs) ? task.Result : null; }
        catch { return null; }
    }

    List<UiItem> Walk(nint hwnd, int max)
    {
        var root = automation.FromHandle(hwnd);
        var lib = automation.PropertyLibrary.Element;
        var cf = automation.ConditionFactory;
        var types = new OrCondition(Interactive.Select(t => (ConditionBase)cf.ByControlType(t)).ToArray());
        var condition = new AndCondition(types, new PropertyCondition(lib.IsOffscreen, false));

        var cache = new CacheRequest { TreeScope = TreeScope.Element };
        cache.Add(lib.Name);
        cache.Add(lib.ControlType);
        cache.Add(lib.BoundingRectangle);
        cache.Add(lib.IsEnabled);
        cache.Add(lib.IsPassword);

        var items = new List<UiItem>();
        using (cache.Activate())
        {
            foreach (var e in root.FindAllDescendants(condition))
            {
                var r = e.Properties.BoundingRectangle.ValueOrDefault;
                if (r.Width < 2 || r.Height < 2) continue;
                var name = (e.Properties.Name.ValueOrDefault ?? "").ReplaceLineEndings(" ").Trim();
                if (name.Length > 60) name = name[..57] + "...";
                items.Add(new UiItem(e.Properties.ControlType.ValueOrDefault.ToString(), name, r,
                    e.Properties.IsEnabled.ValueOrDefault, e.Properties.IsPassword.ValueOrDefault));
                if (items.Count >= max) break;
            }
        }
        // Reading order: top to bottom, then left to right.
        return items.OrderBy(i => i.Bounds.Top / 8).ThenBy(i => i.Bounds.Left).ToList();
    }

    /// <summary>The control that has keyboard focus, e.g. "Edit "Search"", and whether it is a password field.</summary>
    public (string summary, bool password) Focused()
    {
        try
        {
            var f = automation.FocusedElement();
            if (f is null) return ("", false);
            var name = (f.Properties.Name.ValueOrDefault ?? "").ReplaceLineEndings(" ").Trim();
            if (name.Length > 60) name = name[..57] + "...";
            return ($"{f.Properties.ControlType.ValueOrDefault} \"{name}\"", f.Properties.IsPassword.ValueOrDefault);
        }
        catch { return ("", false); }
    }

    public void Dispose() => automation.Dispose();
}
