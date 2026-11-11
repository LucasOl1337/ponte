// Ponte Windows agent: serves the screen as JPEG and takes pointer/keyboard
// input for the Ponte home node. Listens on 127.0.0.1 only; the home node
// reaches it through an SSH port forward and a bearer token.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class PonteWin {
  static string Token;
  static readonly JavaScriptSerializer Ser = new JavaScriptSerializer();
  static readonly object InputLock = new object();

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr h, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int cx, int cy, int step, IntPtr brush, int flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }

  public static void Run(int port, string token) {
    Token = token;
    SetProcessDPIAware();
    var listener = new TcpListener(IPAddress.Loopback, port);
    listener.Start();
    while (true) {
      var client = listener.AcceptTcpClient();
      ThreadPool.QueueUserWorkItem(_ => Serve(client));
    }
  }

  static string ReadLine(Stream s) {
    var sb = new StringBuilder();
    while (true) {
      int b = s.ReadByte();
      if (b < 0) return sb.Length > 0 ? sb.ToString() : null;
      if (b == '\n') return sb.ToString().TrimEnd('\r');
      if (sb.Length > 8192) return null;
      sb.Append((char)b);
    }
  }

  static void Serve(TcpClient client) {
    try {
      using (client) {
        client.NoDelay = true;
        var s = client.GetStream();
        s.ReadTimeout = 60000;
        while (true) {
          string line = ReadLine(s);
          if (string.IsNullOrEmpty(line)) return;
          var parts = line.Split(' ');
          if (parts.Length < 2) return;
          var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
          string h;
          while (!string.IsNullOrEmpty(h = ReadLine(s))) { int i = h.IndexOf(':'); if (i > 0) headers[h.Substring(0, i).Trim()] = h.Substring(i + 1).Trim(); }
          if (h == null) return;
          int len = 0; string cl;
          if (headers.TryGetValue("Content-Length", out cl)) int.TryParse(cl, out len);
          if (len < 0 || len > (1 << 20)) return;
          var body = new byte[len]; int got = 0;
          while (got < len) { int n = s.Read(body, got, len - got); if (n <= 0) return; got += n; }
          int status = 200; string type = "application/json"; byte[] resp;
          string auth; headers.TryGetValue("Authorization", out auth);
          try {
            if (auth != "Bearer " + Token) { status = 401; resp = Json(new { error = "UNAUTHORIZED" }); }
            else resp = Route(parts[0], parts[1], body, ref type);
          } catch (ArgumentException e) { status = 400; resp = Json(new { error = e.Message }); }
          catch (Exception e) { status = 503; resp = Json(new { error = e.GetType().Name + ": " + e.Message }); }
          var head = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " X\r\nContent-Type: " + type + "\r\nContent-Length: " + resp.Length + "\r\nCache-Control: no-store\r\n\r\n");
          s.Write(head, 0, head.Length); s.Write(resp, 0, resp.Length);
        }
      }
    } catch { }
  }

  static byte[] Json(object o) { return Encoding.UTF8.GetBytes(Ser.Serialize(o)); }

  static Dictionary<string, string> Query(string target) {
    var q = new Dictionary<string, string>();
    int i = target.IndexOf('?');
    if (i < 0) return q;
    foreach (var pair in target.Substring(i + 1).Split('&')) {
      int e = pair.IndexOf('=');
      if (e > 0) q[Uri.UnescapeDataString(pair.Substring(0, e))] = Uri.UnescapeDataString(pair.Substring(e + 1));
    }
    return q;
  }

  static byte[] Route(string method, string target, byte[] body, ref string type) {
    string path = target.Split('?')[0];
    var q = Query(target);
    if (method == "GET" && path == "/state") return Json(State());
    if (method == "GET" && path == "/frame") { type = "image/jpeg"; return Frame(q); }
    if (method == "POST" && path == "/input") {
      var value = Ser.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
      lock (InputLock) Input(value);
      return Json(new { ok = true });
    }
    throw new ArgumentException("NOT_FOUND");
  }

  static string MonitorName(Screen s) { return s.DeviceName.Replace("\\\\.\\", ""); }

  static object State() {
    POINT p; GetCursorPos(out p);
    var monitors = new List<object>();
    foreach (var s in Screen.AllScreens) {
      var b = s.Bounds;
      monitors.Add(new { name = MonitorName(s), x = b.X, y = b.Y, width = b.Width, height = b.Height, primary = s.Primary, focused = b.Contains(p.X, p.Y) });
    }
    var hwnd = GetForegroundWindow();
    var title = new StringBuilder(512); GetWindowText(hwnd, title, 512);
    var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
    return new { hostname = Environment.MachineName, user = Environment.UserName, monitors = monitors, cursor = new { x = p.X, y = p.Y },
      active = new { address = "0x" + hwnd.ToInt64().ToString("x"), title = title.ToString(), @class = cls.ToString() } };
  }

  static Screen FindScreen(string name) {
    foreach (var s in Screen.AllScreens) if (string.IsNullOrEmpty(name) || MonitorName(s) == name) return s;
    throw new ArgumentException("INVALID_MONITOR");
  }

  static int Int(Dictionary<string, string> q, string key, int fallback) { string v; int n; return q.TryGetValue(key, out v) && int.TryParse(v, out n) ? n : fallback; }

  static ImageCodecInfo jpeg;
  static byte[] Frame(Dictionary<string, string> q) {
    string mon; q.TryGetValue("monitor", out mon);
    var screen = FindScreen(mon);
    var b = screen.Bounds;
    double scale = 0.5; string sv;
    if (q.TryGetValue("scale", out sv)) double.TryParse(sv, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out scale);
    if (scale < 0.1 || scale > 1) throw new ArgumentException("INVALID_SCALE");
    int quality = Math.Max(30, Math.Min(90, Int(q, "q", 65)));
    var src = b;
    if (q.ContainsKey("w")) {
      int x = Int(q, "x", 0), y = Int(q, "y", 0), w = Int(q, "w", b.Width), hh = Int(q, "h", b.Height);
      src = Rectangle.Intersect(b, new Rectangle(b.X + x, b.Y + y, w, hh));
      if (src.Width < 2 || src.Height < 2) throw new ArgumentException("INVALID_REGION");
    }
    int ow = Math.Max(2, (int)Math.Round(src.Width * scale)), oh = Math.Max(2, (int)Math.Round(src.Height * scale));
    using (var full = new Bitmap(src.Width, src.Height, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) {
        try { g.CopyFromScreen(src.X, src.Y, 0, 0, src.Size, CopyPixelOperation.SourceCopy); DrawCursor(g, src.X, src.Y); }
        catch { g.Clear(Color.FromArgb(24, 24, 24)); } // locked screen or UAC prompt: nothing readable
      }
      Bitmap output = full;
      if (ow != src.Width || oh != src.Height) {
        output = new Bitmap(ow, oh, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(output)) { g.InterpolationMode = InterpolationMode.Bilinear; g.PixelOffsetMode = PixelOffsetMode.HighSpeed; g.DrawImage(full, 0, 0, ow, oh); }
      }
      try {
        if (jpeg == null) foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        using (var ms = new MemoryStream()) { output.Save(ms, jpeg, ep); return ms.ToArray(); }
      } finally { if (output != full) output.Dispose(); }
    }
  }

  static void DrawCursor(Graphics g, int ox, int oy) {
    var ci = new CURSORINFO(); ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci) || ci.flags != 1 || ci.hCursor == IntPtr.Zero) return;
    ICONINFO info; int hx = 0, hy = 0;
    if (GetIconInfo(ci.hCursor, out info)) {
      hx = info.xHotspot; hy = info.yHotspot;
      if (info.hbmMask != IntPtr.Zero) DeleteObject(info.hbmMask);
      if (info.hbmColor != IntPtr.Zero) DeleteObject(info.hbmColor);
    }
    var hdc = g.GetHdc();
    try { DrawIconEx(hdc, ci.pt.X - ox - hx, ci.pt.Y - oy - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
    finally { g.ReleaseHdc(hdc); }
  }

  static int Num(Dictionary<string, object> v, string key) {
    object o; if (!v.TryGetValue(key, out o) || o == null) throw new ArgumentException("MISSING_" + key.ToUpper());
    return Convert.ToInt32(o);
  }

  static INPUT Mouse(uint flags, int data) { var i = new INPUT(); i.type = 0; i.mi.dwFlags = flags; i.mi.mouseData = data; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.ki.wVk = vk; i.ki.wScan = scan; i.ki.dwFlags = flags; return i; }
  static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  static readonly HashSet<int> Extended = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x2C };

  static void Input(Dictionary<string, object> v) {
    string op = v.ContainsKey("op") ? Convert.ToString(v["op"]) : "";
    switch (op) {
      case "move": { POINT p; GetCursorPos(out p); SetCursorPos(p.X + Num(v, "dx"), p.Y + Num(v, "dy")); break; }
      case "moveTo": SetCursorPos(Num(v, "x"), Num(v, "y")); break;
      case "button": case "click": {
        string button = Convert.ToString(v["button"]);
        uint down = button == "left" ? 0x2u : button == "right" ? 0x8u : button == "middle" ? 0x20u : 0u;
        if (down == 0) throw new ArgumentException("INVALID_BUTTON");
        if (op == "click") Send(Mouse(down, 0), Mouse(down << 1, 0));
        else Send(Mouse(Convert.ToBoolean(v["down"]) ? down : down << 1, 0));
        break;
      }
      case "wheel": Send(Mouse(0x800, Num(v, "dy") * 120)); break;
      case "text": {
        var list = new List<INPUT>();
        foreach (char c in Convert.ToString(v["text"])) {
          if (c == '\n') { list.Add(Key(0x0D, 0, 0)); list.Add(Key(0x0D, 0, 2)); continue; }
          if (c == '\r') continue;
          list.Add(Key(0, c, 4)); list.Add(Key(0, c, 4 | 2));
        }
        if (list.Count > 0) Send(list.ToArray());
        break;
      }
      case "keys": {
        var vks = (System.Collections.ArrayList)v["vks"];
        if (vks.Count < 1 || vks.Count > 6) throw new ArgumentException("INVALID_KEYS");
        var list = new List<INPUT>();
        foreach (var o in vks) { int k = Convert.ToInt32(o); list.Add(Key((ushort)k, 0, Extended.Contains(k) ? 1u : 0u)); }
        for (int i = vks.Count - 1; i >= 0; i--) { int k = Convert.ToInt32(vks[i]); list.Add(Key((ushort)k, 0, (Extended.Contains(k) ? 1u : 0u) | 2u)); }
        Send(list.ToArray());
        break;
      }
      default: throw new ArgumentException("INVALID_OP");
    }
  }
}
