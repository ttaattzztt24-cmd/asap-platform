// Prints, as JSON, the audio input devices on this Mac and which processes are
// currently recording from which device. The recorder uses this to follow the
// microphone that Zoom / the browser running Google Meet is actually using.
//
// {
//   "devices":   [{ "id", "name", "uid", "isDefault", "running", "virtual" }],
//   "processes": [{ "pid", "path", "devices": [id] }]   // macOS 14+ only
// }
import CoreAudio
import Darwin
import Foundation

let system = AudioObjectID(kAudioObjectSystemObject)

func address(_ selector: AudioObjectPropertySelector,
             _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: 0)
}

func uint32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector,
            _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> UInt32? {
  var addr = address(selector, scope)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func int32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Int32? {
  var addr = address(selector)
  var value: Int32 = 0
  var size = UInt32(MemoryLayout<Int32>.size)
  return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func objectList(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector,
                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
  var addr = address(selector, scope)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  let count = Int(size) / MemoryLayout<AudioObjectID>.size
  var list = [AudioObjectID](repeating: 0, count: count)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &list) == noErr else { return [] }
  return Array(list.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
}

func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
  var addr = address(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let cf = value else { return "" }
  return cf.takeRetainedValue() as String
}

func processPath(_ pid: Int32) -> String {
  var buffer = [CChar](repeating: 0, count: 4096)
  let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
  return length > 0 ? String(cString: buffer) : ""
}

let defaultInput = uint32(system, kAudioHardwarePropertyDefaultInputDevice) ?? 0
let virtualTypes: Set<UInt32> = [kAudioDeviceTransportTypeVirtual, kAudioDeviceTransportTypeAggregate]

var devices: [[String: Any]] = []
for id in objectList(system, kAudioHardwarePropertyDevices) {
  // Input devices only.
  if objectList(id, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput).isEmpty { continue }
  devices.append([
    "id": Int(id),
    "name": string(id, kAudioObjectPropertyName),
    "uid": string(id, kAudioDevicePropertyDeviceUID),
    "isDefault": id == defaultInput,
    "running": (uint32(id, kAudioDevicePropertyDeviceIsRunningSomewhere) ?? 0) != 0,
    "virtual": virtualTypes.contains(uint32(id, kAudioDevicePropertyTransportType) ?? 0),
  ])
}

var processes: [[String: Any]] = []
if #available(macOS 14.0, *) {
  for process in objectList(system, kAudioHardwarePropertyProcessObjectList) {
    guard (uint32(process, kAudioProcessPropertyIsRunningInput) ?? 0) != 0,
          let pid = int32(process, kAudioProcessPropertyPID) else { continue }
    let inputs = objectList(process, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput)
    processes.append([
      "pid": Int(pid),
      "path": processPath(pid),
      "devices": inputs.map { Int($0) },
    ])
  }
}

let output: [String: Any] = ["devices": devices, "processes": processes]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
