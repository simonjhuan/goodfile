import Capacitor
import Foundation

@objc(DownloaderPlugin)
final class DownloaderPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDownloadDelegate {
    let identifier = "Downloader"
    let jsName = "Downloader"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "downloadFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise)
    ]

    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private var task: URLSessionDownloadTask?
    private var activeCall: CAPPluginCall?
    private var activeName = "goodfile_download"
    private var resumeData: Data?
    private var startedAt = Date()
    private var resumedBytes: Int64 = 0

    @objc func downloadFile(_ call: CAPPluginCall) { begin(call, resume: false) }
    @objc func resumeDownload(_ call: CAPPluginCall) { begin(call, resume: true) }

    @objc func cancelDownload(_ call: CAPPluginCall) {
        task?.cancel { [weak self] data in self?.resumeData = data }
        task = nil
        notifyListeners("downloadCancelled", data: [:])
        activeCall?.reject("cancelled")
        activeCall = nil
        call.resolve(["cancelled": true])
    }

    private func begin(_ call: CAPPluginCall, resume: Bool) {
        guard task == nil else { call.reject("A download is already running"); return }
        activeName = safeName(call.getString("fileName") ?? "goodfile_download")
        activeCall = call
        startedAt = Date()
        resumedBytes = 0
        if resume, let data = resumeData {
            task = session.downloadTask(withResumeData: data)
        } else {
            guard let value = call.getString("url"), let url = URL(string: value) else {
                activeCall = nil; call.reject("Missing URL"); return
            }
            resumeData = nil
            task = session.downloadTask(with: url)
        }
        notifyListeners("downloadStarted", data: ["fileName": activeName, "resumedBytes": resumedBytes])
        task?.resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        let total = totalBytesExpectedToWrite
        let elapsed = max(0.001, Date().timeIntervalSince(startedAt))
        let speed = Int64(Double(max(0, totalBytesWritten - resumedBytes)) / elapsed)
        let progress = total > 0 ? min(100, Int(totalBytesWritten * 100 / total)) : -1
        let eta = total > 0 && speed > 0 ? max(0, (total - totalBytesWritten) / speed) : -1
        notifyListeners("downloadProgress", data: [
            "progress": progress, "bytes": totalBytesWritten, "total": total,
            "speed": speed, "eta": eta
        ])
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        do {
            let folder = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                                                      appropriateFor: nil, create: true)
                .appendingPathComponent("GoodFile", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let responseName = downloadTask.response?.suggestedFilename ?? activeName
            let destination = uniqueURL(in: folder, name: safeName(responseName))
            try FileManager.default.moveItem(at: location, to: destination)
            let size = ((try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            let result: [String: Any] = [
                "message": "โหลดสำเร็จ", "fileName": destination.lastPathComponent,
                "path": destination.path, "uri": destination.absoluteString, "size": size
            ]
            notifyListeners("downloadComplete", data: result)
            activeCall?.resolve(result)
            resumeData = nil
        } catch {
            notifyListeners("downloadError", data: ["error": error.localizedDescription, "resumable": false])
            activeCall?.reject("Save failed: \(error.localizedDescription)")
        }
        activeCall = nil
        task = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        guard let error else { return }
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }
        if let data = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data { resumeData = data }
        notifyListeners("downloadError", data: [
            "error": error.localizedDescription,
            "resumable": resumeData != nil
        ])
        activeCall?.reject("Download failed: \(error.localizedDescription)")
        activeCall = nil
        self.task = nil
    }

    private func safeName(_ value: String) -> String {
        let invalid = CharacterSet(charactersIn: "\\/:*?\"<>|")
        let name = value.components(separatedBy: invalid).joined(separator: "_")
        return name.isEmpty ? "goodfile_download" : name
    }

    private func uniqueURL(in folder: URL, name: String) -> URL {
        var candidate = folder.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: candidate.path) else { return candidate }
        let ext = candidate.pathExtension
        let base = candidate.deletingPathExtension().lastPathComponent
        var index = 1
        repeat {
            let next = ext.isEmpty ? "\(base)_\(index)" : "\(base)_\(index).\(ext)"
            candidate = folder.appendingPathComponent(next); index += 1
        } while FileManager.default.fileExists(atPath: candidate.path)
        return candidate
    }
}
