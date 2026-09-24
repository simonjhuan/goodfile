import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit
import UniformTypeIdentifiers

/// "Share → goodfile" from any app (including Photos): copy the shared items, serve them from
/// the extension itself and show the QR right in the share sheet — no App Group, no app launch.
final class ShareViewController: UIViewController {
    private let isThai = Locale.preferredLanguages.first?.hasPrefix("th") ?? false
    private let workDir = FileManager.default.temporaryDirectory
        .appendingPathComponent("goodfile-share", isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    private var server: ShareFileServer?

    private let spinner = UIActivityIndicatorView(style: .large)
    private let statusLabel = UILabel()
    private let fileLabel = UILabel()
    private let qrContainer = UIView()
    private let qrView = UIImageView()
    private let hintLabel = UILabel()
    private let progressView = UIProgressView(progressViewStyle: .default)
    private let progressLabel = UILabel()

    private func tr(_ en: String, _ th: String) -> String { isThai ? th : en }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Only one share runs at a time; drop copies left by a sheet that was swiped away.
        try? FileManager.default.removeItem(at: workDir.deletingLastPathComponent())
        buildUI()
        status(tr("Preparing…", "กำลังเตรียมไฟล์…"))
        collectFiles { [weak self] files in
            self?.prepare(files)
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        server?.stop()
    }

    // MARK: - UI

    private func buildUI() {
        view.backgroundColor = .systemBackground

        let title = UILabel()
        title.text = "goodfile"
        title.font = .systemFont(ofSize: 20, weight: .bold)
        let done = UIButton(type: .system)
        done.setTitle(tr("Done", "เสร็จ"), for: .normal)
        done.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        done.addTarget(self, action: #selector(finish), for: .touchUpInside)
        let header = UIStackView(arrangedSubviews: [title, UIView(), done])
        header.alignment = .center

        for label in [statusLabel, fileLabel, hintLabel, progressLabel] {
            label.numberOfLines = 0
            label.textAlignment = .center
        }
        statusLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        fileLabel.font = .systemFont(ofSize: 14)
        fileLabel.textColor = .secondaryLabel
        hintLabel.font = .systemFont(ofSize: 14)
        hintLabel.textColor = .secondaryLabel
        progressLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        progressLabel.textColor = .secondaryLabel

        // The QR is always black on white (with a quiet zone) so scanners read it in dark mode too.
        qrContainer.backgroundColor = .white
        qrContainer.layer.cornerRadius = 16
        qrView.contentMode = .scaleAspectFit
        qrView.layer.magnificationFilter = .nearest
        qrView.translatesAutoresizingMaskIntoConstraints = false
        qrContainer.addSubview(qrView)
        qrContainer.isHidden = true
        progressView.isHidden = true
        hintLabel.isHidden = true
        spinner.startAnimating()

        let body = UIStackView(arrangedSubviews: [spinner, statusLabel, fileLabel, qrContainer, hintLabel, progressView, progressLabel])
        body.axis = .vertical
        body.alignment = .center
        body.spacing = 14

        let root = UIStackView(arrangedSubviews: [header, body, UIView()])
        root.axis = .vertical
        root.spacing = 24
        root.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(root)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            root.topAnchor.constraint(equalTo: guide.topAnchor, constant: 16),
            root.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 20),
            root.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -20),
            root.bottomAnchor.constraint(lessThanOrEqualTo: guide.bottomAnchor, constant: -16),
            qrContainer.widthAnchor.constraint(equalToConstant: 260),
            qrContainer.heightAnchor.constraint(equalToConstant: 260),
            qrView.topAnchor.constraint(equalTo: qrContainer.topAnchor, constant: 18),
            qrView.leadingAnchor.constraint(equalTo: qrContainer.leadingAnchor, constant: 18),
            qrView.trailingAnchor.constraint(equalTo: qrContainer.trailingAnchor, constant: -18),
            qrView.bottomAnchor.constraint(equalTo: qrContainer.bottomAnchor, constant: -18),
            progressView.widthAnchor.constraint(equalTo: body.widthAnchor),
            statusLabel.widthAnchor.constraint(equalTo: body.widthAnchor),
            fileLabel.widthAnchor.constraint(equalTo: body.widthAnchor),
            hintLabel.widthAnchor.constraint(equalTo: body.widthAnchor),
        ])
    }

    private func status(_ text: String) {
        statusLabel.text = text
    }

    private func fail(_ text: String) {
        spinner.stopAnimating()
        spinner.isHidden = true
        status(text)
    }

    @objc private func finish() {
        server?.stop()
        server = nil
        try? FileManager.default.removeItem(at: workDir)
        extensionContext?.completeRequest(returningItems: nil)
    }

    // MARK: - Collect shared items

    private func collectFiles(_ completion: @escaping ([URL]) -> Void) {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        let inbox = workDir.appendingPathComponent("items", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)

        var results = [URL?](repeating: nil, count: providers.count)
        let lock = NSLock()
        let group = DispatchGroup()
        for (index, provider) in providers.enumerated() {
            group.enter()
            load(provider, into: inbox) { url in
                lock.lock()
                results[index] = url
                lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .main) {
            completion(results.compactMap { $0 })
        }
    }

    private func load(_ provider: NSItemProvider, into dir: URL, completion: @escaping (URL?) -> Void) {
        let types = provider.registeredTypeIdentifiers
        // Real files first (photos, videos, documents); a bare web link or text selection last.
        let fileType = types.first { id in
            guard let type = UTType(id) else { return false }
            return type.conforms(to: .data) && !type.conforms(to: .url) && !type.conforms(to: .text)
        }
        if let fileType {
            provider.loadFileRepresentation(forTypeIdentifier: fileType) { [weak self] url, _ in
                guard let self else { return completion(nil) }
                if let url, let saved = self.adopt(url, suggestedName: provider.suggestedName, type: fileType, into: dir) {
                    completion(saved)
                } else {
                    self.loadItem(provider, type: fileType, into: dir, completion: completion)
                }
            }
            return
        }
        let fallback = types.first { UTType($0)?.conforms(to: .url) == true }
            ?? types.first { UTType($0)?.conforms(to: .text) == true }
            ?? types.first
        guard let fallback else { return completion(nil) }
        loadItem(provider, type: fallback, into: dir, completion: completion)
    }

    private func loadItem(_ provider: NSItemProvider, type: String, into dir: URL, completion: @escaping (URL?) -> Void) {
        provider.loadItem(forTypeIdentifier: type, options: nil) { [weak self] item, _ in
            guard let self else { return completion(nil) }
            let name = Self.fileName(provider.suggestedName ?? "file", type: type)
            switch item {
            case let url as URL where url.isFileURL:
                completion(self.adopt(url, suggestedName: provider.suggestedName, type: type, into: dir))
            case let url as URL:
                completion(self.write(Data(url.absoluteString.utf8), name: "link.txt", into: dir))
            case let data as Data:
                completion(self.write(data, name: name, into: dir))
            case let text as String:
                completion(self.write(Data(text.utf8), name: "shared-text.txt", into: dir))
            case let image as UIImage:
                completion(image.pngData().flatMap { self.write($0, name: Self.fileName(provider.suggestedName ?? "image", type: UTType.png.identifier), into: dir) })
            default:
                completion(nil)
            }
        }
    }

    /// Copy a provider's file (only valid inside its callback) into our work dir.
    private func adopt(_ url: URL, suggestedName: String?, type: String, into dir: URL) -> URL? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        var name = url.lastPathComponent
        if url.pathExtension.isEmpty {
            name = Self.fileName(suggestedName ?? url.lastPathComponent, type: type)
        }
        let dest = uniqueURL(in: dir, name: name)
        do {
            try FileManager.default.copyItem(at: url, to: dest)
            return dest
        } catch {
            return nil
        }
    }

    /// Adds the type's extension unless the name already has one.
    private static func fileName(_ base: String, type: String) -> String {
        guard (base as NSString).pathExtension.isEmpty else { return base }
        return "\(base).\(UTType(type)?.preferredFilenameExtension ?? "bin")"
    }

    private func write(_ data: Data, name: String, into dir: URL) -> URL? {
        let dest = uniqueURL(in: dir, name: name)
        return (try? data.write(to: dest)) != nil ? dest : nil
    }

    private let nameLock = NSLock()
    private var reservedNames = Set<String>()

    /// "IMG_1.HEIC" → "IMG_1 (2).HEIC" when several shared items carry the same name.
    /// Items load concurrently, so names are reserved under a lock before any copy lands.
    private func uniqueURL(in dir: URL, name: String) -> URL {
        nameLock.lock()
        defer { nameLock.unlock() }
        let safe = name.replacingOccurrences(of: "/", with: "_")
        let stem = (safe as NSString).deletingPathExtension
        let ext = (safe as NSString).pathExtension
        var candidate = safe
        var n = 2
        while reservedNames.contains(candidate.lowercased()) {
            candidate = ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)"
            n += 1
        }
        reservedNames.insert(candidate.lowercased())
        return dir.appendingPathComponent(candidate)
    }

    // MARK: - Serve

    private func prepare(_ files: [URL]) {
        guard !files.isEmpty else {
            fail(tr("Couldn't read the shared item.", "อ่านไฟล์ที่แชร์มาไม่ได้"))
            return
        }
        if files.count == 1 {
            serve(files[0], label: files[0].lastPathComponent)
            return
        }
        status(tr("Zipping \(files.count) files…", "กำลังรวม \(files.count) ไฟล์…"))
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let zip = self.zip(files)
            DispatchQueue.main.async {
                if let zip {
                    self.serve(zip, label: self.tr("\(files.count) files", "\(files.count) ไฟล์") + " · " + zip.lastPathComponent)
                } else {
                    self.fail(self.tr("Couldn't zip the files.", "รวมไฟล์ไม่ได้"))
                }
            }
        }
    }

    /// NSFileCoordinator's .forUploading turns a directory into a zip, no zip library needed.
    private func zip(_ files: [URL]) -> URL? {
        let stamp = ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withFullDate])
        let folder = workDir.appendingPathComponent("goodfile-\(stamp)", isDirectory: true)
        let dest = workDir.appendingPathComponent("goodfile-\(stamp).zip")
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            for file in files {
                try fm.moveItem(at: file, to: folder.appendingPathComponent(file.lastPathComponent))
            }
        } catch {
            return nil
        }
        var coordinatorError: NSError?
        var copied = false
        NSFileCoordinator().coordinate(readingItemAt: folder, options: [.forUploading], error: &coordinatorError) { zipURL in
            copied = (try? fm.copyItem(at: zipURL, to: dest)) != nil
        }
        return coordinatorError == nil && copied ? dest : nil
    }

    private func serve(_ file: URL, label: String) {
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let server = ShareFileServer(fileURL: file, fileName: file.lastPathComponent, mimeType: mime)
        self.server = server
        fileLabel.text = label
        status(tr("Starting…", "กำลังเริ่ม…"))
        server.onProgress = { [weak self] sent, total in
            self?.showProgress(sent: sent, total: total)
        }
        server.start { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let url):
                self.showQR(for: url)
            case .failure(let error as ShareError) where error == .noWiFi:
                self.fail(self.tr("Connect to Wi-Fi (or turn on Personal Hotspot) and share again.",
                                  "เชื่อมต่อ Wi-Fi (หรือเปิดฮอตสปอต) แล้วแชร์ใหม่อีกครั้ง"))
            case .failure:
                self.fail(self.tr("Couldn't start sending. Please try again.", "เริ่มส่งไม่ได้ ลองใหม่อีกครั้ง"))
            }
        }
    }

    private func showQR(for url: URL) {
        spinner.stopAnimating()
        spinner.isHidden = true
        qrView.image = qrImage(url.absoluteString)
        qrContainer.isHidden = false
        hintLabel.isHidden = false
        status(tr("Scan to receive", "สแกนเพื่อรับไฟล์"))
        hintLabel.text = tr("Use the goodfile app or the camera on the other device (same Wi-Fi). Keep this screen open until it finishes.",
                            "ใช้แอป goodfile หรือกล้องของอีกเครื่อง (Wi-Fi เดียวกัน) เปิดหน้านี้ค้างไว้จนส่งเสร็จ")
    }

    private func showProgress(sent: UInt64, total: UInt64) {
        guard total > 0 else { return }
        progressView.isHidden = false
        progressView.progress = Float(Double(sent) / Double(total))
        let formatter = ByteCountFormatter()
        progressLabel.text = "\(formatter.string(fromByteCount: Int64(sent))) / \(formatter.string(fromByteCount: Int64(total)))"
        if sent >= total {
            status(tr("✓ Sent", "✓ ส่งสำเร็จ"))
        }
    }

    private func qrImage(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
