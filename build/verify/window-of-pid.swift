// Used by scripts/dist.mjs to prove the packaged app put a real native window on screen.
// Prints JSON {"id":…, "x":…, "y":…, "width":…, "height":…, "owner":"…"} for the largest on-screen normal window of <pid>,
// or nothing. Reading the window list needs no permission; capturing its pixels (screencapture -l) needs Screen Recording.
import Foundation
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
var best: [String: Any]? = nil
var bestArea = 40000.0
for w in list where (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let num = { (k: String) in (b[k] as? NSNumber)?.doubleValue ?? 0 }
  if num("Width") * num("Height") > bestArea, let id = (w[kCGWindowNumber as String] as? NSNumber)?.intValue {
    bestArea = num("Width") * num("Height")
    best = ["id": id, "x": num("X"), "y": num("Y"), "width": num("Width"), "height": num("Height"),
            "owner": w[kCGWindowOwnerName as String] as? String ?? ""]
  }
}
if let b = best, let data = try? JSONSerialization.data(withJSONObject: b), let s = String(data: data, encoding: .utf8) { print(s) }
