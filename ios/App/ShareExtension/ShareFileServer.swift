import Darwin
import Foundation
import Network
import Security

/// Serves one file from inside the share extension, using the same URL contract as the app's
/// FileServerPlugin (`http://<ip>:<port>/download?t=<token>`), so every existing receiver —
/// the goodfile app's scanner, Android, a PC browser, the iPhone camera — works unchanged.
final class ShareFileServer {
    /// Bytes sent to the furthest-along receiver, and the file size. Called on the main queue.
    var onProgress: ((UInt64, UInt64) -> Void)?

    let token: String
    private let fileURL: URL
    private let fileName: String
    private let mimeType: String
    private let fileSize: UInt64
    private let queue = DispatchQueue(label: "com.goodfile.share.server")
    private var listener: NWListener?
    private var bestSent: UInt64 = 0

    init(fileURL: URL, fileName: String, mimeType: String) {
        self.fileURL = fileURL
        self.fileName = fileName
        self.mimeType = mimeType
        self.fileSize = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.uint64Value ?? 0
        self.token = Self.makeToken()
    }

    /// Starts listening on 8080, or the next free port if the app's own server still holds it.
    func start(port: UInt16 = 8080, attemptsLeft: Int = 10, completion: @escaping (Result<URL, Error>) -> Void) {
        guard let ip = Self.localIPv4Address() else {
            DispatchQueue.main.async { completion(.failure(ShareError.noWiFi)) }
            return
        }
        guard let nwPort = NWEndpoint.Port(rawValue: port), let listener = try? NWListener(using: .tcp, on: nwPort) else {
            retry(port: port, attemptsLeft: attemptsLeft, completion: completion)
            return
        }
        self.listener = listener
        var finished = false
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self, !finished else { return }
            switch state {
            case .ready:
                finished = true
                let url = URL(string: "http://\(ip):\(port)/download?t=\(self.token)")!
                DispatchQueue.main.async { completion(.success(url)) }
            case .failed:
                finished = true
                listener?.cancel()
                self.retry(port: port, attemptsLeft: attemptsLeft, completion: completion)
            default:
                break
            }
        }
        listener.start(queue: queue)
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func retry(port: UInt16, attemptsLeft: Int, completion: @escaping (Result<URL, Error>) -> Void) {
        guard attemptsLeft > 1 else {
            DispatchQueue.main.async { completion(.failure(ShareError.noPort)) }
            return
        }
        queue.async { self.start(port: port + 1, attemptsLeft: attemptsLeft - 1, completion: completion) }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }
            self.queue.async { self.respond(to: request, on: connection) }
        }
    }

    private func respond(to request: String, on connection: NWConnection) {
        guard let firstLine = request.components(separatedBy: "\r\n").first,
              firstLine.hasPrefix("GET "),
              let target = firstLine.split(separator: " ").dropFirst().first,
              let components = URLComponents(string: "http://goodfile.local\(target)") else {
            send(status: "400 Bad Request", on: connection)
            return
        }
        // Reveals no file metadata; only confirms the sender is reachable.
        if components.path == "/api/ping" {
            send(status: "200 OK", on: connection)
            return
        }
        guard components.path == "/download" else {
            send(status: "404 Not Found", on: connection)
            return
        }
        guard components.queryItems?.first(where: { $0.name == "t" })?.value == token else {
            send(status: "401 Unauthorized", on: connection)
            return
        }
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else {
            send(status: "404 Not Found", on: connection)
            return
        }
        let safeName = fileName.replacingOccurrences(of: "\"", with: "_")
        let encodedName = fileName.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? safeName
        let header = "HTTP/1.1 200 OK\r\nContent-Type: \(mimeType)\r\nContent-Length: \(fileSize)\r\n"
            + "Content-Disposition: attachment; filename=\"\(safeName)\"; filename*=UTF-8''\(encodedName)\r\n"
            + "Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8), completion: .contentProcessed { [weak self] error in
            guard error == nil, let self else {
                handle.closeFile()
                connection.cancel()
                return
            }
            self.sendNextChunk(from: handle, sent: 0, on: connection)
        })
    }

    private func sendNextChunk(from handle: FileHandle, sent: UInt64, on connection: NWConnection) {
        let chunk = handle.readData(ofLength: 256 * 1024)
        guard !chunk.isEmpty else {
            handle.closeFile()
            connection.cancel()
            return
        }
        connection.send(content: chunk, completion: .contentProcessed { [weak self] error in
            guard error == nil, let self else {
                handle.closeFile()
                connection.cancel()
                return
            }
            let total = sent + UInt64(chunk.count)
            self.report(total)
            self.queue.async { self.sendNextChunk(from: handle, sent: total, on: connection) }
        })
    }

    private func report(_ sent: UInt64) {
        guard sent > bestSent else { return }
        bestSent = sent
        let size = fileSize
        DispatchQueue.main.async { [weak self] in self?.onProgress?(sent, size) }
    }

    private func send(status: String, on connection: NWConnection) {
        let header = "HTTP/1.1 \(status)\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func makeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Wi-Fi (en0) first, then the Personal Hotspot bridge, then any other non-cellular IPv4.
    static func localIPv4Address() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return nil }
        defer { freeifaddrs(interfaces) }

        var found: [String: String] = [:]
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = cursor {
            defer { cursor = interface.pointee.ifa_next }
            guard let address = interface.pointee.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET),
                  (interface.pointee.ifa_flags & UInt32(IFF_UP | IFF_RUNNING)) == UInt32(IFF_UP | IFF_RUNNING) else { continue }
            let name = String(cString: interface.pointee.ifa_name)
            guard name != "lo0", !name.hasPrefix("pdp_ip") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: host)
                if ip != "127.0.0.1", !ip.hasPrefix("169.254.") { found[name] = ip }
            }
        }
        if let wifi = found["en0"] { return wifi }
        if let bridge = found.first(where: { $0.key.hasPrefix("bridge") })?.value { return bridge }
        return found.values.first
    }
}

enum ShareError: Error {
    case noWiFi
    case noPort
    case nothingToSend
}
