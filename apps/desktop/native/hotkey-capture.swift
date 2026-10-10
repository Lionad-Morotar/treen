// Treen 热键 capture 助手：以 CoreGraphics 事件 tap 在系统派发之前吞掉已注册键位。
//
// Electron globalShortcut 只保证「无键盘焦点也能收到按键」，macOS 侧不吞事件——按键照旧
// 派发给前台应用（VS Code 的同键位快捷键会被一并触发）。要吞键必须下沉到 CGEvent tap：
// 回调返回 nil 时事件在 headInsert 位置被吃掉，永不到达前台应用。过滤型 tap 需要
// 「输入监控」授权（ListenEvent access），未授权时 tapCreate 返回 nil，本助手以
// TAP-ERROR 报告并退出，由 TS 桥接层回退到 globalShortcut。
//
// 协议（全部按行，stdout 每写一行即 flush）：
//   stdout: READY                      tap 建好、键表就位，可以工作
//           HIT <accel>                某键位命中且已吞掉，accel 为注册时的原串
//           TAP-REBUILT                tap 被系统禁用后已重新启用
//           TAP-ERROR <reason>         tap 无法建立（permission-denied 等），随后 exit 1
//           PERMISSION ok|denied       仅 --probe 模式：只查询授权态，不建 tap
//   stdin:  {"op":"set","hotkeys":[...]}   整表替换键位（热更新，不重启进程）
//
// 键位条目：{"accel":"CommandOrControl+Shift+X","mods":{"cmd":true,"shift":true,
//           "ctrl":false,"opt":false},"key":"x"}
//
// 命中判定用「修饰键 flags + 事件的 unicode 字符」，不用 keyCode：keyCode 依赖键盘布局，
// Electron globalShortcut 在非 QWERTY 布局下失效正是这个原因。字符取
// charactersIgnoringModifiers（Shift 按下时 characters 会变大写），两侧统一小写比较。

import CoreGraphics
import Foundation

struct HotkeyEntry {
    let accel: String
    let cmd: Bool
    let shift: Bool
    let ctrl: Bool
    let opt: Bool
    let key: String
}

var hotkeys: [HotkeyEntry] = []
var eventTap: CFMachPort?

func emit(_ line: String) {
    fputs(line + "\n", stdout)
    fflush(stdout)
}

func parseHotkeys(_ payload: [[String: Any]]) -> [HotkeyEntry] {
    payload.compactMap { item in
        guard let accel = item["accel"] as? String,
              let key = item["key"] as? String else { return nil }
        let mods = item["mods"] as? [String: Any] ?? [:]
        func flag(_ name: String) -> Bool { mods[name] as? Bool ?? false }
        return HotkeyEntry(
            accel: accel,
            cmd: flag("cmd"), shift: flag("shift"),
            ctrl: flag("ctrl"), opt: flag("opt"),
            key: key.lowercased()
        )
    }
}

// stdin 按行读取放后台队列：runloop 被 CFRunLoopRun 独占，主线程无法再起 source。
// set 语义是整表替换——注册侧每次都是全量键表，增量协议只会引入「漏删」类失同步。
func listenStdin() {
    let queue = DispatchQueue(label: "hotkey-capture.stdin")
    queue.async {
        let input = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                let lineData = buffer.subdata(in: buffer.startIndex..<newline)
                buffer.removeSubrange(buffer.startIndex...newline)
                guard let line = String(data: lineData, encoding: .utf8),
                      let data = line.data(using: .utf8),
                      let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      message["op"] as? String == "set",
                      let payload = message["hotkeys"] as? [[String: Any]] else { continue }
                hotkeys = parseHotkeys(payload)
            }
        }
        // stdin 关闭即宿主要收掉助手：主动退出，不留孤儿进程等宿主 kill。
        exit(0)
    }
}

func tapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    // 系统判定 tap 响应超时会把它禁掉：重新启用并报告，吞键能力不能静默消失。
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: true)
            emit("TAP-REBUILT")
        }
        return Unmanaged.passRetained(event)
    }
    guard type == .keyDown else {
        return Unmanaged.passRetained(event)
    }
    // flags 的非修饰位（如 non-coalesced 标记）不参与 contains 判定，无需先掩码。
    let flags = event.flags
    let wantCmd = flags.contains(.maskCommand)
    let wantShift = flags.contains(.maskShift)
    let wantCtrl = flags.contains(.maskControl)
    let wantOpt = flags.contains(.maskAlternate)
    // CGEvent 无 NSEvent 的 charactersIgnoringModifiers：直接取事件的 unicode 串，
    // Shift 变换出的大写字符由 lowercased 抹平；keypad/功能键/死键可能给空串，空即不匹配。
    var chars = [UniChar](repeating: 0, count: 4)
    var length = 0
    event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &length, unicodeString: &chars)
    guard length > 0 else {
        return Unmanaged.passRetained(event)
    }
    let key = String(utf16CodeUnits: chars, count: length).lowercased()
    for entry in hotkeys where entry.key == key
        && entry.cmd == wantCmd && entry.shift == wantShift
        && entry.ctrl == wantCtrl && entry.opt == wantOpt {
        emit("HIT \(entry.accel)")
        // 返回 nil：事件在 headInsert 位置被吞，前台应用收不到这次按键。
        return nil
    }
    return Unmanaged.passRetained(event)
}

// --probe 只查询授权态（CGPreflight 不弹系统弹窗），供桥接层在装配前探测；
// 请求授权必须由用户在系统设置里完成，自动化环境里绝不能触发弹窗。
let args = CommandLine.arguments
if args.contains("--probe") {
    emit("PERMISSION \(CGPreflightListenEventAccess() ? "ok" : "denied")")
    exit(0)
}

let hotkeyArg = args.firstIndex(of: "--hotkeys").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
if let json = hotkeyArg, let data = json.data(using: .utf8),
   let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
   let payload = message["hotkeys"] as? [[String: Any]] {
    hotkeys = parseHotkeys(payload)
}

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
    callback: tapCallback,
    userInfo: nil
) else {
    emit("TAP-ERROR permission-denied")
    exit(1)
}
eventTap = tap

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
listenStdin()
emit("READY")
CFRunLoopRun()
