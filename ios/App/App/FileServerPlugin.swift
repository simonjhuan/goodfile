import Capacitor
import Darwin
import Foundation
import Network

@objc(FileServerPlugin)
final class FileServerPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "FileServer"
    let jsName = "FileServer"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getIP", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startServer", returnType: CAPPluginReturnPromise)
    ]

    private let serverQueue = DispatchQueue(label: "com.goodfile.fileserver")
    private var listener: NWListener?
    private var hostedFile: URL?
    private var hostedName = "goodfile_download"
    private var hostedMimeType = "application/octet-stream"
    private var accessToken = ""

    @objc func getIP(_ call: CAPPluginCall) {
        guard let ip = Self.localIPv4Address() else {
            call.reject("No Wi-Fi IP address is available")
            return
        }
        call.resolve(["ip": ip])
    }

    @objc func startServer(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("Missing file URI")
            return
        }
        guard let fileURL = Self.fileURL(from: uri), FileManager.default.fileExists(atPath: fileURL.path) else {
            call.reject("The selected file is not available")
            return
        }
        guard let ip = Self.localIPv4Address() else {
            call.reject("No Wi-Fi IP address is available")
            return
        }

        let portNumber = call.getInt("port") ?? 8080
        guard let port = NWEndpoint.Port(rawValue: UInt16(portNumber)) else {
            call.reject("Invalid server port")
            return
        }

        serverQueue.async { [weak self] in
            guard let self else { return }
            self.listener?.cancel()
            self.hostedFile = fileURL
            self.hostedName = call.getString("fileName") ?? fileURL.lastPathComponent
            self.hostedMimeType = call.getString("mimeType") ?? "application/octet-stream"
            self.accessToken = call.getString("token") ?? ""

            do {
                let listener = try NWListener(using: .tcp, on: port)
                self.listener = listener
                listener.newConnectionHandler = { [weak self] connection in
                    self?.handle(connection)
                }
                listener.stateUpdateHandler = { [weak self] state in
                    switch state {
                    case .ready:
                        let encodedToken = self?.accessToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
                        call.resolve([
                            "ip": ip,
                            "token": self?.accessToken ?? "",
                            "url": "http://\(ip):\(portNumber)/download?t=\(encodedToken)"
                        ])
                    case .failed(let error):
                        call.reject("Server error: \(error.localizedDescription)")
                    default:
                        break
                    }
                }
                listener.start(queue: self.serverQueue)
            } catch {
                call.reject("Server error: \(error.localizedDescription)")
            }
        }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: serverQueue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }
            self.serverQueue.async {
                self.respond(to: request, on: connection)
            }
        }
    }

    private func respond(to request: String, on connection: NWConnection) {
        guard let firstLine = request.components(separatedBy: "\r\n").first,
              firstLine.hasPrefix("GET "),
              let target = firstLine.split(separator: " ").dropFirst().first,
              let components = URLComponents(string: "http://goodfile.local\(target)") else {
            send(status: "400 Bad Request", body: Data(), on: connection)
            return
        }

        guard components.path == "/download" else {
            send(status: "404 Not Found", body: Data(), on: connection)
            return
        }
        guard accessToken.isEmpty || components.queryItems?.first(where: { $0.name == "t" })?.value == accessToken else {
            send(status: "401 Unauthorized", body: Data(), on: connection)
            return
        }
        guard let fileURL = hostedFile, FileManager.default.fileExists(atPath: fileURL.path) else {
            send(status: "404 Not Found", body: Data(), on: connection)
            return
        }

        let fileSize = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.uint64Value ?? 0
        let safeName = hostedName.replacingOccurrences(of: "\"", with: "_")
        let header = "HTTP/1.1 200 OK\r\nContent-Type: \(hostedMimeType)\r\nContent-Length: \(fileSize)\r\nContent-Disposition: attachment; filename=\"\(safeName)\"\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8), completion: .contentProcessed { [weak self] error in
            guard error == nil, let handle = try? FileHandle(forReadingFrom: fileURL) else {
                connection.cancel()
                return
            }
            self?.sendNextChunk(from: handle, on: connection)
        })
    }

    private func sendNextChunk(from handle: FileHandle, on connection: NWConnection) {
        let chunk = handle.readData(ofLength: 64 * 1024)
        guard !chunk.isEmpty else {
            handle.closeFile()
            connection.cancel()
            return
        }
        connection.send(content: chunk, completion: .contentProcessed { [weak self] error in
            guard error == nil else {
                handle.closeFile()
                connection.cancel()
                return
            }
            self?.serverQueue.async {
                self?.sendNextChunk(from: handle, on: connection)
            }
        })
    }

    private func send(status: String, body: Data, on connection: NWConnection) {
        let header = "HTTP/1.1 \(status)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func fileURL(from value: String) -> URL? {
        if let url = URL(string: value), url.isFileURL { return url }
        return value.hasPrefix("/") ? URL(fileURLWithPath: value) : nil
    }

    private static func localIPv4Address() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return nil }
        defer { freeifaddrs(interfaces) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = cursor {
            defer { cursor = interface.pointee.ifa_next }
            guard let address = interface.pointee.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET),
                  (interface.pointee.ifa_flags & UInt32(IFF_UP | IFF_RUNNING)) == UInt32(IFF_UP | IFF_RUNNING) else { continue }
            let name = String(cString: interface.pointee.ifa_name)
            guard name != "lo0" else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            if result == 0 {
                let ip = String(cString: host)
                if ip != "127.0.0.1" { return ip }
            }
        }
        return nil
    }
}
